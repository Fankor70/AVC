/**
 * SkipResolver — каскад источников с гонко-безопасным опросом.
 *
 * Каскад (по приоритету): P3 пользовательские отметки → P1 тайминги сайта →
 * P2 Aniskip → fallback-слайдеры. Aniskip опрашивается параллельно с чтением
 * локальных источников, но его результаты не могут затереть высший приоритет
 * (слияние в core.mergeSegments). Отмены по requestId: смена серии/озвучки
 * инвалидирует устаревшие ответы — таймеры и результаты прошлой серии отбрасываются.
 */
import {
  completePartialSegment,
  mergeSegments,
  segmentsFromFallback,
  segmentsFromSiteSkips,
  segmentsFromUserMarks,
  type SkipSegment,
  type SkipSegmentType,
  type UserMarkRow,
} from './core'
import { fetchAniskipSegments } from './aniskip'

export interface ResolveOptions {
  malId: number | null
  episode: number
  dubId: string | null
  durationSec: number
  /** skips текущей серии с сайта (P1) */
  siteSkips: { opening: { time: number; length: number } | null; ending: { time: number; length: number } | null } | null
  /** пользовательские отметки (P3) — уже отфильтрованные по аниме */
  userMarks: UserMarkRow[]
  sources: { site: boolean; aniskip: boolean }
  fallback: { openingSec: number; endingSec: number; openingEnabled: boolean; endingEnabled: boolean }
  types: SkipSegmentType[]
}

export interface ResolveResult {
  segments: SkipSegment[]
  requestId: number
}

let requestCounter = 0
let inflight: { id: number; controller: AbortController } | null = null

/** Отменить текущий запрос (смена серии/озвучки/закрытие плеера) */
export function cancelResolve(): void {
  if (inflight) {
    inflight.controller.abort()
    inflight = null
  }
}

export async function resolveSkipSegments(opts: ResolveOptions): Promise<ResolveResult> {
  const requestId = ++requestCounter
  cancelResolve()
  const controller = new AbortController()
  inflight = { id: requestId, controller }

  const types = opts.types
  // Локальные источники — синхронно
  const local: SkipSegment[] = []
  if (opts.sources.site) local.push(...segmentsFromSiteSkips(opts.siteSkips))
  const marks = segmentsFromUserMarks(opts.userMarks, opts.dubId)
  local.push(...marks.segments)
  const partialCompleted = marks.partial
    .map((p) => completePartialSegment(p, opts.durationSec))
    .filter((s): s is SkipSegment => s !== null)
  local.push(...partialCompleted)

  // Aniskip (P2) — только если включён и есть MAL ID
  let aniskipSegments: SkipSegment[] | null = null
  if (opts.sources.aniskip && opts.malId && types.length > 0) {
    try {
      aniskipSegments = await fetchAniskipSegments({
        malId: opts.malId,
        episode: opts.episode,
        durationSec: opts.durationSec,
        types,
        signal: controller.signal,
      })
    } catch {
      aniskipSegments = null
    }
  }

  // Запрос устарел (смена серии пришла раньше ответа) — честно отбрасываем
  if (requestId !== requestCounter) {
    return { segments: [], requestId }
  }

  const fallback =
    local.length === 0 && !aniskipSegments
      ? segmentsFromFallback({ duration: opts.durationSec, ...opts.fallback })
      : []

  const segments = mergeSegments([...local, ...(aniskipSegments ?? []), ...fallback], opts.durationSec)
    .filter((s) => types.includes(s.type))

  if (inflight?.id === requestId) inflight = null
  return { segments, requestId }
}
