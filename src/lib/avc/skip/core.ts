/**
 * Skip Segments — ядро (спецификация «Пропуск опенинга/эндинга/рекапы»).
 *
 * Слои: источники таймкодов (провайдеры) → валидация/слияние (SkipResolver)
 * → потребитель (player.tsx: кнопка + автопропуск; executor: голосовые интенты).
 *
 * Приоритет источников: P3 (пользовательские отметки) > P1 (тайминги сайта,
 * уже приходят в video.skips) > P2 (Aniskip) > fallback-слайдеры. Близкие
 * границы (±2 с) из разных источников считаются подтверждением и повышают
 * confidence — автопропуск безопаснее.
 *
 * PlayerAgent ВНУТРИ кросс-доменного iframe (kodik/aksor) невозможен: хост не
 * может инъектировать скрипт в чужой iframe. Но fullscreen в приложении СВОЙ
 * (fixed inset-0 поверх UI), поэтому кнопка пропуска живёт в панели плеера и
 * видна в fullscreen — требование «кнопка работает на диване» выполняется.
 */
import type { VideoSkips } from '@/lib/avc/types'

/** Тип сегмента */
export type SkipSegmentType = 'op' | 'ed' | 'recap'

/** Источник сегмента (для честной диагностики «откуда взялись границы») */
export type SkipSegmentSource = 'user' | 'site' | 'aniskip' | 'fallback' | 'mark-partial'

/** Один сегмент пропуска в секундах от начала серии */
export interface SkipSegment {
  type: SkipSegmentType
  start: number
  end: number
  source: SkipSegmentSource
  /** 0..1 — чем выше, тем безопаснее автопропуск */
  confidence: number
  id?: string
}

/** Ключ запроса: что именно сейчас играет */
export interface SkipQuery {
  malId: number | null
  animeId: number | null
  episode: number
  dubId: string | null
  /** Реальная длительность серии (из плеера) — валидация границ */
  durationSec: number
}

/** Санити-границы сегментов (спецификация «Валидация и слияние») */
export const SKIP_LIMITS: Record<SkipSegmentType, { minLen: number; maxLen: number }> = {
  op: { minLen: 20, maxLen: 150 },
  ed: { minLen: 20, maxLen: 200 },
  recap: { minLen: 10, maxLen: 240 },
}

const BOUNDARY_MATCH_SEC = 2

export function enabledTypes(settings: {
  skipOp: boolean
  skipEd: boolean
  skipRecap: boolean
}): SkipSegmentType[] {
  const out: SkipSegmentType[] = []
  if (settings.skipOp) out.push('op')
  if (settings.skipEd) out.push('ed')
  if (settings.skipRecap) out.push('recap')
  return out
}

/** Опенинг — в первой половине, эндинг — во второй (при известной длительности) */
function positionOk(type: SkipSegmentType, start: number, duration: number): boolean {
  if (duration <= 0) return true
  if (type === 'op') return start < duration * 0.6
  if (type === 'ed') return start > duration * 0.5
  return true
}

/**
 * Валидация: 0 ≤ start < end, длина в санити-границах, позиция правдоподобна.
 * durationSec ≤ 0 (неизвестна) — проверяем только границы отрезка.
 */
export function validateSegment(seg: SkipSegment, durationSec: number): SkipSegment | null {
  if (!Number.isFinite(seg.start) || !Number.isFinite(seg.end)) return null
  if (seg.start < 0 || seg.end <= seg.start) return null
  const limits = SKIP_LIMITS[seg.type]
  const len = seg.end - seg.start
  if (len < limits.minLen || len > limits.maxLen) return null
  if (durationSec > 0 && seg.end > durationSec + 1) return null
  if (!positionOk(seg.type, seg.start, durationSec)) return null
  return { ...seg, start: Math.max(0, Math.round(seg.start * 10) / 10), end: Math.round(seg.end * 10) / 10 }
}

/** Близкие границы (±2 с) из разных источников = подтверждение */
function agree(a: SkipSegment, b: SkipSegment): boolean {
  return (
    Math.abs(a.start - b.start) <= BOUNDARY_MATCH_SEC && Math.abs(a.end - b.end) <= BOUNDARY_MATCH_SEC
  )
}

const SOURCE_PRIORITY: Record<SkipSegmentSource, number> = {
  user: 3,
  site: 2,
  aniskip: 1,
  'mark-partial': 0.5,
  fallback: 0,
}

/**
 * Слияние кандидатов: на тип остаётся один сегмент — от источника с высшим
 * приоритетом; каждый чужой источник с близкими границами добавляет +0.15 к
 * confidence. Пересекающиеся (но не близкие) кандидаты низшего приоритета
 * отбрасываются — между op и recap не должно быть двусмысленности.
 */
export function mergeSegments(candidates: SkipSegment[], durationSec: number): SkipSegment[] {
  const byType = new Map<SkipSegmentType, SkipSegment[]>()
  for (const c of candidates) {
    const valid = validateSegment(c, durationSec)
    if (!valid) continue
    const list = byType.get(valid.type) ?? []
    list.push(valid)
    byType.set(valid.type, list)
  }

  const merged: SkipSegment[] = []
  for (const [, list] of byType) {
    list.sort((a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source])
    const best = list[0]
    let confidence = best.confidence
    for (const other of list.slice(1)) {
      if (agree(best, other)) confidence = Math.min(1, confidence + 0.15)
    }
    merged.push({ ...best, confidence: Math.round(confidence * 100) / 100 })
  }
  return merged.sort((a, b) => a.start - b.start)
}

/** Тайминги сайта (P1): skips из /api/site/videos — {opening,ending:{time,length}} */
export function segmentsFromSiteSkips(skips: VideoSkips | null): SkipSegment[] {
  if (!skips) return []
  const out: SkipSegment[] = []
  if (skips.opening && skips.opening.length > 0) {
    out.push({
      type: 'op',
      start: skips.opening.time,
      end: skips.opening.time + skips.opening.length,
      source: 'site',
      confidence: 0.9,
    })
  }
  if (skips.ending && skips.ending.length > 0) {
    out.push({
      type: 'ed',
      start: skips.ending.time,
      end: skips.ending.time + skips.ending.length,
      source: 'site',
      confidence: 0.9,
    })
  }
  return out
}

/** Пользовательские отметки (P3): «запомни начало/конец опенинга» */
export interface UserMarkRow {
  type: string
  dubbing: string | null
  startSec: number | null
  endSec: number | null
}

export function segmentsFromUserMarks(
  marks: UserMarkRow[],
  dub: string | null,
): { segments: SkipSegment[]; partial: SkipSegment[] } {
  const segments: SkipSegment[] = []
  const partial: SkipSegment[] = []
  for (const m of marks) {
    if (m.type !== 'op' && m.type !== 'ed' && m.type !== 'recap') continue
    const type = m.type as SkipSegmentType
    // Отметка делается на конкретной озвучке; к другой озвучке не переносим
    if (dub && m.dubbing && m.dubbing !== dub) continue
    const hasStart = typeof m.startSec === 'number' && Number.isFinite(m.startSec)
    const hasEnd = typeof m.endSec === 'number' && Number.isFinite(m.endSec)
    if (hasStart && hasEnd) {
      segments.push({
        type,
        start: m.startSec as number,
        end: m.endSec as number,
        source: 'user',
        confidence: 1,
      })
    } else if (hasStart || hasEnd) {
      // Частичная отметка: достраиваем вторую границу эвристикой (start+90 / dur-30)
      partial.push({
        type,
        start: hasStart ? (m.startSec as number) : -1,
        end: hasEnd ? (m.endSec as number) : -1,
        source: 'mark-partial',
        confidence: 0.4,
      })
    }
  }
  return { segments, partial }
}

/**
 * Fallback-слайдеры (низший приоритет): ручные N секунд с начала/конца.
 * Границы валидируются как обычные сегменты — короткие видео отсечёт санити.
 */
export function segmentsFromFallback(opts: {
  duration: number
  openingSec: number
  endingSec: number
  openingEnabled: boolean
  endingEnabled: boolean
}): SkipSegment[] {
  const out: SkipSegment[] = []
  if (opts.openingEnabled && opts.openingSec > 0) {
    out.push({ type: 'op', start: 0, end: opts.openingSec, source: 'fallback', confidence: 0.3 })
  }
  if (opts.endingEnabled && opts.endingSec > 0 && opts.duration > 0) {
    out.push({
      type: 'ed',
      start: Math.max(0, opts.duration - opts.endingSec),
      end: opts.duration - 0.5,
      source: 'fallback',
      confidence: 0.3,
    })
  }
  return out
}

/** Достройка частичной отметки: вторая граница по эвристике */
export function completePartialSegment(
  seg: SkipSegment,
  duration: number,
): SkipSegment | null {
  const limits = SKIP_LIMITS[seg.type]
  let start = seg.start
  let end = seg.end
  if (start < 0 && duration > 0) start = Math.max(0, duration - 30 - limits.minLen)
  if (end < 0) end = start + Math.min(90, limits.maxLen)
  return validateSegment({ ...seg, start, end }, duration)
}
