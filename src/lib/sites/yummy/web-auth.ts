/**
 * YummyAnime WEB-Auth — серверный клиент реального сайта (режим превью).
 *
 * Полный аналог electron-app/auth/yummy-auth-adapter.cjs, но вместо
 * webContents.executeJavaScript — серверные fetch с cookie-сессией сайта.
 * Все эндпоинты/заголовки/тела проверены по бандлу сайта (build.min.js
 * v3.0.308) и живыми запросами:
 *   POST /api/profile/login {login, password, recaptcha_response}  — логин
 *   GET  /api/profile                       — 200 профиль | 401 гость
 *   POST /api/profile/logout                — выход
 *   GET  /actions/export-favorites.php?format=json&vote=0 — избранное
 *   PUT/DELETE /anime/{id}/list|list/fav|rate — действия аккаунта
 * Заголовки API сайта: X-Application + Lang (та же строка из бандла).
 *
 * Пароль живёт только внутри одного запроса к сайту и НЕ сохраняется.
 * Cookie-строка хранится только в db/yummy-session.json (0600, вне git).
 */
import type {
  YummyAnimeActionRequest,
  YummyAnimeOwnState,
  YummyLibraryItem,
} from '@/lib/avc/types'
import type { WebSessionData } from './web-session'

export const SITE_ORIGIN = 'https://old.yummyani.me'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** Заголовки API сайта — ТОЧНО как шлёт сам сайт (бандл + логаут-скрипт) */
export const SITE_API_HEADERS = {
  'X-Application': 'wawegr8j13it4rdw',
  Lang: 'ru',
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'application/json',
} as const

/** kind → { method, path, body } — ТОЧНО как вызывает сам сайт (Ks/Ws) */
export const ACTION_METHODS: Record<
  string,
  (id: number, value?: number) => { method: string; path: string; body: object | null }
> = {
  setList: (id, value) => ({ method: 'PUT', path: `/api/anime/${id}/list`, body: { list: value } }),
  removeList: (id) => ({ method: 'DELETE', path: `/api/anime/${id}/list`, body: null }),
  setFavorite: (id) => ({ method: 'PUT', path: `/api/anime/${id}/list/fav`, body: {} }),
  removeFavorite: (id) => ({ method: 'DELETE', path: `/api/anime/${id}/list/fav`, body: null }),
  setRate: (id, value) => ({ method: 'PUT', path: `/api/anime/${id}/rate`, body: { rate: value } }),
  removeRate: (id) => ({ method: 'DELETE', path: `/api/anime/${id}/rate`, body: null }),
}

// --- HTTP helpers ------------------------------------------------------------

function timeoutSignal(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  return { signal: ctrl.signal, done: () => clearTimeout(t) }
}

/** Все Set-Cookie из ответа (Node/undici: headers.getSetCookie) */
export function getSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] }
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie().filter((c) => typeof c === 'string' && c.trim() !== '')
  }
  const raw = res.headers.get('set-cookie')
  if (!raw) return []
  // Редкий fallback: несколько cookie склеены запятой — режем по name=… перед ;
  return raw.split(/,(?=[^;]+?=)/g).filter((c) => c.trim() !== '')
}

/** Вырезать пары name=value из Set-Cookie */
function cookiePairs(setCookies: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const sc of setCookies) {
    const first = sc.split(';', 1)[0] ?? ''
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (!name) continue
    pairs.push([name, value])
  }
  return pairs
}

/**
 * Слить cookie-строку с новыми Set-Cookie (как cookie-jar браузера):
 * старые значения тех же имён заменяются, остальные сохраняются.
 */
export function mergeCookieHeader(existing: string, setCookies: string[]): string {
  const jar = new Map<string, string>()
  for (const part of existing.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name && value) jar.set(name, value)
  }
  for (const [name, value] of cookiePairs(setCookies)) jar.set(name, value)
  return Array.from(jar.entries())
    .map(([n, v]) => `${n}=${v}`)
    .join('; ')
}

/** Общий fetch к сайту с cookie-строкой и заголовками браузера */
async function siteFetch(
  url: string,
  init: {
    method: string
    cookie: string
    body?: string | null
    extra?: Record<string, string>
    timeoutMs?: number
  },
): Promise<Response> {
  const { signal, done } = timeoutSignal(init.timeoutMs ?? 15000)
  try {
    return await fetch(url, {
      method: init.method,
      redirect: 'follow',
      cache: 'no-store',
      signal,
      headers: {
        'User-Agent': UA,
        Referer: `${SITE_ORIGIN}/`,
        Origin: SITE_ORIGIN,
        ...(init.cookie ? { Cookie: init.cookie } : {}),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.extra ?? {}),
      },
      body: init.body ?? undefined,
    })
  } finally {
    done()
  }
}

// --- Парсинг профиля / избранного (защитно, порты из EXE-адаптера) -----------

interface UnknownRec {
  [k: string]: unknown
}

function asRec(v: unknown): UnknownRec | null {
  return typeof v === 'object' && v !== null ? (v as UnknownRec) : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

/**
 * Защитная нормализация JSON профиля сайта (формат не документирован —
 * перебираем известные варианты имён полей; не нашли — null).
 */
export function parseProfile(body: unknown): {
  userId: string | null
  username: string | null
  displayName: string | null
  avatarUrl: string | null
} | null {
  const root = asRec(body)
  if (!root) return null
  const u = asRec(root.response) ?? asRec(root.user) ?? root
  const ids = asRec(u.ids)
  const texts = asRec(u.texts)
  const avatars = asRec(u.avatars)

  const rawId = u.id ?? u.user_id ?? u.userId ?? null
  const id = rawId !== null && rawId !== undefined ? String(rawId) : null

  const nameCandidates = [
    u.name,
    u.login,
    u.username,
    u.nickname,
    ids ? str(ids.tg_nickname) : null,
    texts ? str(texts.left) : null,
    texts ? str(texts.right) : null,
  ]
  const name = nameCandidates.find((v): v is string => typeof v === 'string' && v.trim() !== '')

  const avatarCandidates = [
    u.avatar,
    u.avatar_url,
    avatars ? str(avatars.small) : null,
    avatars ? str(avatars.big) : null,
  ]
  const avatarRaw = avatarCandidates.find(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  )
  const avatarUrl = avatarRaw
    ? avatarRaw.startsWith('//')
      ? `https:${avatarRaw}`
      : avatarRaw
    : null

  if (id === null && !name) return null
  return {
    userId: id,
    username: name,
    displayName: name,
    avatarUrl,
  }
}

/** Защитный парсинг export-favorites (портирован из EXE-адаптера) */
export function parseFavorites(bodyRaw: unknown): Array<{
  animeId: number | null
  slug: string | null
  title: string
  poster: string | null
}> {
  const tryParse = (v: unknown): unknown => {
    if (typeof v === 'string') {
      try {
        return JSON.parse(v)
      } catch {
        return null
      }
    }
    return v
  }

  let list: unknown = null
  let body = bodyRaw
  if (typeof body === 'string') {
    const parsed = tryParse(body)
    if (parsed === null) return []
    body = parsed
  }
  if (Array.isArray(body)) list = body
  else if (asRec(body)) {
    const root = body as UnknownRec
    const data = tryParse(root.data)
    if (Array.isArray(data)) list = data
    else if (Array.isArray(root.items)) list = root.items
    else if (Array.isArray(root.response)) list = root.response
    else if (asRec(data)) {
      const inner = data as UnknownRec
      if (Array.isArray(inner.favorites)) list = inner.favorites
      else if (Array.isArray(inner.items)) list = inner.items
    }
  }
  if (!Array.isArray(list)) return []

  const out: Array<{
    animeId: number | null
    slug: string | null
    title: string
    poster: string | null
  }> = []
  for (const raw of list) {
    if (!asRec(raw)) continue
    const it = raw as UnknownRec
    const title = [it.title, it.name, it.anime_title].find(
      (v): v is string => typeof v === 'string' && v.trim() !== '',
    )
    const rawId = it.anime_id ?? it.animeId ?? it.id
    let slug: string | null = null
    if (typeof it.slug === 'string' && it.slug.trim() !== '') slug = it.slug
    else if (typeof it.url === 'string') {
      slug = it.url.match(/\/catalog\/item\/([a-z0-9-]+)/i)?.[1] ?? null
    }
    if (title === undefined && rawId === undefined && !slug) continue
    let poster: string | null = null
    if (typeof it.poster === 'string') poster = it.poster
    else if (asRec(it.poster) && typeof (it.poster as UnknownRec).medium === 'string') {
      poster = (it.poster as UnknownRec).medium as string
    }
    out.push({
      animeId: typeof rawId === 'number' ? rawId : null,
      slug,
      title: title ?? `Аниме #${String(rawId ?? '?')}`,
      poster: poster ? (poster.startsWith('//') ? `https:${poster}` : poster) : null,
    })
  }
  return out
}

// --- Логин / профиль / выход --------------------------------------------------

export interface SiteLoginResult {
  status: number
  /** Ответ сайта как есть (для честного текста ошибки пользователю) */
  body: unknown
  /** Cookie-строка после ответа (merged) */
  cookie: string
}

/**
 * РЕАЛЬНЫЙ логин на сайт: GET / (стартовая PHP-сессия, как в браузере) →
 * POST /api/profile/login {login, password, recaptcha_response:""}.
 * Пароль уходит ТОЛЬКО на сервер сайта.
 */
export async function siteLogin(login: string, password: string): Promise<SiteLoginResult> {
  // 1. Стартовая сессия (сайт ставит PHPSESSID на главную — как обычный браузер)
  let cookie = ''
  try {
    const initRes = await siteFetch(`${SITE_ORIGIN}/`, { method: 'GET', cookie: '' })
    cookie = mergeCookieHeader('', getSetCookies(initRes))
  } catch {
    /* сайт может выдать сессию прямо на POST — продолжаем */
  }

  // 2. Логин — точный запрос самого сайта
  const res = await siteFetch(`${SITE_ORIGIN}/api/profile/login`, {
    method: 'POST',
    cookie,
    body: JSON.stringify({ login, password, recaptcha_response: '' }),
    extra: { ...SITE_API_HEADERS },
    timeoutMs: 20000,
  })
  cookie = mergeCookieHeader(cookie, getSetCookies(res))
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body, cookie }
}

/** GET /api/profile с cookie-сессией: 200 профиль | 401 гость | 0 сеть */
export async function fetchProfile(
  cookie: string,
): Promise<{ status: number; body: unknown }> {
  try {
    const res = await siteFetch(`${SITE_ORIGIN}/api/profile`, {
      method: 'GET',
      cookie,
      extra: { ...SITE_API_HEADERS },
    })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { status: res.status, body }
  } catch {
    return { status: 0, body: null }
  }
}

/** POST /api/profile/logout в контексте сессии (сайт инвалидирует сам) */
export async function siteLogout(cookie: string): Promise<number> {
  try {
    const res = await siteFetch(`${SITE_ORIGIN}/api/profile/logout`, {
      method: 'POST',
      cookie,
      extra: { 'X-Requested-With': 'XMLHttpRequest', ...SITE_API_HEADERS },
    })
    return res.status
  } catch {
    return 0
  }
}

/** GET /actions/export-favorites.php?format=json&vote=0 в контексте сессии */
export async function fetchFavoritesText(cookie: string): Promise<{
  status: number
  text: string
}> {
  try {
    const res = await siteFetch(`${SITE_ORIGIN}/actions/export-favorites.php?format=json&vote=0`, {
      method: 'GET',
      cookie,
      extra: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
      timeoutMs: 25000,
    })
    return { status: res.status, text: await res.text() }
  } catch {
    return { status: 0, text: '' }
  }
}

// --- Библиотека (списки статусов) ---------------------------------------------
// Эндпоинт найден в бандле сайта: getLists(t,e) →
// GET /api/users/{t}/lists/{e}, где t — ЧИСЛОВОЙ id пользователя (без префикса
// "id", проверено на живой сессии: id470161 → 400 Arguments error, 470161 → 200).
// listId: 0 Смотрю, 1 В Планах, 2 Просмотрено, 3 Брошено, 4 Любимые, 5 Отложено.

/** GET /api/users/{numericId}/lists/{listId} в контексте сессии */
export async function fetchUserList(
  cookie: string,
  numericUserId: string,
  listId: number,
): Promise<{ status: number; body: unknown }> {
  try {
    const res = await siteFetch(
      `${SITE_ORIGIN}/api/users/${encodeURIComponent(numericUserId)}/lists/${listId}`,
      { method: 'GET', cookie, extra: { ...SITE_API_HEADERS }, timeoutMs: 25000 },
    )
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { status: res.status, body }
  } catch {
    return { status: 0, body: null }
  }
}

/** Защитная нормализация одного элемента списка библиотеки сайта */
function parseLibraryItem(raw: unknown): YummyLibraryItem | null {
  const it = asRec(raw)
  if (!it) return null

  const title = [it.title, it.name, it.anime_title].find(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  )
  const rawId = it.anime_id ?? it.animeId ?? it.id
  let slug: string | null = null
  if (typeof it.anime_url === 'string' && it.anime_url.trim() !== '') slug = it.anime_url.trim()
  else if (typeof it.slug === 'string' && it.slug.trim() !== '') slug = it.slug.trim()
  else if (typeof it.url === 'string') {
    slug = it.url.match(/\/catalog\/item\/([a-z0-9-]+)/i)?.[1] ?? null
  }
  if (title === undefined && rawId === undefined && slug === null) return null

  const posterRec = asRec(it.poster)
  let poster: string | null = null
  if (typeof it.poster === 'string') poster = it.poster
  else if (posterRec) {
    const p =
      posterRec.medium ?? posterRec.big ?? posterRec.small ?? posterRec.fullsize ?? posterRec.huge
    if (typeof p === 'string' && p.trim() !== '') poster = p
  }

  const userRec = asRec(it.user)
  const userListRec = userRec ? asRec(userRec.list) : null
  const innerListRec = userListRec ? asRec(userListRec.list) : null
  const ownRatingRaw = userRec ? userRec.rating : null
  const ownRating = typeof ownRatingRaw === 'number' && ownRatingRaw > 0 ? ownRatingRaw : null

  const statusRec = asRec(it.anime_status)
  const typeRec = asRec(it.type)

  const nextRaw = it.next_episode
  const nextEpisodeAt = typeof nextRaw === 'number' && nextRaw > 0 ? nextRaw : null
  const addedRaw = it.date
  const addedAt = typeof addedRaw === 'number' && addedRaw > 0 ? addedRaw : null

  const yearRaw = it.year
  const siteRatingRaw = it.rating

  const listIdRaw = innerListRec?.id
  return {
    animeId: typeof rawId === 'number' ? rawId : null,
    slug,
    title: title ?? `Аниме #${String(rawId ?? '?')}`,
    poster: poster ? (poster.startsWith('//') ? `https:${poster}` : poster) : null,
    year: typeof yearRaw === 'number' ? yearRaw : null,
    siteRating: typeof siteRatingRaw === 'number' ? siteRatingRaw : null,
    ownRating,
    isFavorite: userListRec?.is_fav === true,
    listId: typeof listIdRaw === 'number' ? listIdRaw : null,
    listTitle: typeof innerListRec?.title === 'string' ? (innerListRec.title as string) : null,
    animeStatus: statusRec && typeof statusRec.title === 'string' ? statusRec.title : null,
    animeStatusAlias: statusRec && typeof statusRec.alias === 'string' ? statusRec.alias : null,
    type: typeRec && typeof typeRec.name === 'string' ? typeRec.name : null,
    nextEpisodeAt,
    addedAt,
  }
}

/**
 * Разобрать ответ GET /api/users/{id}/lists/{listId} → массив элементов.
 * Сайт отдаёт { response: [...] }; защита от форматов {response:{response:[...]}}.
 */
export function parseLibraryItems(bodyRaw: unknown): YummyLibraryItem[] {
  let body = bodyRaw
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return []
    }
  }
  const root = asRec(body)
  let list: unknown = null
  if (root && Array.isArray(root.response)) list = root.response
  else if (root && asRec(root.response) && Array.isArray((root.response as UnknownRec).response)) {
    list = (root.response as UnknownRec).response
  } else if (Array.isArray(body)) list = body
  if (!Array.isArray(list)) return []

  const out: YummyLibraryItem[] = []
  for (const raw of list) {
    const item = parseLibraryItem(raw)
    if (item) out.push(item)
  }
  return out
}

// --- Верификация состояния по серверному HTML страницы аниме ------------------
// Маркеры из бандла сайта (build.min.js v3.0.308), проверены на живой странице:
//   .fav-type[data-id] + .selected — текущий список; .fav-type-fav.selected —
//   избранное (div.favorite-favorite.fav-type-fav); .user-rating (без .hidden) —
//   «Мой рейтинг»; div.marker «Зарегистрируйтесь, чтобы …» — страница гостя.

export interface OwnStateSignals {
  guestMarker: boolean
  favTypes: Array<{ id: number | null; selected: boolean }>
  favFavTagExists: boolean
  favFavoriteSelected: boolean
  userRating: number | null
}

function classTokens(attrs: string): string[] {
  const m = attrs.match(/class="([^"]*)"/)
  return m ? m[1].trim().split(/\s+/).filter(Boolean) : []
}

/**
 * Разобрать серверный HTML страницы тайтла → сигналы своего состояния.
 * CSS-семантика: токен класса 'fav-type' НЕ совпадает с 'fav-type-fav'.
 */
export function parseOwnStateFromHtml(html: string): OwnStateSignals {
  const guestMarker = html.includes('Зарегистрируйтесь, чтобы')

  const favTypes: Array<{ id: number | null; selected: boolean }> = []
  let favFavTagExists = false
  let favFavoriteSelected = false

  const tagRe = /<(a|div|button|span|li)\b([^>]*)>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html)) !== null) {
    const attrs = m[2]
    const tokens = classTokens(attrs)
    if (tokens.length === 0) continue
    if (tokens.includes('fav-type-fav')) {
      favFavTagExists = true
      if (tokens.includes('selected')) favFavoriteSelected = true
      continue // токен 'fav-type-fav' — НЕ элемент списка '.fav-type'
    }
    if (tokens.includes('fav-type')) {
      const idStr = attrs.match(/data-id="(\d+)"/)?.[1] ?? null
      favTypes.push({
        id: idStr !== null ? parseInt(idStr, 10) : null,
        selected: tokens.includes('selected'),
      })
    }
  }

  // .user-rating: без 'hidden' → вытащить число (до закрывающего span, 200 симв.)
  let userRating: number | null = null
  const ur = html.match(/<span[^>]*class="([^"]*\buser-rating\b[^"]*)"[^>]*>([\s\S]{0,200}?)<\/span>/)
  if (ur && !ur[1].split(/\s+/).includes('hidden')) {
    const num = (ur[2].match(/\d{1,2}/) ?? [])[0]
    if (num !== undefined) userRating = parseInt(num, 10)
  }

  return {
    guestMarker,
    favTypes,
    favFavTagExists,
    favFavoriteSelected,
    userRating,
  }
}

/** Сигналы → защитное состояние (null — структура неизвестна, не выдумываем) */
export function ownStateFromSignals(signals: OwnStateSignals): YummyAnimeOwnState & {
  hasMarkers: boolean
} {
  const selected = signals.favTypes.find((t) => t.selected && t.id !== null)
  const hasMarkers =
    signals.favTypes.length > 0 || signals.favFavTagExists || signals.userRating !== null
  return {
    listId: selected ? (selected.id as number) : null,
    isFavorite: signals.favFavoriteSelected,
    rating: signals.userRating !== null && signals.userRating > 0 ? signals.userRating : null,
    authenticatedPage:
      signals.guestMarker === true ? false : hasMarkers || signals.guestMarker === false ? true : null,
    hasMarkers,
  }
}

/** Ожидаемое состояние после действия (сверка с прочитанным) */
export function expectedOwnState(req: YummyAnimeActionRequest): Partial<YummyAnimeOwnState> {
  switch (req.kind) {
    case 'setList':
      return { listId: req.value ?? null }
    case 'removeList':
      return { listId: null }
    case 'setFavorite':
      return { isFavorite: true }
    case 'removeFavorite':
      return { isFavorite: false }
    case 'setRate':
      return { rating: req.value ?? null }
    case 'removeRate':
      return { rating: null }
    default:
      return {}
  }
}

export interface ActionRunResult {
  httpStatus: number
  state: YummyAnimeOwnState | null
  verification: 'pass' | 'mismatch' | 'unconfirmed'
  /** Текст ошибки сайта (если вернул), для честного сообщения */
  siteError: string | null
}

/**
 * Выполнить РЕАЛЬНОЕ действие аккаунта в сессии и верифицировать чтением
 * серверного HTML страницы тайтла (как сам сайт: действие → HTTP → reload → UI).
 */
export async function executeAnimeAction(
  cookie: string,
  req: YummyAnimeActionRequest,
): Promise<ActionRunResult> {
  const spec = ACTION_METHODS[req.kind]?.(req.animeId, req.value)
  if (!spec) {
    return { httpStatus: 0, state: null, verification: 'unconfirmed', siteError: null }
  }

  // 1. Действие — точный вызов сайта
  let httpStatus = 0
  let siteError: string | null = null
  try {
    const res = await siteFetch(`${SITE_ORIGIN}${spec.path}`, {
      method: spec.method,
      cookie,
      body: spec.body !== null ? JSON.stringify(spec.body) : null,
      extra: { ...SITE_API_HEADERS },
    })
    httpStatus = res.status
    if (!res.ok) {
      try {
        const j = (await res.json()) as UnknownRec
        siteError = str(j.error) ?? null
      } catch {
        siteError = null
      }
    }
  } catch {
    return { httpStatus: 0, state: null, verification: 'unconfirmed', siteError: null }
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return { httpStatus, state: null, verification: 'unconfirmed', siteError }
  }

  // 2. Верификация: перечитать серверный HTML страницы тайтла (≥1с после действия)
  if (req.slug && typeof req.slug === 'string' && req.slug.trim() !== '') {
    await new Promise((r) => setTimeout(r, 1100))
    try {
      const page = await siteFetch(`${SITE_ORIGIN}/catalog/item/${encodeURIComponent(req.slug)}`, {
        method: 'GET',
        cookie,
        extra: { Accept: 'text/html,*/*' },
        timeoutMs: 20000,
      })
      if (page.ok) {
        const html = await page.text()
        const signals = parseOwnStateFromHtml(html)
        const state = ownStateFromSignals(signals)
        const expected = expectedOwnState(req)
        if (state.authenticatedPage === false) {
          return { httpStatus, state, verification: 'mismatch', siteError }
        }
        if (!state.hasMarkers) {
          return { httpStatus, state: null, verification: 'unconfirmed', siteError }
        }
        let pass = true
        if ('listId' in expected) pass = pass && state.listId === expected.listId
        if ('isFavorite' in expected) pass = pass && state.isFavorite === expected.isFavorite
        if ('rating' in expected) pass = pass && state.rating === expected.rating
        return { httpStatus, state, verification: pass ? 'pass' : 'mismatch', siteError }
      }
    } catch {
      /* страница не прочитана — unconfirmed */
    }
  }
  return { httpStatus, state: null, verification: 'unconfirmed', siteError }
}

/**
 * Прочитать своё состояние тайтла с серверного HTML страницы (для UI страницы
 * аниме: подсветка активного списка/сердца/оценки). null — не удалось прочитать
 * (нет сессии/сети или страница гостя).
 */
export async function readOwnState(
  cookie: string,
  slug: string,
): Promise<YummyAnimeOwnState | null> {
  const s = String(slug ?? '').trim()
  if (s === '') return null
  try {
    const page = await siteFetch(`${SITE_ORIGIN}/catalog/item/${encodeURIComponent(s)}`, {
      method: 'GET',
      cookie,
      extra: { Accept: 'text/html,*/*' },
      timeoutMs: 20000,
    })
    if (!page.ok) return null
    const state = ownStateFromSignals(parseOwnStateFromHtml(await page.text()))
    if (!state.hasMarkers || state.authenticatedPage === false) return null
    return {
      listId: state.listId,
      isFavorite: state.isFavorite,
      rating: state.rating,
      authenticatedPage: state.authenticatedPage,
    }
  } catch {
    return null
  }
}

/** Обновить подпись сессии (не-секретный ник) при её изменении */
export async function touchSessionUsername(
  session: WebSessionData,
  username: string | null,
  save: (d: WebSessionData) => Promise<void>,
): Promise<void> {
  if (username && session.username !== username) {
    await save({ ...session, username })
  }
}
