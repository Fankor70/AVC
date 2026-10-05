/**
 * Anime Voice Controller — Zustand store (клиентское состояние приложения).
 *
 * Держит: вкладки (Browser layer), playback (Player Control), disambiguation,
 * голосовой статус, пайплайн распознавания (debug), настройки, back-stack вкладок.
 * Используется executor'ом и UI-компонентами.
 */
import { create } from 'zustand'
import {
  AnimeCard,
  AppSettings,
  BrowserTab,
  CommandResult,
  DEFAULT_SETTINGS,
  NavigationContext,
  PlaybackContext,
  PipelineStep,
  SiteSectionId,
  TabKind,
  VoiceAliasRow,
  VoiceProviderMatch,
  YummyAccountSnapshot,
  YummyAnimeOwnState,
} from './types'
import type { SkipSegment } from './skip/core'

export type VoiceStatus = 'idle' | 'listening' | 'recognizing' | 'executing' | 'error'

export interface PendingOptions {
  query: string
  items: AnimeCard[]
  /** Запрошенная серия — доигрывается после выбора варианта («наруто 1 серия» → 2 варианта) */
  episode?: number
}

export interface AddTabData {
  kind: TabKind
  title: string
  payload?: Record<string, unknown>
}

/** Снимок состояния вкладки для back-stack (kind+title+payload) */
export type BackStackEntry = Record<string, unknown>

/** Ожидание подтверждения переключения озвучки («Вы имеете в виду...?») */
export interface VoiceConfirmState {
  spoken: string
  match: VoiceProviderMatch
}

export interface AvcState {
  // --- состояние ---
  tabs: BrowserTab[]
  activeTabId: string | null
  playback: PlaybackContext
  playerIframeUrl: string | null
  playerPlayerName: string | null
  pendingOptions: PendingOptions | null
  navigation: NavigationContext
  voiceStatus: VoiceStatus
  voiceMessage: string
  pipeline: PipelineStep[]
  lastExecuted: { raw: string; result: CommandResult } | null
  playerFullscreen: boolean
  episodesPanelOpen: boolean
  helpOpen: boolean
  settingsOpen: boolean
  debugOpen: boolean
  settings: AppSettings
  tabReloadCounter: Record<string, number>
  tabBackStack: Record<string, BackStackEntry[]>
  /** Инкрементится после записи в историю — HistoryPanel перезагружается */
  historyVersion: number

  /**
   * Своё состояние тайтла (список/избранное/оценка), прочитанное с сайта.
   * Ключуется animeId: подсветка активного статуса/сердца/оценки на странице
   * аниме без неё невозможна (урок: «ни звездочки ни сердечки не видны»).
   */
  ownAnimeState: { animeId: number; state: YummyAnimeOwnState } | null

  /**
   * Сегменты пропуска для ТЕКУЩЕЙ серии (SkipResolver): кнопка в плеере и
   * голосовой «пропусти опенинг» читают отсюда. Пусто — нет данных/fallback.
   */
  skipSegments: SkipSegment[]
  /** Инкрементится после изменения пользовательских отметок — плеер переразрешает */
  skipMarksVersion: number
  /** Последний пропущенный сегмент — для «вернись/отмени пропуск» */
  lastSkippedSegment: SkipSegment | null

  // --- аккаунт YummyAnime (реальная сессия сайта) / алиасы ---
  yummyAccount: YummyAccountSnapshot
  voiceAliases: VoiceAliasRow[]
  favoritesOpen: boolean
  authOpen: boolean
  /** Диалог обновления приложения (state-машина §3.5, только EXE) */
  updateDialogOpen: boolean
  voiceConfirm: VoiceConfirmState | null
  /** Громкость до Mute — для восстановления при Unmute */
  prevVolume: number

  // --- действия: вкладки ---
  addTab: (data: AddTabData) => string
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  patchTab: (
    id: string,
    patch: Partial<Pick<BrowserTab, 'kind' | 'title' | 'payload'>>,
  ) => void
  restoreSession: (tabs: BrowserTab[], activeId: string | null) => void

  // --- действия: плеер ---
  patchPlayback: (partial: Partial<PlaybackContext>) => void
  setPlayer: (url: string | null, playerName?: string | null) => void
  setPlayerFullscreen: (v: boolean) => void

  // --- действия: voice/диалоги ---
  setPendingOptions: (opts: PendingOptions | null) => void
  setVoiceStatus: (status: VoiceStatus, message?: string) => void
  setVoiceMessage: (message: string) => void
  pushPipeline: (steps: PipelineStep[]) => void
  resetPipeline: () => void
  setLastExecuted: (entry: { raw: string; result: CommandResult } | null) => void
  setEpisodesPanelOpen: (v: boolean) => void
  setHelpOpen: (v: boolean) => void
  setSettingsOpen: (v: boolean) => void
  setDebugOpen: (v: boolean) => void

  // --- действия: аккаунт YummyAnime/алиасы ---
  setOwnAnimeState: (entry: { animeId: number; state: YummyAnimeOwnState } | null) => void
  setSkipSegments: (segments: SkipSegment[]) => void
  bumpSkipMarksVersion: () => void
  setLastSkippedSegment: (seg: SkipSegment | null) => void
  setYummyAccount: (snap: YummyAccountSnapshot) => void
  setVoiceAliases: (rows: VoiceAliasRow[]) => void
  setFavoritesOpen: (v: boolean) => void
  setAuthOpen: (v: boolean) => void
  setUpdateDialogOpen: (v: boolean) => void
  setVoiceConfirm: (vc: VoiceConfirmState | null) => void
  setPrevVolume: (v: number) => void

  // --- действия: настройки/прочее ---
  updateSettings: (partial: Partial<AppSettings>) => void
  bumpReload: (tabId: string) => void
  pushBackStack: (tabId: string, payload: BackStackEntry) => void
  popBackStack: (tabId: string) => BackStackEntry | null
  bumpHistoryVersion: () => void
}

// --- служебное ---------------------------------------------------------------

let tabSeq = 0
function nextTabId(): string {
  tabSeq += 1
  return `tab-${Date.now().toString(36)}-${tabSeq}`
}

const INITIAL_TAB_ID = 'tab-home'

function makeHomeTab(id: string): BrowserTab {
  return { id, kind: 'home', title: 'Главная', payload: {}, createdAt: 0 }
}

const INITIAL_PLAYBACK: PlaybackContext = {
  animeId: null,
  animeTitle: null,
  animeSlug: null,
  malId: null,
  currentEpisode: null,
  episodesAired: null,
  episodesTotal: null,
  currentDub: null,
  isPlaying: false,
  volume: 70,
  currentTime: 0,
  duration: 0,
  currentSkips: null,
}

function deriveNavigation(
  tabs: BrowserTab[],
  activeTabId: string | null,
  pendingOptions: PendingOptions | null,
): NavigationContext {
  const idx = tabs.findIndex((t) => t.id === activeTabId)
  const active = idx >= 0 ? tabs[idx] : null
  const raw = active && active.kind === 'section' ? active.payload.section : undefined
  const section: SiteSectionId = typeof raw === 'string' ? (raw as SiteSectionId) : 'home'
  return {
    currentSection: section,
    activeTabIndex: idx + 1,
    tabCount: tabs.length,
    pickingFromList: pendingOptions !== null,
  }
}

// --- store -------------------------------------------------------------------

export const useAvcStore = create<AvcState>()((set, get) => ({
  tabs: [makeHomeTab(INITIAL_TAB_ID)],
  activeTabId: INITIAL_TAB_ID,
  playback: INITIAL_PLAYBACK,
  playerIframeUrl: null,
  playerPlayerName: null,
  pendingOptions: null,
  navigation: deriveNavigation([makeHomeTab(INITIAL_TAB_ID)], INITIAL_TAB_ID, null),
  voiceStatus: 'idle',
  voiceMessage: '',
  pipeline: [],
  lastExecuted: null,
  playerFullscreen: false,
  episodesPanelOpen: false,
  helpOpen: false,
  settingsOpen: false,
  debugOpen: false,
  settings: { ...DEFAULT_SETTINGS },
  tabReloadCounter: {},
  tabBackStack: {},
  historyVersion: 0,
  ownAnimeState: null,
  skipSegments: [],
  skipMarksVersion: 0,
  lastSkippedSegment: null,

  // --- аккаунт YummyAnime / алиасы ---
  yummyAccount: {
    state: 'unknown',
    user: null,
    lastSync: null,
    source: 'no-session',
    message: null,
  },
  voiceAliases: [],
  favoritesOpen: false,
  authOpen: false,
  updateDialogOpen: false,
  voiceConfirm: null,
  prevVolume: 70,

  // --- вкладки ---------------------------------------------------------------

  addTab: (data) => {
    const id = nextTabId()
    const tab: BrowserTab = {
      id,
      kind: data.kind,
      title: data.title,
      payload: data.payload ?? {},
      createdAt: Date.now(),
    }
    set((s) => {
      const tabs = [...s.tabs, tab]
      return { tabs, activeTabId: id, navigation: deriveNavigation(tabs, id, s.pendingOptions) }
    })
    return id
  },

  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id)
      if (idx < 0) return s
      let tabs = s.tabs.filter((t) => t.id !== id)
      const backStacks = { ...s.tabBackStack }
      delete backStacks[id]
      let activeTabId = s.activeTabId
      if (tabs.length === 0) {
        const home = makeHomeTab(nextTabId())
        home.createdAt = Date.now()
        tabs = [home]
        activeTabId = home.id
      } else if (activeTabId === id) {
        const neighbour = tabs[Math.min(idx, tabs.length - 1)]
        activeTabId = neighbour.id
      }
      return {
        tabs,
        activeTabId,
        tabBackStack: backStacks,
        navigation: deriveNavigation(tabs, activeTabId, s.pendingOptions),
      }
    }),

  setActiveTab: (id) =>
    set((s) =>
      s.tabs.some((t) => t.id === id)
        ? { activeTabId: id, navigation: deriveNavigation(s.tabs, id, s.pendingOptions) }
        : s,
    ),

  patchTab: (id, patch) =>
    set((s) => {
      const tabs = s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t))
      return { tabs, navigation: deriveNavigation(tabs, s.activeTabId, s.pendingOptions) }
    }),

  restoreSession: (tabs, activeId) =>
    set((s) => {
      const list: BrowserTab[] = tabs.length
        ? tabs
        : [makeHomeTab(nextTabId())]
      const active =
        activeId && list.some((t) => t.id === activeId) ? activeId : list[0].id
      return {
        tabs: list,
        activeTabId: active,
        navigation: deriveNavigation(list, active, s.pendingOptions),
      }
    }),

  // --- плеер -------------------------------------------------------------------

  patchPlayback: (partial) => set((s) => ({ playback: { ...s.playback, ...partial } })),

  setPlayer: (url, playerName = null) =>
    set({ playerIframeUrl: url, playerPlayerName: url ? playerName : null }),

  setPlayerFullscreen: (v) => set({ playerFullscreen: v }),

  // --- voice / диалоги ----------------------------------------------------------

  setPendingOptions: (opts) =>
    set((s) => ({
      pendingOptions: opts,
      navigation: deriveNavigation(s.tabs, s.activeTabId, opts),
    })),

  setVoiceStatus: (status, message) =>
    set((s) => ({ voiceStatus: status, voiceMessage: message ?? s.voiceMessage })),

  setVoiceMessage: (message) => set({ voiceMessage: message }),

  pushPipeline: (steps) =>
    set((s) => ({ pipeline: [...s.pipeline, ...steps].slice(-40) })),

  resetPipeline: () => set({ pipeline: [] }),

  setLastExecuted: (entry) => set({ lastExecuted: entry }),

  setEpisodesPanelOpen: (v) => set({ episodesPanelOpen: v }),
  setHelpOpen: (v) => set({ helpOpen: v }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setDebugOpen: (v) => set({ debugOpen: v }),

  // --- аккаунт YummyAnime / алиасы ----------------------------------------------

  setOwnAnimeState: (entry) => set({ ownAnimeState: entry }),
  setSkipSegments: (segments) => set({ skipSegments: segments }),
  bumpSkipMarksVersion: () => set((s) => ({ skipMarksVersion: s.skipMarksVersion + 1 })),
  setLastSkippedSegment: (seg) => set({ lastSkippedSegment: seg }),
  setYummyAccount: (snap) => set({ yummyAccount: snap }),
  setVoiceAliases: (rows) => set({ voiceAliases: rows }),
  setFavoritesOpen: (v) => set({ favoritesOpen: v }),
  setAuthOpen: (v) => set({ authOpen: v }),
  setUpdateDialogOpen: (v) => set({ updateDialogOpen: v }),
  setVoiceConfirm: (vc) => set({ voiceConfirm: vc }),
  setPrevVolume: (v) => set({ prevVolume: v }),

  // --- настройки / прочее ---------------------------------------------------------

  updateSettings: (partial) => set((s) => ({ settings: { ...s.settings, ...partial } })),

  bumpReload: (tabId) =>
    set((s) => ({
      tabReloadCounter: {
        ...s.tabReloadCounter,
        [tabId]: (s.tabReloadCounter[tabId] ?? 0) + 1,
      },
    })),

  pushBackStack: (tabId, payload) =>
    set((s) => ({
      tabBackStack: {
        ...s.tabBackStack,
        [tabId]: [...(s.tabBackStack[tabId] ?? []), payload].slice(-20),
      },
    })),

  popBackStack: (tabId) => {
    const stack = get().tabBackStack[tabId] ?? []
    if (stack.length === 0) return null
    const entry = stack[stack.length - 1]
    set((s) => ({
      tabBackStack: { ...s.tabBackStack, [tabId]: stack.slice(0, -1) },
    }))
    return entry
  },

  bumpHistoryVersion: () => set((s) => ({ historyVersion: s.historyVersion + 1 })),
}))

/** Типизированный доступ к действию pushBackStack (payload-снимок вкладки) */
export function makeTabSnapshot(tab: BrowserTab): BackStackEntry {
  return { kind: tab.kind, title: tab.title, payload: tab.payload }
}
