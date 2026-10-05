/**
 * YummyAnimeAdapter — серверный адаптер сайта (мастер-промпт #4, #53, #78).
 *
 * Работа БЕЗ координат и DOM-инъекций: у сайта есть JSON API и
 * предсказуемые HTML-секции. Все селекторы собраны в одном месте (SELECTORS),
 * при изменении сайта правится только этот файл.
 *
 * Реальные эндпоинты old.yummyani.me:
 *   GET /api/search?q=            — JSON поиск
 *   GET /api/anime/{id}           — JSON детали (translates, episodes.count/aired)
 *   GET /api/anime/{id}/videos    — JSON матрица серий×озвучек (+iframe плеера)
 *   GET /catalog[/ongoing|/announcement|/schedule|/top] — HTML секции
 *   GET /catalog/random           — 302 редирект на случайный тайтл
 *   GET /catalog/item/{slug}      — HTML страница аниме (data-anime-id)
 */
import {
  AnimeCard,
  AnimeDetails,
  DubOption,
  SectionPage,
  SiteSectionId,
  VideoEntry,
  VideoSkips,
} from '@/lib/avc/types'

const NAMED_ENTITIES: Record<string, string> = {
  mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', nbsp: ' ',
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>',
  copy: '©', reg: '®', trade: '™', times: '×', middot: '·', bull: '•',
  shy: '\u00AD', zwnj: '\u200C', euro: '€', deg: '°', plusmn: '±',
}

export function decodeHtmlEntities(input: string): string {
  const raw = String(input ?? '')
  if (!raw.includes('&')) return raw
  return raw
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
      const code = parseInt(hex, 16)
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);?/g, (_, dec) => {
      const code = parseInt(dec, 10)
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&([a-z]+);?/gi, (m, name) => {
      const map = NAMED_ENTITIES[name.toLowerCase()]
      return map ?? m
    })
}


import { IAnimeSiteAdapter, SiteDiagnostics } from '../types'
import {
  demoDetails,
  demoRandom,
  demoSearch,
  demoSection,
  SECTION_TITLES,
} from './fallback'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** Все селекторы/шаблоны в одном месте (мастер-промпт #53) */
const SELECTORS = {
  card: /<div class="anime-column[^"]*" data-anime-id="(\d+)">([\s\S]*?)(?=<div class="anime-column[^"]*" data-anime-id=|<\/div>\s*<\/div>\s*<\/div>|$)/g,
  cardSlug: /href="\/catalog\/item\/([a-z0-9-]+)"/i,
  cardTitle: /class="anime-title"[^>]*>([^<]+)</i,
  cardPoster: /<img[^>]+src="([^"]+posters[^"]+)"/i,
  cardType: /anime-column-info[\s\S]*?anime-title[^>]*>[^<]+<\/a>\s*<div>([^<]+)<\/div>/i,
  pagination: /catalog\/(?:[^/?]+)\/?\?page=(\d+)/g,
  animeIdOnPage: /data-anime-id="(\d+)"/,
  slugFromUrl: /\/catalog\/item\/([a-z0-9-]+)/i,
}

// --- кэш (мастер-промпт #88: без постоянного поллинга, TTL-кэш) --------------

/**
 * Версия парсера (спецификация аккаунта, секция 25/EPISODE_PARSER_AUDIT §6):
 * входит в ключ кэша — при изменении парсинга старые записи инвалидируются сами.
 */
export const EPISODE_PARSER_VERSION = '2'

interface CacheEntry<T> {
  data: T
  expires: number
}

/** Жёсткий лимит записей — защита от роста памяти на длинных сессиях (аудит §3 п.8) */
const CACHE_MAX_ENTRIES = 120
const cache = new Map<string, CacheEntry<unknown>>()
const CACHE_TTL = 5 * 60 * 1000

function cacheGet<T>(key: string): T | null {
  const e = cache.get(key)
  if (e && e.expires > Date.now()) return e.data as T
  if (e) cache.delete(key)
  return null
}

function cacheSet<T>(key: string, data: T): T {
  // LRU-вытеснение: Map хранит порядок вставки — удаляем самые старые
  while (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  cache.set(key, { data, expires: Date.now() + CACHE_TTL })
  return data
}

export function clearSiteCache() {
  cache.clear()
}

// --- HTTP helpers ------------------------------------------------------------

async function fetchText(url: string, timeoutMs = 12000): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
      signal: ctrl.signal,
      redirect: 'follow',
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(t)
  }
}

async function fetchJson<T>(url: string, timeoutMs = 12000): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal,
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(t)
  }
}

/**
 * GET /api/anime/{id}/videos у онгоингов ≈ 5 МБ одним ответом (Ван-Пис: 8714
 * записей) — 12 с на медленной сети обрывался и «терял» серии (аудит §3 п.2в).
 * Требование аудита: таймаут ≥ 25 с + 1 ретрай.
 */
async function fetchJsonRetry<T>(url: string, timeoutMs = 25000, retries = 1): Promise<T> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchJson<T>(url, timeoutMs)
    } catch (e) {
      lastErr = e
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('запрос не удался')
}

// --- парсинг HTML карточек ---------------------------------------------------

function parseCards(html: string): AnimeCard[] {
  const cards: AnimeCard[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  SELECTORS.card.lastIndex = 0
  while ((m = SELECTORS.card.exec(html)) !== null) {
    const id = parseInt(m[1], 10)
    const block = m[2]
    const slug = block.match(SELECTORS.cardSlug)?.[1]
    const title = decodeHtmlEntities(block.match(SELECTORS.cardTitle)?.[1]?.trim() ?? '')
    if (!slug || !title || seen.has(slug)) continue
    seen.add(slug)
    const posterRaw = block.match(SELECTORS.cardPoster)?.[1] ?? null
    cards.push({
      animeId: id,
      slug,
      title,
      poster: posterRaw ? (posterRaw.startsWith('//') ? `https:${posterRaw}` : posterRaw) : null,
      year: null,
      rating: null,
      status: null,
      type: block.match(SELECTORS.cardType)?.[1]?.trim() ?? null,
    })
  }
  return cards
}

function parseTotalPages(html: string): number | null {
  let max = 1
  let m: RegExpExecArray | null
  SELECTORS.pagination.lastIndex = 0
  while ((m = SELECTORS.pagination.exec(html)) !== null) {
    max = Math.max(max, parseInt(m[1], 10))
  }
  return max
}

// --- секции ------------------------------------------------------------------

const SECTION_PATHS: Record<Exclude<SiteSectionId, 'home' | 'random'>, string> = {
  catalog: '/catalog',
  ongoing: '/catalog/ongoing',
  announcements: '/catalog/announcement',
  schedule: '/catalog/schedule',
  top100: '/catalog/top',
}

// --- API-типы сайта ----------------------------------------------------------

interface ApiSearchItem {
  anime_id: number
  anime_url: string
  title: string
  year: number
  poster: { medium?: string; big?: string; small?: string }
  anime_status: { title: string }
  type: { shortname: string }
  rating: { average: number }
}

interface ApiAnimeDetails {
  anime_id: number
  anime_url: string
  title: string
  description: string
  year: number
  poster: { medium?: string; big?: string }
  rating: { average: number }
  anime_status: { title: string }
  type: { shortname: string }
  genres: Array<{ title: string }>
  studios: Array<{ title: string }>
  translates: Array<{ value: number; title: string; href: string }>
  episodes: { count: number; aired: number }
  /** Внешние ID тайтла (формат не документирован — парсим защитно) */
  remote_ids?: { myanimelist_id?: unknown; mal?: unknown; [k: string]: unknown }
}

interface ApiVideoItem {
  video_id: number
  number: string
  iframe_url: string
  duration: number
  data: { player: string; dubbing: string }
  /** Проверено живым API: skips:{opening:{time,length},ending:{time,length}} | null */
  skips?: {
    opening?: { time?: number; length?: number } | null
    ending?: { time?: number; length?: number } | null
  } | null
  /** Для залогиненных сайт присылает отметку просмотренности [LIVE-VERIFY в сессии] */
  watched?: boolean | { end_time?: unknown } | null
}

/** Защитный разбор сегмента skip (формат сайтом не документирован — не выдумываем) */
function parseSkipSeg(raw: unknown): VideoSkips['opening'] {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as { time?: unknown; length?: unknown }
  const time = typeof r.time === 'number' && Number.isFinite(r.time) ? r.time : null
  const length = typeof r.length === 'number' && Number.isFinite(r.length) ? r.length : null
  if (time === null || length === null || length <= 0) return null
  return { time, length }
}

function parseSkips(v: ApiVideoItem): VideoSkips | null {
  if (typeof v.skips !== 'object' || v.skips === null) return null
  const opening = parseSkipSeg(v.skips.opening)
  const ending = parseSkipSeg(v.skips.ending)
  if (!opening && !ending) return null
  return { opening, ending }
}

// --- адаптер -----------------------------------------------------------------

export class YummyAnimeAdapter implements IAnimeSiteAdapter {
  readonly siteName = 'YummyAnime'
  readonly baseUrl: string
  /** Версия адаптера (спецификация аккаунта, секция 46) — меняем при изменении сайта */
  readonly adapterVersion = '1.1.0-account'

  constructor(baseUrl = 'https://old.yummyani.me') {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async searchAnime(query: string): Promise<AnimeCard[]> {
    const key = `search:${this.baseUrl}:${query}`
    const cached = cacheGet<AnimeCard[]>(key)
    if (cached) return cached
    try {
      const data = await fetchJson<{ response: ApiSearchItem[] }>(
        `${this.baseUrl}/api/search?q=${encodeURIComponent(query)}`,
      )
      const items: AnimeCard[] = (data.response ?? []).map((it) => ({
        animeId: it.anime_id,
        slug: it.anime_url,
        title: it.title,
        poster: it.poster?.medium ? (it.poster.medium.startsWith('//') ? `https:${it.poster.medium}` : it.poster.medium) : null,
        year: it.year ?? null,
        rating: it.rating?.average ?? null,
        status: it.anime_status?.title ?? null,
        type: it.type?.shortname ?? null,
      }))
      return cacheSet(key, items)
    } catch {
      return demoSearch(query)
    }
  }

  async getVideos(animeId: number): Promise<VideoEntry[]> {
    const key = `videos:v${EPISODE_PARSER_VERSION}:${this.baseUrl}:${animeId}`
    const cached = cacheGet<VideoEntry[]>(key)
    if (cached) return cached
    try {
      const data = await fetchJsonRetry<{ response: ApiVideoItem[] }>(
        `${this.baseUrl}/api/anime/${animeId}/videos`,
      )
      const items: VideoEntry[] = (data.response ?? []).map((v) => ({
        videoId: v.video_id,
        episode: parseInt(v.number, 10) || 0,
        dubName: v.data?.dubbing ?? 'Неизвестная озвучка',
        playerName: v.data?.player ?? '',
        iframeUrl: v.iframe_url ?? '',
        duration: v.duration ?? null,
        skips: parseSkips(v),
      }))
      return cacheSet(key, items)
    } catch {
      return []
    }
  }

  async getAnimeById(id: number): Promise<AnimeDetails | null> {
    const key = `anime:v${EPISODE_PARSER_VERSION}:${this.baseUrl}:${id}`
    const cached = cacheGet<AnimeDetails>(key)
    if (cached) return cached
    try {
      const [detailsResp, videos] = await Promise.all([
        fetchJson<{ response: ApiAnimeDetails }>(`${this.baseUrl}/api/anime/${id}`),
        this.getVideos(id),
      ])
      const d = detailsResp.response
      const result = { ...this.buildDetails(d, videos), source: 'live' as const }
      return cacheSet(key, result)
    } catch {
      // Честный fallback: помечаем данные как demo — UI показывает бейдж DEMO
      return { ...demoDetails(id), source: 'demo' as const }
    }
  }

  async getAnimeBySlug(slug: string): Promise<AnimeDetails | null> {
    const key = `animeslug:v${EPISODE_PARSER_VERSION}:${this.baseUrl}:${slug}`
    const cached = cacheGet<AnimeDetails>(key)
    if (cached) return cached
    try {
      // /api/anime/{alias} принимает человекочитаемый alias и возвращает anime_id
      const detailsResp = await fetchJson<{ response: ApiAnimeDetails }>(
        `${this.baseUrl}/api/anime/${encodeURIComponent(slug)}`,
      )
      const d = detailsResp.response
      const videos = await this.getVideos(d.anime_id)
      const result = { ...this.buildDetails(d, videos), source: 'live' as const }
      return cacheSet(key, result)
    } catch {
      return { ...demoDetails(slug), source: 'demo' as const }
    }
  }

  async getSection(section: SiteSectionId, page = 1): Promise<SectionPage> {
    if (section === 'home') {
      return {
        section: 'home',
        title: SECTION_TITLES.home,
        page: 1,
        totalPages: 1,
        items: [],
        source: 'live',
      }
    }
    const key = `section:${this.baseUrl}:${section}:${page}`
    const cached = cacheGet<SectionPage>(key)
    if (cached) return { ...cached, source: 'cache' }
    try {
      if (section === 'random') {
        const details = await this.getRandom()
        return {
          section,
          title: SECTION_TITLES.random,
          page: 1,
          totalPages: 1,
          items: details
            ? [
                {
                  animeId: details.animeId,
                  slug: details.slug,
                  title: details.title,
                  poster: details.poster,
                  year: details.year,
                  rating: details.rating,
                  status: details.status,
                  type: details.type,
                },
              ]
            : [],
          source: 'live',
        }
      }
      const path = SECTION_PATHS[section]
      const url = page > 1 ? `${this.baseUrl}${path}/?page=${page}` : `${this.baseUrl}${path}`
      const html = await fetchText(url)
      const items = parseCards(html)
      if (items.length === 0) throw new Error('no cards parsed')
      return cacheSet(key, {
        section,
        title: SECTION_TITLES[section],
        page,
        totalPages: parseTotalPages(html),
        items,
        source: 'live',
      })
    } catch (e) {
      if (process.env.AVC_DEBUG) {
        console.error(`[adapter] getSection(${section}) failed:`, e)
      }
      return demoSection(section, page)
    }
  }

  async getRandom(): Promise<AnimeDetails | null> {
    try {
      // /catalog/random отвечает 302 редиректом на случайный тайтл
      const res = await fetch(`${this.baseUrl}/catalog/random`, {
        headers: { 'User-Agent': UA },
        redirect: 'follow',
        cache: 'no-store',
      })
      const finalUrl = res.url
      const slug = finalUrl.match(/\/catalog\/item\/([a-z0-9-]+)/i)?.[1]
      if (!slug) throw new Error('random redirect not parsed')
      return await this.getAnimeBySlug(slug)
    } catch {
      return demoRandom()
    }
  }

  async runDiagnostics(): Promise<SiteDiagnostics[]> {
    const out: SiteDiagnostics[] = []
    const check = async (name: string, fn: () => Promise<string>) => {
      try {
        const detail = await fn()
        out.push({ name, ok: true, detail })
      } catch (e) {
        out.push({ name, ok: false, detail: e instanceof Error ? e.message : 'ошибка' })
      }
    }

    await check('Сайт доступен', async () => {
      await fetchText(this.baseUrl, 8000)
      return this.baseUrl
    })
    await check('Поиск (JSON API)', async () => {
      const r = await this.searchAnime('берсерк')
      if (r.length === 0) throw new Error('пустой результат')
      return `найдено ${r.length}`
    })
    await check('Секция Онгоинги', async () => {
      const s = await this.getSection('ongoing')
      return `${s.items.length} тайтлов (${s.source})`
    })
    await check('Секция ТОП-100', async () => {
      const s = await this.getSection('top100')
      return `${s.items.length} тайтлов (${s.source})`
    })
    await check('Секция Расписание', async () => {
      const s = await this.getSection('schedule')
      return `${s.items.length} тайтлов (${s.source})`
    })
    await check('Случайное аниме', async () => {
      const d = await this.getRandom()
      return d ? d.title : 'нет данных'
    })
    await check('Матрица серий/озвучек (videos API)', async () => {
      const d = await this.getRandom()
      if (!d) throw new Error('нет аниме для теста')
      const v = await this.getVideos(d.animeId)
      if (v.length === 0) throw new Error('пусто')
      return `${v.length} записей, ${d.dubs.length} озвучек`
    })
    return out
  }

  // --- приватное -------------------------------------------------------------

  private buildDetails(d: ApiAnimeDetails, videos: VideoEntry[]): AnimeDetails {
    // Группировка озвучек из матрицы видео (фактически доступные)
    const byDub = new Map<string, Set<number>>()
    for (const v of videos) {
      const name = v.dubName?.trim()
      if (!name) continue
      if (!byDub.has(name)) byDub.set(name, new Set())
      byDub.get(name)!.add(v.episode)
    }
    const dubs: DubOption[] = [...byDub.entries()]
      .map(([name, eps]) => ({
        name,
        shortName: name.replace(/^(Озвучка|Субтитры)\s*/i, '').trim() || name,
        episodes: [...eps].sort((a, b) => a - b),
      }))
      .filter((d) => d.shortName.length > 0)

    // Если озвучек из видео нет — используем translates из деталей
    if (dubs.length === 0 && d.translates) {
      for (const t of d.translates) {
        dubs.push({ name: t.title, shortName: t.title, episodes: [] })
      }
    }

    return {
      animeId: d.anime_id,
      slug: d.anime_url,
      title: decodeHtmlEntities(d.title),
      poster: d.poster?.medium
        ? d.poster.medium.startsWith('//')
          ? `https:${d.poster.medium}`
          : d.poster.medium
        : null,
      year: d.year ?? null,
      rating: d.rating?.average ?? null,
      status: d.anime_status?.title ?? null,
      type: d.type?.shortname ?? null,
      description: d.description != null ? decodeHtmlEntities(d.description) : null,
      genres: (d.genres ?? []).map((g) => decodeHtmlEntities(g.title)),
      studios: (d.studios ?? []).map((s) => s.title),
      episodesAired: d.episodes?.aired ?? 0,
      episodesTotal: d.episodes?.count ?? null,
      dubs,
      videos,
      malId: parseMalId(d.remote_ids),
    }
  }
}

/**
 * MAL ID из remote_ids сайта (research/yummytv-endpoints.md: myanimelist_id).
 * Защитно: поле не документировано — принимаем число или числовую строку.
 */
function parseMalId(remote: ApiAnimeDetails['remote_ids']): number | null {
  const raw = remote?.myanimelist_id ?? remote?.mal
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw
  if (typeof raw === 'string' && /^\d{1,7}$/.test(raw.trim())) return parseInt(raw.trim(), 10)
  return null
}

/** Адаптер по умолчанию (singleton) */
let defaultAdapter: YummyAnimeAdapter | null = null

export function getAdapter(baseUrl?: string): YummyAnimeAdapter {
  if (baseUrl) return new YummyAnimeAdapter(baseUrl)
  if (!defaultAdapter) defaultAdapter = new YummyAnimeAdapter()
  return defaultAdapter
}

// entity decode: site titles (mdash без точки с запятой)
