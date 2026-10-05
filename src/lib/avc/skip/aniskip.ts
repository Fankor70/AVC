/**
 * Aniskip-провайдер (P2, краудсорсинг): GET /v2/skip-times/{malId}/{episode}.
 * Открытый API, ключей нет; вежливость: свой User-Agent, не чаще 1 запроса/с
 * на хост, кэш позитивов на сутки и негативов на 6 ч (в памяти сессии),
 * Retry-After и тайм-аут соблюдаются. Никаких массовых префетчей.
 *
 * episodeLength обязателен к передаче, когда длительность известна: у разных
 * озвучек разная нарезка, при расхождении ответа с фактом >5 с понижаем
 * confidence и не даём автопропускать (только кнопка).
 */
import type { SkipSegment, SkipSegmentType } from './core'

const API_BASE = 'https://api.aniskip.com/v2'
const USER_AGENT = 'AVC-Anime/1.0 (anime voice controller; local player skip)'
const TIMEOUT_MS = 4000
const MIN_INTERVAL_MS = 1100

interface AniskipInterval {
  startTime: number
  endTime: number
}

interface AniskipResult {
  interval: AniskipInterval
  skipType: string
  skipId: string
  episodeLength: number
}

interface AniskipResponse {
  found?: boolean
  results?: AniskipResult[]
  status?: number
  error?: string
}

interface CacheEntry {
  /** null = подтверждённое отсутствие данных (негативный кэш) */
  segments: SkipSegment[] | null
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()
let lastRequestAt = 0

const POS_TTL_MS = 24 * 3600 * 1000
const NEG_TTL_MS = 6 * 3600 * 1000

const TYPE_MAP: Record<string, SkipSegmentType | null> = {
  op: 'op',
  ed: 'ed',
  'mixed-op': 'op',
  'mixed-ed': 'ed',
  recap: 'recap',
}

export function cacheKey(malId: number, episode: number, durationSec: number): string {
  // Длительность округляем до 30 с: разные озвучки чуть различаются по длине
  return `${malId}|${episode}|${Math.round(durationSec / 30)}`
}

export function clearAniskipCache(): void {
  cache.clear()
}

function politenessDelay(): number {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now()
  return wait > 0 ? wait : 0
}

/**
 * Запросить сегменты. Возвращает null и при ошибке сети, и при 404 —
 * различаются только через кэш-семантику (404 кэшируется, ошибка — нет).
 */
export async function fetchAniskipSegments(opts: {
  malId: number
  episode: number
  durationSec: number
  types: SkipSegmentType[]
  signal?: AbortSignal
}): Promise<SkipSegment[] | null> {
  const { malId, episode, durationSec, types } = opts
  if (!Number.isInteger(malId) || malId <= 0 || !Number.isInteger(episode) || episode <= 0) {
    return null
  }
  if (types.length === 0) return null

  const key = cacheKey(malId, episode, durationSec)
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.segments

  const wait = politenessDelay()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRequestAt = Date.now()

  const params = new URLSearchParams()
  for (const t of types) {
    params.append('types', t)
  }
  if (durationSec > 0) params.set('episodeLength', String(Math.round(durationSec)))

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    const res = await fetch(`${API_BASE}/skip-times/${malId}/${episode}?${params.toString()}`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
      cache: 'no-store',
    })
    clearTimeout(timer)

    if (res.status === 404) {
      // Штатный случай: данных для этой серии нет
      cache.set(key, { segments: null, expiresAt: Date.now() + NEG_TTL_MS })
      return null
    }
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') ?? '1', 10)
      lastRequestAt = Date.now() + (Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000)
      return null
    }
    if (!res.ok) return null

    const body = (await res.json()) as AniskipResponse
    const out: SkipSegment[] = []
    for (const r of body.results ?? []) {
      const type = TYPE_MAP[r.skipType]
      if (!type) continue
      const { startTime, endTime } = r.interval ?? {}
      if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) continue
      // Расхождение заявленной длительности с фактической >5 с → ниже уверенность
      let confidence = 0.8
      if (durationSec > 0 && r.episodeLength > 0 && Math.abs(r.episodeLength - durationSec) > 5) {
        confidence = 0.4
      }
      out.push({ type, start: startTime, end: endTime, source: 'aniskip', confidence })
    }
    cache.set(key, { segments: out.length > 0 ? out : null, expiresAt: Date.now() + (out.length > 0 ? POS_TTL_MS : NEG_TTL_MS) })
    return out.length > 0 ? out : null
  } catch {
    // Сеть/тайм-аут — не кэшируем, следующая серия попробует снова
    return null
  }
}
