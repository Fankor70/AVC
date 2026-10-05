/**
 * Command Executor — исполняет VoiceCommand[] над состоянием приложения
 * (Browser + Player Control layers). CLI-agnostic: работает только со store
 * и REST API адаптера. Импортируется только из клиентского кода.
 *
 * Пайплайн executeText:
 *   RAW → [подтверждение озвучки «да/нет» — до парсинга] → normalize (parseCommand)
 *   → [анти-дубль < 2.5 c] → [LLM fallback] → выполнение по очереди
 *   → pipeline steps → история → lastExecuted → voiceMessage
 *
 * Task 10-a (thin client): аккаунт = РЕАЛЬНАЯ сессия YummyAnime. Статусы/избранное
 * ведутся на сайте — голос честно объясняет и открывает сайт; «продолжить
 * просмотр» работает по локальной сессионной метке последнего открытого тайтла.
 */
import { toast } from '@/hooks/use-toast'
import { rankMatches } from '@/lib/voice/fuzzy'
import { LABELS, parseCommand } from '@/lib/voice/parser'
import {
  buildUserAliasMap,
  DEFAULT_VOICE_ALIASES,
  DubCandidate,
  resolveVoiceProvider,
} from '@/lib/voice/provider-resolver'
import { avcApi, getElectronBridge } from './api'
import {
  hasStickyActivation,
  playerWindowAvailable,
  sendPlayerCommand,
  storeToPlayerVolume,
} from './player-bridge'
import { siteProfileUrl } from './site-urls'
import {
  AnimeCard,
  AnimeDetails,
  AppSettings,
  BrowserContext,
  CommandResult,
  SiteSectionId,
  TabKind,
  VideoEntry,
  VoiceCommand,
  VoiceCommandType,
  VOICE_CONFIDENCE_ASK,
  VOICE_CONFIDENCE_AUTO,
  VoiceProviderMatch,
  YummyAnimeActionRequest,
} from './types'
import { makeTabSnapshot, useAvcStore } from './store'

// --- кэш деталей (модульный, переживает переключения вкладок) ------------------

/** TTL клиентского кэша деталей (аудит §3 п.2г: кэш без TTL не инвалидируется) */
const DETAILS_TTL_MS = 5 * 60 * 1000
const detailsCache = new Map<number, { data: AnimeDetails; ts: number }>()

function detailsCachePut(data: AnimeDetails): void {
  detailsCache.set(data.animeId, { data, ts: Date.now() })
}

function detailsCacheGet(animeId: number): AnimeDetails | null {
  const e = detailsCache.get(animeId)
  if (!e) return null
  if (Date.now() - e.ts > DETAILS_TTL_MS) {
    detailsCache.delete(animeId)
    return null
  }
  return e.data
}

/** Инвалидация кэша деталей («Обновляю страницу» и т.п.) */
export function invalidateDetailsCache(animeId?: number): void {
  if (typeof animeId === 'number') detailsCache.delete(animeId)
  else detailsCache.clear()
}

// --- анти-дубль команд (баг #12) ------------------------------------------------

/** Одна и та же команда подряд в пределах 2.5 с — пропускается */
const DEBOUNCE_MS = 2500
let lastCommand: { hash: string; ts: number } | null = null

/** Быстрая нормализация для фраз подтверждения (пунктуация → пробелы) */
function simpleNormalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Голосовое подтверждение предложенной озвучки */
const CONFIRM_YES = new Set([
  'да',
  'да переключай',
  'подтверждаю',
  'точно',
  'давай',
  'первый',
  'первая',
  'первое',
  '1',
])
const CONFIRM_NO = new Set([
  'нет',
  'отмена',
  'не',
  'неа',
  'неверно',
  'второй',
  'вторая',
  'второе',
  '2',
])

// --- служебные ----------------------------------------------------------------

const SECTION_LABELS: Record<SiteSectionId, string> = {
  home: 'Главная',
  catalog: 'Каталог',
  ongoing: 'Онгоинги',
  announcements: 'Анонсы',
  schedule: 'Расписание',
  top100: 'ТОП-100',
  random: 'Случайное',
}

function fail(message: string, error?: string): CommandResult {
  return { success: false, message, error }
}

function ok(message: string, data?: unknown): CommandResult {
  return { success: true, message, data }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max)
}

async function apiGetJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

function step(stage: 'RAW' | 'NORMALIZED' | 'COMMAND' | 'PARAMS' | 'CONFIDENCE' | 'RESULT' | 'SOURCE', text: string): void {
  useAvcStore.getState().pushPipeline([{ stage, text, ts: Date.now() }])
}

function paramNumber(cmd: VoiceCommand, key: string): number | null {
  const v = cmd.params[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

function paramString(cmd: VoiceCommand, key: string): string {
  const v = cmd.params[key]
  return typeof v === 'string' ? v.trim() : ''
}

// --- детали аниме ---------------------------------------------------------------

export async function fetchDetails(idOrSlug: number | string): Promise<AnimeDetails | null> {
  if (typeof idOrSlug === 'number') {
    const cached = detailsCacheGet(idOrSlug)
    if (cached) return cached
  }
  const data = await apiGetJson<AnimeDetails>(
    `/api/site/anime/${encodeURIComponent(String(idOrSlug))}`,
  )
  if (data) detailsCachePut(data)
  return data
}

/**
 * Открыть аниме по ссылке с сайта (панель избранного): если известен только
 * slug — сначала резолвим детали по slug, затем открываем вкладку.
 */
export async function openAnimeByRef(ref: {
  slug: string
  animeId: number | null
  title: string
}): Promise<void> {
  const details =
    (ref.animeId !== null ? await fetchDetails(ref.animeId) : null) ??
    (ref.slug ? await fetchDetails(ref.slug) : null)
  const card: AnimeCard = {
    animeId: details?.animeId ?? ref.animeId ?? 0,
    slug: details?.slug ?? ref.slug,
    title: details?.title ?? ref.title,
    poster: details?.poster ?? null,
    year: details?.year ?? null,
    rating: details?.rating ?? null,
    status: details?.status ?? null,
    type: details?.type ?? null,
  }
  await navigateToAnime(card, false, details)
}

export function getCachedDetails(
  animeId: number | null,
  slug: string | null,
): AnimeDetails | null {
  if (animeId !== null) {
    const c = detailsCacheGet(animeId)
    if (c) return c
  }
  if (slug) {
    for (const e of detailsCache.values()) {
      if (e.data.slug === slug) return e.data
    }
  }
  return null
}

/** Максимальный номер серии, доступный в видео-матрице/деталях */
export function maxEpisodeOf(details: AnimeDetails): number {
  if (details.episodesAired > 0) return details.episodesAired
  let max = 0
  for (const v of details.videos) max = Math.max(max, v.episode)
  return max
}

function pickVideo(
  details: AnimeDetails,
  episode: number,
  preferDub: string | null,
): VideoEntry | null {
  const forEp = details.videos.filter((v) => v.episode === episode && !!v.iframeUrl)
  if (forEp.length === 0) return null
  if (preferDub) {
    const m = forEp.find((v) => v.dubName === preferDub)
    if (m) return m
  }
  return forEp[0]
}

/** Записать детали открытого аниме в playback (сброс серии/озвучки) */
function applyDetailsToPlayback(details: AnimeDetails | null, card?: AnimeCard): void {
  const st = useAvcStore.getState()
  const aired = details ? maxEpisodeOf(details) : 0
  st.patchPlayback({
    animeId: details?.animeId ?? card?.animeId ?? null,
    animeTitle: details?.title ?? card?.title ?? null,
    animeSlug: details?.slug ?? card?.slug ?? null,
    malId: details?.malId ?? null,
    episodesAired: aired > 0 ? aired : null,
    episodesTotal: details?.episodesTotal ?? null,
    currentEpisode: null,
    currentDub: null,
    currentSkips: null,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
  })
  st.setPlayer(null, null)
}

// --- аккаунт YummyAnime (thin client) ------------------------------------------

/**
 * Локальная сессионная метка «последнее открытое аниме» — только для голосовой
 * команды «продолжить просмотр». Это состояние ПРИЛОЖЕНИЯ (не аккаунта):
 * сайт продолжает вести свои статусы/прогресс у себя.
 *
 * ИЗОЛЯЦИЯ АККАУНТОВ (спецификация, секция 14): метка хранится ПО АККАУНТАМ —
 * ключ `avc:lastWatched:{accountKey}`, где accountKey = userId сайта (не-секретный
 * идентификатор) либо 'anon'. Данные разных аккаунтов и гостя не смешиваются;
 * пароли/cookie идентификаторами НЕ используются.
 */
const LAST_WATCHED_PREFIX = 'avc:lastWatched'
const LAST_WATCHED_LEGACY_KEY = 'avc:lastWatched' // до изоляции — глобальный ключ

/** Безопасный идентификатор локального слота аккаунта (userId сайта или 'anon') */
function lastWatchedKey(): string {
  const acc = useAvcStore.getState().yummyAccount
  const id = acc.state === 'loggedIn' ? acc.user?.userId : null
  const safe = id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : 'anon'
  return `${LAST_WATCHED_PREFIX}:${safe}`
}

export interface LastWatched {
  animeId: number
  slug: string
  title: string
  poster: string | null
  episode: number | null
  currentDub: string | null
  at: number
}

export function getLastWatched(): LastWatched | null {
  try {
    const key = lastWatchedKey()
    let raw = localStorage.getItem(key)
    if (raw === null && key !== LAST_WATCHED_LEGACY_KEY) {
      // Миграция старой глобальной метки в слот 'anon' (однократно)
      const legacy = localStorage.getItem(LAST_WATCHED_LEGACY_KEY)
      if (legacy !== null) {
        localStorage.setItem(`${LAST_WATCHED_PREFIX}:anon`, legacy)
        localStorage.removeItem(LAST_WATCHED_LEGACY_KEY)
        raw = legacy
      }
    }
    if (!raw) return null
    const v = JSON.parse(raw) as LastWatched
    if (typeof v?.animeId !== 'number' || typeof v?.slug !== 'string') return null
    return v
  } catch {
    return null
  }
}

/**
 * Локальный трекинг просмотра — серверная БД приложения (SQLite).
 * Сайт прогресс серий наружу не отдаёт (только пишет внутри своей сессии),
 * поэтому приложение ведёт собственную запись: какое аниме, какая серия,
 * когда — с изоляцией по аккаунту (userId сайта или 'anon').
 */
function saveWatchProgressToServer(extra?: {
  poster?: string | null
  episodesTotal?: number | null
}): void {
  const pb = useAvcStore.getState().playback
  if (pb.animeId === null) return
  const acc = useAvcStore.getState().yummyAccount
  const id = acc.state === 'loggedIn' ? acc.user?.userId : null
  const accountKey = id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : 'anon'
  void avcApi.watchProgressSave({
    accountKey,
    animeId: pb.animeId,
    slug: pb.animeSlug ?? '',
    title: pb.animeTitle ?? 'Без названия',
    poster: extra?.poster ?? null,
    episode: pb.currentEpisode,
    episodesTotal: extra?.episodesTotal ?? null,
    dubbing: pb.currentDub,
  })
}

/** Запомнить текущее playback-состояние как «последнее открытое» (fire-and-forget) */
function rememberLastWatched(extra?: {
  poster?: string | null
  episodesTotal?: number | null
}): void {
  const pb = useAvcStore.getState().playback
  if (pb.animeId === null) return
  const entry: LastWatched = {
    animeId: pb.animeId,
    slug: pb.animeSlug ?? '',
    title: pb.animeTitle ?? 'Без названия',
    poster: extra?.poster ?? null,
    episode: pb.currentEpisode,
    currentDub: pb.currentDub,
    at: Date.now(),
  }
  try {
    localStorage.setItem(lastWatchedKey(), JSON.stringify(entry))
  } catch {
    /* localStorage может быть недоступен — метка просто не сохранится */
  }
  saveWatchProgressToServer(extra)
}

/** Проверить аккаунт и положить снимок в store (для голосовых команд и UI) */
export async function refreshAccount(
  refresh = true,
): Promise<import('./types').YummyAccountSnapshot> {
  const snap = await avcApi.yummyAccount(refresh)
  useAvcStore.getState().setYummyAccount(snap)
  return snap
}

/** Открыть профиль на сайте (если не залогинен — открыть диалог входа) */
export async function openSiteProfile(): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const acc = st.yummyAccount.state === 'loggedIn' ? st.yummyAccount : await refreshAccount()
  if (acc.state !== 'loggedIn' || !acc.user) {
    st.setAuthOpen(true)
    return fail(
      acc.state === 'sessionExpired'
        ? 'Сессия YummyAnime истекла — войдите снова'
        : 'Вы не вошли в аккаунт YummyAnime',
    )
  }
  const base = st.settings.baseUrl
  // /profile на сайте НЕТ (404): id → /users/id{N}, иначе главная (там форма «Вход»)
  const url = siteProfileUrl(base, acc.user.userId)
  try {
    window.open(url, '_blank', 'noopener')
    return ok(`Профиль ${acc.user.username ?? ''} на сайте`)
  } catch (e) {
    return fail('Не удалось открыть сайт', e instanceof Error ? e.message : String(e))
  }
}

/** Проверить аккаунт по голосовой команде: «проверь аккаунт» */
export async function checkAccount(): Promise<CommandResult> {
  try {
    const acc = await refreshAccount(true)
    if (acc.state === 'loggedIn' && acc.user) {
      return ok(`Вы вошли как ${acc.user.username ?? 'без имени'}`)
    }
    if (acc.state === 'sessionExpired') return fail('Сессия YummyAnime истекла — войдите снова')
    if (acc.state === 'unavailable') return fail('Сайт недоступен — проверьте интернет')
    useAvcStore.getState().setAuthOpen(true)
    return fail('Вы не вошли в аккаунт YummyAnime')
  } catch (e) {
    return fail('Не удалось проверить аккаунт', e instanceof Error ? e.message : String(e))
  }
}

/** Выйти из аккаунта: выход выполняется ЧЕРЕЗ САЙТ в постоянной сессии (секция 10) */
export async function accountLogout(): Promise<CommandResult> {
  try {
    // Сайт сам инвалидирует сессию (POST /api/profile/logout внутри её контекста),
    // Electron-сервис подтверждает состояние и возвращает не-секретный снимок.
    const snap = await avcApi.yummyLogout()
    useAvcStore.getState().setYummyAccount(snap)
    const who = snap.user?.username
    return ok(who ? `Вы вышли из аккаунта YummyAnime (${who})` : 'Вы вышли из аккаунта YummyAnime')
  } catch (e) {
    return fail('Не удалось выйти через сайт', e instanceof Error ? e.message : String(e))
  }
}

/** Синхронизация playback, если вкладка аниме открыта напрямую (сессия и т.п.) */
export function syncPlaybackToDetails(details: AnimeDetails): void {
  const st = useAvcStore.getState()
  if (st.playback.animeId === details.animeId) return
  applyDetailsToPlayback(details)
}

// --- открытие аниме / секций ---------------------------------------------------

async function navigateToAnime(
  card: AnimeCard,
  newTab: boolean,
  prefetched?: AnimeDetails | null,
): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const payload: Record<string, unknown> = { slug: card.slug, animeId: card.animeId }
  if (newTab || !st.activeTabId) {
    st.addTab({ kind: 'anime', title: card.title, payload })
  } else {
    const active = st.tabs.find((t) => t.id === st.activeTabId)
    if (active) {
      st.pushBackStack(active.id, makeTabSnapshot(active))
      st.patchTab(active.id, { kind: 'anime', title: card.title, payload })
    } else {
      st.addTab({ kind: 'anime', title: card.title, payload })
    }
  }
  const details = prefetched ?? (await fetchDetails(card.animeId))
  applyDetailsToPlayback(details, card)
  toast({ description: `Открыто: ${card.title}` })
  return ok(`Открыто: ${card.title}`, details)
}

/** Открыть карточку аниме из сетки (клик мышью) — в новой вкладке */
export async function openAnimeCard(card: AnimeCard, newTab = true): Promise<CommandResult> {
  return navigateToAnime(card, newTab)
}

function openSectionTab(sectionId: SiteSectionId): CommandResult {
  const st = useAvcStore.getState()
  if (sectionId === 'home') {
    st.addTab({ kind: 'home', title: SECTION_LABELS.home, payload: {} })
  } else {
    st.addTab({
      kind: 'section',
      title: SECTION_LABELS[sectionId],
      payload: { section: sectionId, page: 1 },
    })
  }
  return ok(`Открыто: ${SECTION_LABELS[sectionId]}`)
}

const SECTION_COMMAND: Partial<Record<SiteSectionId, VoiceCommandType>> = {
  catalog: VoiceCommandType.OpenCatalog,
  ongoing: VoiceCommandType.OpenOngoing,
  announcements: VoiceCommandType.OpenAnnouncements,
  schedule: VoiceCommandType.OpenSchedule,
  top100: VoiceCommandType.OpenTop100,
}

/** Хелпер для UI-кнопок: открыть секцию как голосовая команда */
export function openSection(sectionId: SiteSectionId): Promise<CommandResult> {
  const type =
    sectionId === 'home'
      ? VoiceCommandType.OpenHome
      : sectionId === 'random'
        ? VoiceCommandType.OpenRandom
        : SECTION_COMMAND[sectionId]
  if (!type) return Promise.resolve(fail(`Неизвестная секция: ${sectionId}`))
  return executeCommand({
    type,
    params: {},
    confidence: 1,
    label: SECTION_LABELS[sectionId],
  })
}

// --- серии / плеер ----------------------------------------------------------------

async function playEpisode(episode: number): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const pb = st.playback
  if (!pb.animeId) return fail('Сначала откройте аниме')
  const details = await fetchDetails(pb.animeId)
  if (!details) return fail('Не удалось загрузить данные аниме')
  const max = maxEpisodeOf(details)
  if (!Number.isFinite(episode) || episode < 1 || (max > 0 && episode > max)) {
    return fail(`Серия ${episode} не найдена`)
  }
  const video = pickVideo(details, episode, pb.currentDub)
  if (!video) return fail(`Серия ${episode} не найдена`)
  st.patchPlayback({
    currentEpisode: episode,
    isPlaying: true,
    currentTime: 0,
    duration: video.duration ?? 0,
    currentDub: pb.currentDub ?? video.dubName,
    currentSkips: video.skips,
  })
  st.setPlayer(video.iframeUrl, video.playerName)
  rememberLastWatched({
    poster: details.poster ?? null,
    episodesTotal: details.episodesTotal ?? (max > 0 ? max : null),
  })
  toast({ description: `▶ Серия ${episode}` })
  return ok(`Серия ${episode}`)
}

// --- основной switch ------------------------------------------------------------

async function executeOpenRandom(): Promise<CommandResult> {
  const details = await apiGetJson<AnimeDetails>('/api/site/random')
  if (!details) return fail('Не удалось получить случайное аниме')
  return navigateToAnime(details, false, details)
}

async function executeSearchAnime(cmd: VoiceCommand): Promise<CommandResult> {
  const query = paramString(cmd, 'query')
  if (!query) return fail('Пустой поисковый запрос')
  const open = cmd.params.open === true
  const newTab = cmd.params.newTab === true
  const data = await apiGetJson<{ items: AnimeCard[] }>(
    `/api/site/search?q=${encodeURIComponent(query)}`,
  )
  const items = data?.items ?? []
  if (items.length === 0) return fail(`Ничего не найдено по запросу «${query}»`)

  const ranked = rankMatches(query, items, (i) => i.title)
  const bestScore = ranked.length > 0 ? ranked[0].score : 0
  const episode = paramNumber(cmd, 'episode')
  if ((open || items.length === 1) && bestScore >= 0.55) {
    const best = ranked[0].item
    const navResult = await navigateToAnime(best, newTab)
    // Композит «тайтл + серия»: серия выбирается ВНУТРИ найденного аниме,
    // НЕ в текущем контексте (фаза 4.3 — запрет подмены Блич→Наруто и наоборот)
    if (episode !== null && navResult.success) {
      const epResult = await playEpisode(episode)
      if (epResult.success) {
        return ok(`Открыто «${best.title}», серия ${episode}`, navResult.data)
      }
      // честный частичный провал: тайтл открылся, серия — нет (фаза 4.7)
      return fail(`«${best.title}» открыт, но ${epResult.message.toLowerCase()}`)
    }
    return navResult
  }
  const candidates = (ranked.length > 0 ? ranked.map((r) => r.item) : items).slice(0, 6)
  useAvcStore
    .getState()
    .setPendingOptions({ query, items: candidates, episode: episode ?? undefined })
  return ok('Найдено несколько вариантов. Скажите номер.', candidates)
}

async function executeSelectOption(cmd: VoiceCommand): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const opts = st.pendingOptions
  if (!opts) return fail('Нет вариантов для выбора — сначала выполните поиск')
  const index = paramNumber(cmd, 'index')
  if (index === null) return fail('Не указан номер варианта')
  const item = opts.items[index - 1]
  if (!item) {
    return fail(`Вариант ${index} не найден. Доступно вариантов: ${opts.items.length}`)
  }
  st.setPendingOptions(null)
  const navResult = await navigateToAnime(item, false)
  // доигрываем запрошенную серию, если она была в исходной команде
  if (opts.episode && navResult.success) {
    const epResult = await playEpisode(opts.episode)
    if (epResult.success) {
      return ok(`Открыто «${item.title}», серия ${opts.episode}`, navResult.data)
    }
    return fail(`«${item.title}» открыт, но ${epResult.message.toLowerCase()}`)
  }
  return navResult
}

/** Применить выбранную озвучку: запомнить и, если серия открыта, перезапустить плеер */
function applyDubChoice(details: AnimeDetails, dubName: string): void {
  const st = useAvcStore.getState()
  st.patchPlayback({ currentDub: dubName })
  const ep = st.playback.currentEpisode
  if (ep !== null) {
    const video = pickVideo(details, ep, dubName)
    if (video) {
      st.patchPlayback({ currentSkips: video.skips })
      st.setPlayer(video.iframeUrl, video.playerName)
    }
  }
}

async function executeSelectVoice(cmd: VoiceCommand): Promise<CommandResult> {
  const st = useAvcStore.getState()
  if (!st.playback.animeId) return fail('Сначала откройте аниме')
  const details = await fetchDetails(st.playback.animeId)
  if (!details) return fail('Не удалось загрузить данные аниме')
  const dubs = details.dubs
  if (dubs.length === 0) return fail('Для этого аниме нет доступных озвучек')

  // {next: true} — циклически следующая озвучка
  if (cmd.params.next === true) {
    const curIdx = dubs.findIndex((d) => d.name === st.playback.currentDub)
    const next = dubs[(curIdx + 1) % dubs.length]
    applyDubChoice(details, next.name)
    return ok(`Озвучка: ${next.name}`)
  }

  // {index: N} — N-я озвучка в списке
  const idx = paramNumber(cmd, 'index')
  if (idx !== null) {
    if (idx < 1 || idx > dubs.length) {
      return fail(`Озвучка №${idx} не найдена. Доступно озвучек: ${dubs.length}`)
    }
    const chosen = dubs[idx - 1]
    applyDubChoice(details, chosen.name)
    return ok(`Озвучка: ${chosen.name}`)
  }

  // {name} — резолвинг через Voice Provider Resolver (Task 8-b)
  const spoken = paramString(cmd, 'name') || paramString(cmd, 'dub')
  if (!spoken) return fail('Не указана озвучка')
  const aliasMap = buildUserAliasMap(
    useAvcStore.getState().voiceAliases.map((r) => ({
      targetName: r.targetName,
      alias: r.alias,
    })),
  )
  const match = resolveVoiceProvider(
    spoken,
    dubs.map((d) => ({ name: d.name, shortName: d.shortName })),
    aliasMap,
    VOICE_CONFIDENCE_ASK,
  )
  if (!match) {
    const available = dubs.map((d) => d.shortName).slice(0, 6).join(', ')
    return fail(`Озвучка «${spoken}» не найдена. Доступны: ${available}`)
  }
  if (match.confidence >= VOICE_CONFIDENCE_AUTO) {
    // уверенное совпадение — переключаем молча
    applyDubChoice(details, match.name)
    return ok(`Озвучка: ${match.name} (${Math.round(match.confidence * 100)}%)`)
  }
  // 0.55..0.85 — спрашиваем подтверждение (диалог + голос «да/нет»)
  useAvcStore.getState().setVoiceConfirm({ spoken, match })
  return ok(`Вы имеете в виду «${match.name}»? Скажите ДА или НЕТ`)
}

// --- подтверждение озвучки (голос «да/нет» / диалог) ------------------------------

/** Пользователь подтвердил предложенную озвучку (диалог/голос «да») */
export function confirmVoiceMatch(): void {
  const st = useAvcStore.getState()
  const vc = st.voiceConfirm
  if (!vc) return
  st.setVoiceConfirm(null)
  void (async () => {
    try {
      const animeId = useAvcStore.getState().playback.animeId
      const details = animeId !== null ? await fetchDetails(animeId) : null
      if (!details) {
        useAvcStore.getState().setVoiceMessage('Не удалось применить озвучку')
        toast({ variant: 'destructive', description: 'Не удалось применить озвучку' })
        return
      }
      applyDubChoice(details, vc.match.name)
      const msg = `Озвучка: ${vc.match.name} (${Math.round(vc.match.confidence * 100)}%)`
      useAvcStore.getState().setVoiceMessage(msg)
      toast({ description: msg })
    } catch {
      toast({ variant: 'destructive', description: 'Не удалось применить озвучку' })
    }
  })()
}

/** Пользователь отклонил предложенную озвучку (диалог/голос «нет») */
export function cancelVoiceMatch(): void {
  const st = useAvcStore.getState()
  if (!st.voiceConfirm) return
  st.setVoiceConfirm(null)
  st.setVoiceMessage('Отменено')
}

// --- аккаунт: РЕАЛЬНЫЕ действия (список/оценка/избранное) / продолжить / алиасы ----

/**
 * Единая точка РЕАЛЬНЫХ действий аккаунта YummyAnime (спецификация I §9):
 *   - сессия должна быть подтверждена (иначе — честная просьба войти + диалог);
 *   - действие выполняется ВНУТРИ сессии сайта: EXE — main-процесс Electron,
 *     web — серверная сессия приложения (POST /api/yummy/action);
 *   - результат содержит верификацию ('pass' | 'unconfirmed' | 'mismatch').
 */
async function runAccountAction(
  req: Omit<YummyAnimeActionRequest, 'slug'>,
  successPrefix: string,
): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const pb = st.playback
  const acc = st.yummyAccount.state === 'unknown' ? await refreshAccount() : st.yummyAccount
  if (acc.state !== 'loggedIn') {
    st.setAuthOpen(true)
    return fail(
      acc.state === 'sessionExpired'
        ? 'Сессия YummyAnime истекла — войдите снова'
        : 'Войдите в аккаунт YummyAnime — списки/оценки/избранное хранятся в вашем аккаунте на сайте',
    )
  }
  try {
    const res = await avcApi.animeAction({ ...req, slug: pb.animeSlug ?? '' })
    // Состояние после действия → в стор: подсветка статуса/сердца/оценки на
    // странице аниме обязана обновиться БЕЗ перезагрузки страницы (урок:
    // «ни звездочки ни сердечки не видны визуально поставил или нет»)
    if (res.state && pb.animeId) {
      st.setOwnAnimeState({ animeId: pb.animeId, state: res.state })
    } else if (res.ok && pb.animeSlug && pb.animeId) {
      // верификация не удалась — перечитываем состояние фоном, UI всё равно обновится
      void avcApi
        .animeOwnState(pb.animeSlug)
        .then((s) => {
          const live = useAvcStore.getState()
          if (s && live.playback.animeId === pb.animeId) {
            live.setOwnAnimeState({ animeId: pb.animeId, state: s })
          }
        })
        .catch(() => {})
    }
    if (res.ok) {
      if (res.verification === 'pass') return ok(`${successPrefix} — подтверждено сайтом`)
      // HTTP принят; верификация unconfirmed/mismatch — честное сообщение сайта
      return ok(res.message)
    }
    // Отказ сайта. Если причина — сессия (401/403 или текст) — сразу открываем
    // диалог входа: пользователь должен ПОНЯТЬ, что нужно перелогиниться
    // (раньше это сообщение тонул в статусной строке / выбрасывалось кликами).
    const msg = res.message ?? 'Действие не выполнено'
    const sessionDead =
      res.httpStatus === 401 ||
      res.httpStatus === 403 ||
      /Сессия|Войдите|авторизов/i.test(msg)
    if (sessionDead) useAvcStore.getState().setAuthOpen(true)
    return fail(msg)
  } catch (e) {
    return fail('Действие не выполнено', e instanceof Error ? e.message : String(e))
  }
}

/** alias из парсера → list_id сайта (реестр Rt бандла сайта — ТОЧНЫЕ id) */
const STATUS_TO_LIST_ID: Record<string, number> = {
  watching: 0,
  planned: 1,
  completed: 2,
  dropped: 3,
  on_hold: 5,
}

const LIST_TITLES: Record<number, string> = {
  0: 'Смотрю',
  1: 'В Планах',
  2: 'Просмотрено',
  3: 'Брошено',
  5: 'Отложено',
}

/**
 * «добавь в смотрю/планы/просмотрено…» — РЕАЛЬНОЕ действие: PUT /anime/{id}/list
 * внутри сессии сайта + reload-верификация по серверному HTML (EXE).
 */
async function executeSetWatchStatus(cmd: VoiceCommand): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const pb = st.playback
  if (!pb.animeId) return fail('Сначала откройте аниме')
  const alias = paramString(cmd, 'status')
  const listId = STATUS_TO_LIST_ID[alias]
  if (listId === undefined) return fail('Неизвестный статус списка')
  return runAccountAction(
    { kind: 'setList', animeId: pb.animeId, value: listId },
    `Добавлено в «${LIST_TITLES[listId]}»`,
  )
}

/**
 * «убери из списка» — РЕАЛЬНОЕ действие: DELETE /anime/{id}/list внутри сессии
 * сайта (тайтл полностью выходит из списков; ставший видимым статус теперь можно снять)
 */
async function executeRemoveWatchStatus(): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const pb = st.playback
  if (!pb.animeId) return fail('Сначала откройте аниме')
  return runAccountAction({ kind: 'removeList', animeId: pb.animeId }, 'Убрано из списка')
}

/**
 * «добавь/убери из избранного» — РЕАЛЬНОЕ действие: PUT/DELETE /anime/{id}/list/fav
 * внутри сессии сайта + reload-верификация (EXE).
 */
async function executeToggleFavorite(cmd: VoiceCommand): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const pb = st.playback
  if (!pb.animeId) return fail('Сначала откройте аниме')
  const add = cmd.params.favorite !== false
  return runAccountAction(
    { kind: add ? 'setFavorite' : 'removeFavorite', animeId: pb.animeId },
    add ? 'Добавлено в Любимые' : 'Убрано из Любимых',
  )
}

/** «оцени на 8» — РЕАЛЬНОЕ действие: PUT /anime/{id}/rate {rate: 1..10} (EXE) */
async function executeRateAnime(cmd: VoiceCommand): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const pb = st.playback
  if (!pb.animeId) return fail('Сначала откройте аниме')
  const rating = paramNumber(cmd, 'rating')
  if (rating === null || rating < 1 || rating > 10 || !Number.isInteger(rating)) {
    return fail('Оценка должна быть целым числом от 1 до 10')
  }
  return runAccountAction(
    { kind: 'setRate', animeId: pb.animeId, value: rating },
    `Оценка ${rating} из 10 поставлена`,
  )
}

/** «убери оценку» — РЕАЛЬНОЕ действие: DELETE /anime/{id}/rate (EXE) */
async function executeRemoveRating(): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const pb = st.playback
  if (!pb.animeId) return fail('Сначала откройте аниме')
  return runAccountAction({ kind: 'removeRate', animeId: pb.animeId }, 'Оценка снята')
}

/**
 * Общий движок «продолжить»: открыть тайтл, восстановить озвучку и серию.
 * Используется и командой «продолжить просмотр» (последняя метка),
 * и кнопкой продолжения в библиотеке (любая запись прогресса).
 */
async function continueFromEntry(entry: {
  animeId: number
  slug: string
  title: string
  poster: string | null
  episode: number | null
  dubbing: string | null
}): Promise<CommandResult> {
  const card: AnimeCard = {
    animeId: entry.animeId,
    slug: entry.slug,
    title: entry.title,
    poster: entry.poster,
    year: null,
    rating: null,
    status: null,
    type: null,
  }
  await navigateToAnime(card, false)
  const st = useAvcStore.getState()
  if (entry.dubbing) st.patchPlayback({ currentDub: entry.dubbing })
  if (entry.episode !== null && entry.episode > 0) {
    const res = await playEpisode(entry.episode)
    if (!res.success) {
      toast({ variant: 'destructive', description: res.message })
      return fail(res.message)
    }
  }
  return ok(`Продолжаю: ${entry.title}${entry.episode ? `, серия ${entry.episode}` : ''}`)
}

/**
 * Продолжить просмотр по локальной сессионной метке: открыть аниме,
 * восстановить озвучку и серию. Экспортируется для UI.
 */
export async function continueWatchingFromLast(): Promise<CommandResult> {
  const last = getLastWatched()
  if (!last) return fail('Нет недавних тайтлов — скажи «найди ...» чтобы начать')
  return continueFromEntry({
    animeId: last.animeId,
    slug: last.slug,
    title: last.title,
    poster: last.poster,
    episode: last.episode,
    dubbing: last.currentDub,
  })
}

/** Продолжить конкретный тайтл из локального трекинга (кнопка в библиотеке) */
export async function continueWatchProgressItem(item: {
  animeId: number
  slug: string
  title: string
  poster: string | null
  episode: number | null
  dubbing: string | null
}): Promise<CommandResult> {
  return continueFromEntry(item)
}

/**
 * «Что я смотрю?» — голосовой ответ по локальному трекингу просмотра
 * (БД приложения): последнее аниме, серия, озвучка. Работает без входа на
 * сайт (anon-слот); с входом — прогресс изолирован по аккаунту сайта.
 */
export async function whatAmIWatching(): Promise<CommandResult> {
  const acc = useAvcStore.getState().yummyAccount
  const id = acc.state === 'loggedIn' ? acc.user?.userId : null
  const accountKey = id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : 'anon'
  let data
  try {
    data = await avcApi.watchProgressList(accountKey)
  } catch {
    return fail('Не удалось прочитать историю просмотра')
  }
  if (!data.available || data.items.length === 0) {
    return fail('Я ещё не записал просмотры — включите серию, и я запомню где вы остановились')
  }
  const last = data.items[0]
  const epPart = last.episode !== null ? `серия ${last.episode}` : 'серия не включалась'
  const totalPart =
    last.episodesTotal !== null && last.episode !== null ? ` из ${last.episodesTotal}` : ''
  const dubPart = last.dubbing ? ` (${last.dubbing})` : ''
  const more = data.items.length > 1 ? `\nЕщё недавно: ${data.items.slice(1, 4).map((i) => i.title).join(', ')}` : ''
  return ok(
    `Вы смотрите «${last.title}» — ${epPart}${totalPart}${dubPart}. Скажите «продолжить просмотр»${more}`,
  )
}

async function executeAddVoiceAlias(cmd: VoiceCommand): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const alias = paramString(cmd, 'alias')
  const target = paramString(cmd, 'target')
  if (!alias || !target) return fail('Укажите алиас и название озвучки')

  const aliasMap = buildUserAliasMap(
    st.voiceAliases.map((r) => ({ targetName: r.targetName, alias: r.alias })),
  )

  // 1) резолвим target по озвучкам текущего аниме (если открыто)
  let match: VoiceProviderMatch | null = null
  if (st.playback.animeId !== null) {
    const details = await fetchDetails(st.playback.animeId)
    if (details && details.dubs.length > 0) {
      match = resolveVoiceProvider(
        target,
        details.dubs.map((d) => ({ name: d.name, shortName: d.shortName })),
        aliasMap,
        VOICE_CONFIDENCE_ASK,
      )
    }
  }
  // 2) fallback — встроенный словарь известных озвучек
  if (!match) {
    const defaults: DubCandidate[] = Object.keys(DEFAULT_VOICE_ALIASES).map((k) => ({
      name: k,
      shortName: k,
    }))
    match = resolveVoiceProvider(target, defaults, aliasMap, VOICE_CONFIDENCE_ASK)
  }
  if (!match) return fail(`Не знаю такую озвучку: «${target}»`)

  try {
    const row = await avcApi.addAlias(match.name, alias, 'voice')
    const cur = useAvcStore.getState().voiceAliases
    useAvcStore
      .getState()
      .setVoiceAliases(
        cur.some((r) => r.id === row.id)
          ? cur.map((r) => (r.id === row.id ? row : r))
          : [row, ...cur],
      )
    return ok(`Запомнил: «${alias}» → ${match.name}`)
  } catch (e) {
    return fail('Не удалось сохранить алиас', e instanceof Error ? e.message : String(e))
  }
}

async function executeEpisodeCommand(cmd: VoiceCommand): Promise<CommandResult> {
  const episode = paramNumber(cmd, 'episode')
  if (episode === null) return fail('Не указан номер серии')
  return playEpisode(episode)
}

async function executeNextPrevEpisode(cmd: VoiceCommand): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const pb = st.playback
  if (!pb.animeId) return fail('Сначала откройте аниме')
  const details = await fetchDetails(pb.animeId)
  const max = details ? maxEpisodeOf(details) : pb.episodesAired ?? 0
  const current = pb.currentEpisode
  if (cmd.type === VoiceCommandType.NextEpisode) {
    if (current === null || current === 0) return playEpisode(1)
    if (max > 0 && current >= max) return fail(`Это последняя серия (${max})`)
    return playEpisode(current + 1)
  }
  if (current === null || current <= 1) return fail('Это первая серия')
  return playEpisode(current - 1)
}

function executePlayPause(cmd: VoiceCommand): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const pb = st.playback
  const wantPlay =
    cmd.type === VoiceCommandType.Play ||
    (cmd.type === VoiceCommandType.TogglePlayPause && !pb.isPlaying)
  if (wantPlay) {
    if (!pb.currentEpisode && pb.animeId) return playEpisode(1)
    // РЕАЛЬНЫЙ запуск: player_play в iframe. Голосовая сессия уже дала документу
    // «липкую» активацию (клик по микрофону/Ctrl+Space) + iframe has allow="autoplay"
    // → play() со звуком легален без единого клика руками.
    const sent = sendPlayerCommand({ key: 'player_play' })
    st.patchPlayback({ isPlaying: true })
    if (sent && !hasStickyActivation()) {
      // Единственный честный случай «не выходит без рук»: страница загружена,
      // микрофон разрешён заранее, но ни одного жеста ещё не было.
      toast({ description: 'Кликните один раз в любом месте — это разблокирует звук и голосовой запуск' })
    }
    return Promise.resolve(ok(sent ? 'Воспроизведение' : 'Воспроизведение (плеер не открыт)'))
  }
  sendPlayerCommand({ key: 'player_pause' })
  st.patchPlayback({ isPlaying: false })
  return Promise.resolve(ok('Пауза'))
}

function executeSeek(cmd: VoiceCommand): CommandResult {
  const st = useAvcStore.getState()
  const pb = st.playback
  const seconds = paramNumber(cmd, 'seconds') ?? st.settings.seekStep
  const delta = cmd.type === VoiceCommandType.SeekBackward ? -Math.abs(seconds) : Math.abs(seconds)
  const max = pb.duration > 0 ? pb.duration : Number.POSITIVE_INFINITY
  const next = clamp(pb.currentTime + delta, 0, max)
  st.patchPlayback({ currentTime: next })
  // РЕАЛЬНАЯ перемотка: player_seek принимает АБСОЛЮТНУЮ секунду (плеер сам
  // клампит к длительности). currentTime в store — из событий плеера.
  const sent = sendPlayerCommand({ key: 'player_seek', value: next })
  if (!sent && playerWindowAvailable()) {
    return ok(`${delta > 0 ? 'Вперёд' : 'Назад'} на ${Math.abs(seconds)} с (плеер ещё загружается)`)
  }
  return ok(`${delta > 0 ? 'Вперёд' : 'Назад'} на ${Math.abs(seconds)} с`)
}

// --- Skip Segments: голосовые/кнопочные пропуски --------------------------------

const SKIP_TYPE_TITLES: Record<string, string> = {
  op: 'опенинг',
  ed: 'эндинг',
  recap: 'рекап',
}

/**
 * «пропусти опенинг/эндинг»: seek к концу найденного сегмента; без данных —
 * fallback +N с (для op) / к концу (для ed). Seek верифицируется чтением
 * currentTime из событий плеера: одна повторная попытка, затем честный ответ.
 */
async function executeSkipSegment(cmd: VoiceCommand): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const pb = st.playback
  if (!pb.animeId || pb.currentEpisode === null) return fail('Сначала включите серию')
  const type = paramString(cmd, 'type') || 'op'

  const seg = st.skipSegments.find((s) => s.type === type)
  if (seg && pb.currentTime >= seg.start - 45 && pb.currentTime <= seg.end + 10) {
    sendPlayerCommand({ key: 'player_seek', value: seg.end })
    st.setLastSkippedSegment(seg)
    // Верификация seek: плеер шлёт time_update с реальным временем
    const verified = await verifySeek(seg.end)
    if (!verified) {
      sendPlayerCommand({ key: 'player_seek', value: seg.end })
      const retry = await verifySeek(seg.end)
      if (!retry) return ok(`${SKIP_TYPE_TITLES[type]}: команда перемотки отправлена, но плеер не подтвердил её`)
    }
    return ok(`${SKIP_TYPE_TITLES[type] === 'опенинг' ? 'Опенинг' : type === 'ed' ? 'Эндинг' : 'Рекап'} пропущен`)
  }

  // Fallback без данных: опенинг — вперёд на N с; эндинг — к концу серии
  if (type === 'op') {
    const target = Math.min(pb.currentTime + st.settings.skipFallbackSec, pb.duration || Number.POSITIVE_INFINITY)
    sendPlayerCommand({ key: 'player_seek', value: target })
    st.setLastSkippedSegment({ type: 'op', start: pb.currentTime, end: target, source: 'fallback', confidence: 0 })
    return ok(`Таймингов нет — перемотала вперёд на ${st.settings.skipFallbackSec} с`)
  }
  if (type === 'ed' && pb.duration > 0) {
    sendPlayerCommand({ key: 'player_seek', value: pb.duration - 0.5 })
    st.setLastSkippedSegment({ type: 'ed', start: pb.currentTime, end: pb.duration - 0.5, source: 'fallback', confidence: 0 })
    return ok('Эндинг пропущен')
  }
  return fail(`Тайминги ${SKIP_TYPE_TITLES[type]} для этой серии неизвестны`)
}

/** Ждать подтверждения перемотки от плеера (currentTime дойдёт до цели ±1.5 с) */
async function verifySeek(target: number, timeoutMs = 900): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 150))
    const t = useAvcStore.getState().playback.currentTime
    if (Math.abs(t - target) <= 1.5) return true
  }
  return false
}

/** «вернись/отмени пропуск» — возврат к началу только что пропущенного сегмента */
async function executeUndoSkip(): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const seg = st.lastSkippedSegment
  if (!seg) return fail('Недавно пропусков не было')
  sendPlayerCommand({ key: 'player_seek', value: seg.start })
  const verified = await verifySeek(seg.start)
  if (!verified) sendPlayerCommand({ key: 'player_seek', value: seg.start })
  st.setLastSkippedSegment(null)
  return ok('Возвращаю: пропуск отменён')
}

/** «включи/выключи автопропуск опенинга/эндинга» — патч настроек + персист */
async function executeSetAutoSkip(cmd: VoiceCommand): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const on = cmd.params.on !== false
  const type = paramString(cmd, 'type') || ''
  const patch: Partial<AppSettings> = { skipMode: on ? 'auto' : 'button' }
  if (type === 'op') patch.skipOp = on
  if (type === 'ed') patch.skipEd = on
  if (type === 'recap') patch.skipRecap = on
  // Выключение конкретного типа при выключенном автопропуске не должно
  // случайно включать skipMode — включение всегда поднимает режим до auto
  if (!on && type === '') patch.skipMode = 'button'
  st.updateSettings(patch)
  void fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).catch(() => undefined)
  return ok(cmd.label || (on ? 'Автопропуск включён' : 'Автопропуск выключен'))
}

/**
 * «запомни начало/конец опенинга» — отметка таймкода на месте (P3).
 * Частичная отметка (только одна граница) мержится в БД со второй при появлении.
 */
async function executeMarkSegment(cmd: VoiceCommand): Promise<CommandResult> {
  const st = useAvcStore.getState()
  const pb = st.playback
  if (!pb.animeId || pb.currentEpisode === null) return fail('Сначала включите серию')
  const markKind = paramString(cmd, 'markKind')
  const type = (paramString(cmd, 'type') || 'op') as 'op' | 'ed' | 'recap'
  if (markKind !== 'start' && markKind !== 'end') return fail('Не понял отметку')
  const t = pb.currentTime
  const acc = st.yummyAccount.state === 'loggedIn' ? st.yummyAccount.user?.userId : null
  const accountKey = acc && /^[A-Za-z0-9_-]{1,64}$/.test(acc) ? acc : 'anon'
  const saved = await avcApi.skipMarkSave({
    accountKey,
    animeId: pb.animeId,
    dubbing: pb.currentDub,
    type,
    startSec: markKind === 'start' ? t : null,
    endSec: markKind === 'end' ? t : null,
  })
  if (!saved) return fail('Не удалось сохранить отметку')
  st.bumpSkipMarksVersion()
  const which = markKind === 'start' ? 'Начало' : 'Конец'
  return ok(`${which} ${SKIP_TYPE_TITLES[type]} отмечено на ${Math.round(t)} с`)
}

function executeMuteUnmute(cmd: VoiceCommand): CommandResult {
  const st = useAvcStore.getState()
  const pb = st.playback
  if (cmd.type === VoiceCommandType.Mute) {
    // запоминаем громкость для восстановления (0 не затирает прежнее значение)
    st.setPrevVolume(pb.volume > 0 ? pb.volume : st.prevVolume)
    st.patchPlayback({ volume: 0 })
    sendPlayerCommand({ key: 'player_set_volume', value: { muted: true, volume: 0 } })
    return ok('Звук выключен')
  }
  const v = st.prevVolume > 0 ? st.prevVolume : 70
  st.patchPlayback({ volume: v })
  sendPlayerCommand({ key: 'player_set_volume', value: { muted: false, volume: storeToPlayerVolume(v) } })
  return ok(`Громкость ${v}%`)
}

function executeVolume(cmd: VoiceCommand): CommandResult {
  const st = useAvcStore.getState()
  const pb = st.playback
  let volume: number
  if (cmd.type === VoiceCommandType.SetVolume) {
    const v = paramNumber(cmd, 'volume')
    if (v === null) return fail('Не указана громкость')
    volume = clamp(v, 0, 100)
  } else {
    const delta = cmd.type === VoiceCommandType.VolumeUp ? st.settings.volumeStep : -st.settings.volumeStep
    volume = clamp(pb.volume + delta, 0, 100)
  }
  st.patchPlayback({ volume })
  sendPlayerCommand({ key: 'player_set_volume', value: { volume: storeToPlayerVolume(volume) } })
  return ok(`Громкость ${volume}%`)
}

function executeTabCommand(cmd: VoiceCommand): CommandResult {
  const st = useAvcStore.getState()
  switch (cmd.type) {
    case VoiceCommandType.OpenNewTab: {
      st.addTab({ kind: 'home', title: 'Главная', payload: {} })
      return ok('Открыта новая вкладка')
    }
    case VoiceCommandType.CloseTab: {
      const target = st.activeTabId ?? st.tabs[st.tabs.length - 1]?.id
      if (!target) return fail('Нет вкладок')
      const wasLast = st.tabs.length <= 1
      st.closeTab(target)
      return ok(wasLast ? 'Вкладка закрыта. Открыта главная' : 'Вкладка закрыта')
    }
    case VoiceCommandType.NextTab:
    case VoiceCommandType.PreviousTab: {
      if (st.tabs.length === 0) return fail('Нет вкладок')
      const idx = st.tabs.findIndex((t) => t.id === st.activeTabId)
      const cur = idx >= 0 ? idx : 0
      const dir = cmd.type === VoiceCommandType.NextTab ? 1 : -1
      const next = st.tabs[(cur + dir + st.tabs.length) % st.tabs.length]
      st.setActiveTab(next.id)
      return ok(`Вкладка: ${next.title}`)
    }
    case VoiceCommandType.SelectTab: {
      const n = paramNumber(cmd, 'index')
      if (n === null) return fail('Не указан номер вкладки')
      const tab = st.tabs[n - 1]
      if (!tab) return fail(`Вкладка ${n} не найдена. Открыто вкладок: ${st.tabs.length}`)
      st.setActiveTab(tab.id)
      return ok(`Вкладка: ${tab.title}`)
    }
    default:
      return fail('Неизвестная команда вкладок')
  }
}

function executeBack(): CommandResult {
  const st = useAvcStore.getState()
  const id = st.activeTabId
  if (!id) return fail('Нет активной вкладки')
  const entry = st.popBackStack(id)
  if (!entry) return fail('История вкладки пуста')
  const snap = entry as {
    kind?: TabKind
    title?: string
    payload?: Record<string, unknown>
  }
  st.patchTab(id, {
    kind: snap.kind ?? 'home',
    title: snap.title ?? 'Главная',
    payload: snap.payload ?? {},
  })
  return ok('Назад')
}

function executeScroll(cmd: VoiceCommand): CommandResult {
  const dir = cmd.type === VoiceCommandType.ScrollDown ? 1 : -1
  const delta = dir * 600

  // ГОЛОС-СКРОЛЛ ВНУТРЕННИХ КОНТЕЙНЕРОВ (аудит §3 п.2а): сетка серий с
  // внутренним скроллом была недостижима для голоса — теперь, если видимый
  // .avc-scroll может скроллиться в нужную сторону, скроллим ЕГО.
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('.avc-scroll'),
  ).filter((el) => {
    if (el.id === 'avc-content') return false
    if (el.scrollHeight <= el.clientHeight + 8) return false
    const r = el.getBoundingClientRect()
    const vh = window.innerHeight || 1
    // пересекается с вьюпортом хотя бы на 40px
    return Math.min(r.bottom, vh) - Math.max(r.top, 0) > 40
  })
  if (candidates.length > 0) {
    const canScroll = (el: HTMLElement) =>
      dir > 0
        ? el.scrollTop + el.clientHeight < el.scrollHeight - 4
        : el.scrollTop > 4
    const target = candidates.find(canScroll)
    if (target) {
      target.scrollBy({ top: delta, behavior: 'smooth' })
      return ok(dir > 0 ? 'Прокрутка вниз' : 'Прокрутка вверх')
    }
    // все видимые внутренние контейнеры уже в краю — падаем на основной скролл
  }

  const el = document.getElementById('avc-content')
  if (!el) return fail('Контейнер контента недоступен')
  el.scrollBy({ top: delta, behavior: 'smooth' })
  return ok(dir > 0 ? 'Прокрутка вниз' : 'Прокрутка вверх')
}

/** Выполнить одну команду. Экспортируется для UI-кнопок (дабы дублировать логику). */
export async function executeCommand(cmd: VoiceCommand): Promise<CommandResult> {
  switch (cmd.type) {
    case VoiceCommandType.OpenHome:
    case VoiceCommandType.OpenCatalog:
    case VoiceCommandType.OpenTop100:
    case VoiceCommandType.OpenOngoing:
    case VoiceCommandType.OpenAnnouncements:
    case VoiceCommandType.OpenSchedule: {
      const reverse: Partial<Record<VoiceCommandType, SiteSectionId>> = {
        [VoiceCommandType.OpenHome]: 'home',
        [VoiceCommandType.OpenCatalog]: 'catalog',
        [VoiceCommandType.OpenTop100]: 'top100',
        [VoiceCommandType.OpenOngoing]: 'ongoing',
        [VoiceCommandType.OpenAnnouncements]: 'announcements',
        [VoiceCommandType.OpenSchedule]: 'schedule',
      }
      const section = reverse[cmd.type]
      return section ? openSectionTab(section) : fail('Неизвестная секция')
    }
    case VoiceCommandType.OpenRandom:
      return executeOpenRandom()
    case VoiceCommandType.SearchAnime:
    case VoiceCommandType.OpenAnime:
      return executeSearchAnime({ ...cmd, params: cmd.type === VoiceCommandType.OpenAnime ? { ...cmd.params, open: true } : cmd.params })
    case VoiceCommandType.SelectOption:
      return executeSelectOption(cmd)
    case VoiceCommandType.SelectEpisode:
      return executeEpisodeCommand(cmd)
    case VoiceCommandType.NextEpisode:
    case VoiceCommandType.PreviousEpisode:
      return executeNextPrevEpisode(cmd)
    case VoiceCommandType.Play:
    case VoiceCommandType.Pause:
    case VoiceCommandType.TogglePlayPause:
      return executePlayPause(cmd)
    case VoiceCommandType.SeekForward:
    case VoiceCommandType.SeekBackward:
      return executeSeek(cmd)
    case VoiceCommandType.VolumeUp:
    case VoiceCommandType.VolumeDown:
    case VoiceCommandType.SetVolume:
      return executeVolume(cmd)
    case VoiceCommandType.Fullscreen:
      useAvcStore.getState().setPlayerFullscreen(true)
      return ok('Полный экран')
    case VoiceCommandType.ExitFullscreen:
      useAvcStore.getState().setPlayerFullscreen(false)
      return ok('Выход из полного экрана')
    case VoiceCommandType.ToggleFullscreen: {
      const cur = useAvcStore.getState().playerFullscreen
      useAvcStore.getState().setPlayerFullscreen(!cur)
      return ok(cur ? 'Выход из полного экрана' : 'Полный экран')
    }
    case VoiceCommandType.OpenNewTab:
    case VoiceCommandType.CloseTab:
    case VoiceCommandType.NextTab:
    case VoiceCommandType.PreviousTab:
    case VoiceCommandType.SelectTab:
      return executeTabCommand(cmd)
    case VoiceCommandType.Reload: {
      const st = useAvcStore.getState()
      if (!st.activeTabId) return fail('Нет активной вкладки')
      // Инвалидация клиентского кэша деталей — «Обновляю» должно дать живые данные
      invalidateDetailsCache()
      st.bumpReload(st.activeTabId)
      return ok('Обновляю страницу')
    }
    case VoiceCommandType.Back:
      return executeBack()
    case VoiceCommandType.Forward:
      return ok('Нет данных для перехода вперёд')
    case VoiceCommandType.ScrollUp:
    case VoiceCommandType.ScrollDown:
      return executeScroll(cmd)
    case VoiceCommandType.SelectVoice:
      return executeSelectVoice(cmd)
    case VoiceCommandType.ShowEpisodes:
      useAvcStore.getState().setEpisodesPanelOpen(true)
      return ok('Показываю серии')
    case VoiceCommandType.ShowHelp:
      useAvcStore.getState().setHelpOpen(true)
      return ok('Открываю справку')
    case VoiceCommandType.Mute:
    case VoiceCommandType.Unmute:
      return executeMuteUnmute(cmd)
    case VoiceCommandType.SetWatchStatus:
      return executeSetWatchStatus(cmd)
    case VoiceCommandType.RemoveWatchStatus:
      return executeRemoveWatchStatus()
    case VoiceCommandType.SkipSegment:
      return executeSkipSegment(cmd)
    case VoiceCommandType.UndoSkip:
      return executeUndoSkip()
    case VoiceCommandType.SetAutoSkip:
      return executeSetAutoSkip(cmd)
    case VoiceCommandType.MarkSegment:
      return executeMarkSegment(cmd)
    case VoiceCommandType.ToggleFavorite:
      return executeToggleFavorite(cmd)
    case VoiceCommandType.RateAnime:
      return executeRateAnime(cmd)
    case VoiceCommandType.RemoveRating:
      return executeRemoveRating()
    case VoiceCommandType.ContinueWatching:
      return continueWatchingFromLast()
    case VoiceCommandType.WhatAmIWatching:
      return whatAmIWatching()
    case VoiceCommandType.ShowLibrary: {
      useAvcStore.getState().setFavoritesOpen(true)
      return ok('Библиотека YummyAnime открыта')
    }
    case VoiceCommandType.OpenProfile:
      return openSiteProfile()
    case VoiceCommandType.CheckAccount:
      return checkAccount()
    case VoiceCommandType.AccountLogout:
      return accountLogout()
    case VoiceCommandType.AddVoiceAlias:
      return executeAddVoiceAlias(cmd)
    case VoiceCommandType.Unknown:
      return fail('Команда не распознана')
    default:
      return fail('Команда не поддерживается')
  }
}

// --- executeText ------------------------------------------------------------------
// УРОК РЕЛИЗА 1.0.12: LLM-fallback удалён по решению владельца — детерминированный
// парсер единственный источник интентов; фразы мимо словаря честно дают «Не удалось
// распознать команду», вместо угадывания облаком.

export interface ExecuteTextResult {
  raw: string
  normalized: string
  commands: VoiceCommand[]
  results: CommandResult[]
}

export function getBrowserContext(): BrowserContext {
  const s = useAvcStore.getState()
  return { navigation: s.navigation, playback: s.playback }
}

/**
 * Исполнение РАННЕЙ команды (спецификация §12): safe-интент по частичной фразе.
 * ЕДИНЫЙ путь исполнения — через executeCommand; дедупликация как у executeText.
 * Возвращает null, если тип не из безопасного реестра (§13).
 */
const EARLY_ALLOWED = new Set<string>([
  'NextEpisode', 'PreviousEpisode', 'Pause', 'Play', 'VolumeUp', 'VolumeDown', 'Mute', 'Unmute',
])

export async function executeEarlyCommand(type: string): Promise<CommandResult | null> {
  if (!EARLY_ALLOWED.has(type)) return null // §13: раннее исполнение — только безопасное
  const VCT = VoiceCommandType as unknown as Record<string, VoiceCommandType>
  const typeValue = VCT[type]
  if (!typeValue) return null
  const cmd: VoiceCommand = { type: typeValue, params: {}, confidence: 0.9, label: LABELS[typeValue] ?? type }
  try {
    return await executeCommand(cmd)
  } catch {
    return null
  }
}

/** Сквозные метаданные фразы (correlationId — от STT до записи истории) */
export interface ExecuteTextMeta {
  correlationId?: string
}

export async function executeText(
  raw: string,
  source: 'voice' | 'text',
  meta?: ExecuteTextMeta,
): Promise<ExecuteTextResult> {
  const initial = useAvcStore.getState()
  initial.resetPipeline()
  step('RAW', raw)

  // --- подтверждение озвучки ДО парсинга: «...анилибрию?» → «да» ---------------
  const vc = useAvcStore.getState().voiceConfirm
  if (vc) {
    const t = simpleNormalize(raw)
    const isYes = CONFIRM_YES.has(t)
    const isNo = CONFIRM_NO.has(t)
    if (isYes || isNo) {
      const result = isYes
        ? ok(`Озвучка: ${vc.match.name} (${Math.round(vc.match.confidence * 100)}%)`)
        : ok('Отменено')
      step('RESULT', `✓ ${result.message}`)
      if (isYes) confirmVoiceMatch()
      else cancelVoiceMatch()
      const st = useAvcStore.getState()
      st.setLastExecuted({ raw, result })
      st.setVoiceMessage(result.message)
      return { raw, normalized: raw, commands: [], results: [result] }
    }
    // любой другой текст: снимаем подтверждение и продолжаем обычный парсинг,
    // чтобы диалог не «застревал» (исправление можно произнести сразу)
    cancelVoiceMatch()
    step('RESULT', '✓ Подтверждение отменено — выполняю команду')
  }

  const context = getBrowserContext()
  const parsed = parseCommand(raw, context)
  step('NORMALIZED', parsed.normalized || raw)

  // --- анти-дубль: та же команда подряд в пределах 2.5 с — пропустить (баг #12) ---
  const hash = (parsed.normalized || raw).trim().toLowerCase()
  const now = Date.now()
  if (lastCommand && lastCommand.hash === hash && now - lastCommand.ts < DEBOUNCE_MS) {
    const skip = ok('Дубликат команды пропущен')
    step('RESULT', '✓ Дубликат команды пропущен')
    const st = useAvcStore.getState()
    st.setLastExecuted({ raw, result: skip })
    st.setVoiceMessage(skip.message)
    return { raw, normalized: parsed.normalized, commands: [], results: [skip] }
  }

  const commands = parsed.commands

  const results: CommandResult[] = []

  if (commands.length === 0) {
    const r = fail('Не удалось распознать команду')
    results.push(r)
    step('RESULT', `✗ ${r.message}`)
  } else {
    for (const cmd of commands) {
      const label = cmd.label || LABELS[cmd.type] || cmd.type
      step('COMMAND', label)
      step('PARAMS', JSON.stringify(cmd.params))
      step('CONFIDENCE', `${Math.round(cmd.confidence * 100)}%`)
      let result: CommandResult
      try {
        result = await executeCommand(cmd)
      } catch (e) {
        result = fail('Ошибка выполнения команды', e instanceof Error ? e.message : String(e))
      }
      results.push(result)
      step('RESULT', `${result.success ? '✓' : '✗'} ${result.message}`)

      const st = useAvcStore.getState()
      if (st.settings.saveHistory) {
        void fetch('/api/history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            raw,
            normalized: parsed.normalized,
            command: cmd.type,
            params: cmd.params,
            confidence: cmd.confidence,
            success: result.success,
            message: result.message,
            source,
            correlationId: meta?.correlationId ?? null,
          }),
        })
          .then(() => useAvcStore.getState().bumpHistoryVersion())
          .catch(() => undefined)
      }
    }
  }

  // Успешные И проваленные команды обновляют ts: «пауза пауза» подряд — дубль,
  // но с интервалом больше DEBOUNCE_MS та же команда выполняется снова
  lastCommand = { hash, ts: Date.now() }

  const final = results[results.length - 1]
  if (!final.success) {
    toast({ variant: 'destructive', description: final.message })
  }

  const st = useAvcStore.getState()
  st.setLastExecuted({ raw, result: final })
  st.setVoiceMessage(final.message)

  return { raw, normalized: parsed.normalized, commands, results }
}
