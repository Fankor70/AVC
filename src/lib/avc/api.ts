/**
 * Anime Voice Controller — клиент API (thin client).
 *
 * АУТЕНТИФИКАЦИЯ (спецификация «Production-Ready YummyAnime Authentication»):
 *   - EXE: сессия сайта живёт в постоянном браузерном профиле Electron
 *     (partition 'persist:yummyanime') и не покидает главный процесс;
 *     снимки аккаунта/избранного приходят через IPC-мост window.avcElectron
 *     (НЕ-секретные данные — секция 15).
 *   - Web (превью в браузере, БЕЗ оболочки): вход выполняется формой
 *     логин+пароль, сервер Next.js отправляет их напрямую на сервер сайта
 *     (POST /api/profile/login), хранит cookie-сессию ТОЛЬКО на сервере
 *     (db/yummy-session.json, 0600, вне git) и выполняет все действия
 *     аккаунта с ней. Пароль нигде не хранится; клиенту отдаются только
 *     НЕ-секретные снимки.
 * Cookie/пароли/токены через ЭТОТ слой не передаются никогда.
 *
 * Публичные данные сайта (поиск/каталог/детали) идут через Next API как раньше.
 */
import type {
  VoiceAliasRow,
  WatchProgressItem,
  WatchProgressResult,
  SkipMarkRow,
  YummyAccountSnapshot,
  YummyAnimeActionRequest,
  YummyAnimeActionResponse,
  YummyAnimeOwnState,
  YummyAuthSelfTestReport,
  YummyFavoritesResult,
  YummyLibraryResult,
} from './types'

/** Достать сообщение об ошибке из ответа сервера ({error} или статус) */
async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    if (body && typeof body.error === 'string' && body.error.trim() !== '') {
      return body.error
    }
  } catch {
    // не JSON — используем статус
  }
  return `Ошибка сервера (${res.status})`
}

async function jsonFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
}

// --- IPC-мост Electron (создаётся preload'ом оболочки) -----------------------

/** Контракт preload-моста EXE-сборки. Все методы возвращают НЕ-секретные данные. */
export interface AiComponentStatus {
  key: 'stt' | 'vad'
  id: string
  name: string
  required: boolean
  sizeBytes: number | null
  sizeHuman: string
  installed: boolean
  /** Модель по умолчанию (релиз 1.0.15 — GigaAM v3) */
  defaultModel?: boolean
}

export interface AiBenchmarkResult {
  ranAt: string
  audioMs: number
  decodeMs: number
  rtf: number | null
  text: string
  recommendedProfile: string
  recommendation: string
}

export interface AiCatalogModel {
  key: string
  id: string
  name: string
  profile: string | null
  engine: string | null
  description: string | null
  license: string | null
  recommendedFor: string | null
  sizeBytes: number | null
  sizeHuman: string
  installed: boolean
  damaged: boolean
  /** Причина повреждения (урок 0xC0000409: честная диагностика вместо краша) */
  damageReason?: string | null
  required: boolean
  /** Модель по умолчанию (активируется автоматически после установки) */
  defaultModel?: boolean
}

/** Карантин/безопасный режим после нативного краша модели (GitHub issue #2) */
export interface AiModelQuarantineInfo {
  modelId: string
  reason: string
  to?: string | null
  at: string
  code?: number
}

export interface AiStatusSnapshot {
  enabled: boolean
  profile: string
  worker?: 'ok' | 'failed'
  reason?: string
  /** Причина падения/незапуска AI-воркера (пусто — воркер жив) */
  workerError?: string | null
  modelsDir?: string
  models: AiComponentStatus[]
  activeModel?: string
  /** Модель, запрошенная конфигом (может отличаться от активной при fallback) */
  requestedModel?: string
  /** true — активная модель отличается от запрошенной (у запрошенной нет файлов) */
  modelFallback?: boolean
  /** Модель-исключение безопасного режима (не выбирается автоматически) */
  excludeModel?: string | null
  /** Последний карантин модели (повреждённые файлы) */
  quarantine?: AiModelQuarantineInfo | null
  /** Каталоги моделей в карантине */
  quarantinedDirs?: string[]
  engine?: string
  benchmark?: AiBenchmarkResult | null
  ready: { stt: boolean }
  stt: { state: string; profile: string; error: string | null; lastFinalMs: number | null; utterances: number }
}

/** Конфиг каталога моделей (фаза 5 аудита) */
export interface AiModelsDirConfig {
  currentDir: string
  configured: string | null
  defaultDir: string
  usedBytes: number | null
  workerReady: boolean
  /** Честная причина, почему воркер не запущен (для UI, а не молчаливый спиннер) */
  workerError?: string | null
}

export interface AiModelsDirSetResult {
  ok: boolean
  migrated?: boolean
  dir?: string
  copiedFiles?: number
  copiedBytes?: number
  message?: string
  error?: string
}

export interface AiHardwareInfo {
  cpu: string
  cpuCount: number
  ramBytes: number
  ramHuman: string
  freeDisk: number | null
  platform: string
  gpu: { vendor?: string; device?: string; name: string | null } | null
}

export interface AiModelProgress {
  key: string
  id: string
  phase: string
  percent?: number
  receivedBytes?: number
  totalBytes?: number
  speedBps?: number
  /** Сообщение о повторе/зеркале (phase 'retrying'/'mirror-fallback') */
  message?: string
  error?: string
  kind?: string
}

/** Фазы обновления (state-машина §3.5) */
export interface UpdateProgress {
  phase: 'checking' | 'downloading' | 'verifying' | 'preparing' | 'restarting' | 'error'
  percent?: number | null
  receivedBytes?: number | null
  totalBytes?: number | null
  speedBps?: number | null
  shaVerified?: boolean
  warning?: string | null
  error?: string
}

/** Итог обновления, сверенный после перезапуска (маркер update-pending.json) */
export interface UpdateResult {
  ok: boolean
  from?: string | null
  to?: string
  expected?: string | null
  running?: string
  startedAt?: string | null
}

export interface AvcElectronBridge {
  platform: 'electron'
  getAccountState(refresh?: boolean): Promise<YummyAccountSnapshot>
  openLoginWindow(): Promise<YummyAccountSnapshot>
  verifyAuthentication(): Promise<YummyAccountSnapshot>
  logout(): Promise<YummyAccountSnapshot>
  getFavorites(refresh?: boolean): Promise<YummyFavoritesResult>
  /** ПОЛНАЯ библиотека сайта (Смотрю/В Планах/…): читается ВНУТРИ сессии main-процесса */
  readLibrary?(): Promise<YummyLibraryResult>
  resetYummySession(): Promise<{ ok: boolean; backupPath: string | null; message: string }>
  runAuthSelfTest(): Promise<YummyAuthSelfTestReport>
  /** РЕАЛЬНОЕ действие аккаунта ВНУТРИ сессии сайта (список/оценка/избранное) */
  animeAction(req: YummyAnimeActionRequest): Promise<YummyAnimeActionResponse>
  /** Прочитать своё состояние тайтла (подсветка статуса/сердца/оценки) — null если не удалось */
  readAnimeOwnState?(slug: string): Promise<YummyAnimeOwnState | null>
  onAccountChanged(cb: (snap: YummyAccountSnapshot) => void): () => void
  /** Статусы входа из main-процесса (капча/ошибка/успех) для toast */
  onAuthStatus?(cb: (msg: string) => void): () => void
  /** Локальный AI-слой (спецификация §4–§134; отсутствует в старых сборках) */
  ai?: {
    available: boolean
    getStatus(): Promise<AiStatusSnapshot>
    getHardware(): Promise<AiHardwareInfo>
    install(keys: string[], voiceId?: string): Promise<Array<{ key: string; ok: boolean; skipped?: boolean; kind?: string; message?: string }>>
    cancelInstall(key: string): Promise<void>
    recover(): Promise<{ pendingParts: string[]; message: string }>
    setEnabled(enabled: boolean): Promise<boolean>
    setProfile(profile: string): Promise<string>
    // УРОК РЕЛИЗА 1.0.12: llmRoute/ttsSpeak/ttsCancel/setVoice удалены вместе со слоями
    initialize(): Promise<Record<string, string>>
    feedAudio(samples: Int16Array): Promise<boolean>
    flushStt(): Promise<void>
    /** Режим рации: аудио при удержании PTT без VAD-гейта */
    setCaptureMode(enabled: boolean): Promise<boolean>
    onSttPartial(cb: (p: { utteranceId: number; text: string; ms: number; earlyCommand?: string | null }) => void): () => void
    onSttFinal(cb: (p: { utteranceId: number; text: string; ms: number; earlyCommandType?: string | null }) => void): () => void
    onModelProgress(cb: (p: AiModelProgress) => void): () => void
    onServicesStatus(cb: (p: Record<string, string>) => void): () => void
    /** Каталог AI-моделей: текущий путь + конфиг (фаза 5 аудита) */
    getModelsDirConfig?(): Promise<AiModelsDirConfig>
    /** Системный диалог выбора папки (null = отмена) */
    pickModelsDir?(): Promise<string | null>
    /** Безопасная смена каталога: копирование → сверка → конфиг → рестарт воркера */
    setModelsDir?(dir: string): Promise<AiModelsDirSetResult>
    /** Открыть каталог моделей в проводнике */
    openModelsDir?(): Promise<{ ok: boolean; error: string | null }>
    /** Каталог моделей STT (спецификация STT) */
    catalog?(): Promise<AiCatalogModel[]>
    /** Бенчмарк «Проверить скорость на этом ПК» */
    benchmark?(): Promise<AiBenchmarkResult & { ok: boolean; message?: string }>
    /** Сменить активную модель STT */
    setSttModel?(modelId: string): Promise<{ ok: boolean; message?: string }>
    /** Удалить модель каталога */
    removeComponent?(key: string): Promise<{ ok: boolean; message?: string }>
    /** Проверить установленную модель */
    verifyComponent?(key: string): Promise<{ ok: boolean; message?: string }>
    /** Ручной перезапуск AI-воркера */
    restartWorker?(): Promise<{ ok: boolean; running?: boolean; error?: string; ready?: { stt: boolean } }>
    /** Открыть папку с логами */
    openLogsFolder?(): Promise<{ ok: boolean; error?: string | null }>
    /** Подписка на состояние AI-воркера (запущен/упал + причина) */
    onWorkerState?(cb: (p: { running: boolean; error: string | null; quarantine?: AiModelQuarantineInfo | null; safeMode?: AiModelQuarantineInfo | null }) => void): () => void
    /** Диагностика владельца: версия/пути/состояние воркера */
    getAppInfo?(): Promise<{
      version: string
      platform: string
      electron: string | null
      node: string | null
      userData: string
      logsFile: string
      modelsDir: string
      workerRunning: boolean
      workerError: string | null
      isPackaged: boolean
    }>
    /** Хвост лога приложения (без секретов — redact на этапе записи) */
    readDebugLogs?(lines?: number): Promise<{ lines: string[]; file?: string; error?: string }>
  }

  // --- ОБНОВЛЕНИЕ ПРИЛОЖЕНИЯ: ВЕРХНИЙ уровень моста (НЕ внутри ai) -------------
  // УРОК РЕЛИЗА 1.0.16: методы были внутри ai.* — UI звал их на верхнем уровне,
  // получал undefined и проваливался в web-ветку (безусловное скачивание EXE).
  /** Проверить обновление (GitHub releases/latest, сверка версий в main — §3.3) */
  checkUpdate?(): Promise<{
    current: string
    latest: string | null
    /** newer | older | up-to-date | unknown — честное отношение версий */
    relation: 'newer' | 'older' | 'up-to-date' | 'unknown'
    releaseName?: string | null
    releasedAt?: string | null
    releaseNotes?: string | null
    available: boolean
    assetUrl: string | null
    assetName: string | null
    assetSizeBytes?: number | null
    shaUrl?: string | null
    releasesUrl: string
    lastUpdateResult?: UpdateResult | null
    error?: string
  }>
  /** Скачать и установить обновление (main повторно сверяет версии + SHA-256) */
  installUpdate?(): Promise<{ ok: boolean; error?: string; relation?: string }>
  /** Прогресс обновления (фазы state-машины §3.5) */
  onUpdateProgress?(cb: (p: UpdateProgress) => void): () => void
  /** Итог прошлого обновления после перезапуска (§3.12) */
  onUpdateResult?(cb: (r: UpdateResult) => void): () => void
}

/** Есть ли мост EXE-сборки (в обычном браузере отсутствует) */
export function getElectronBridge(): AvcElectronBridge | null {
  if (typeof window === 'undefined') return null
  const bridge = (window as unknown as { avcElectron?: AvcElectronBridge }).avcElectron
  return bridge && bridge.platform === 'electron' ? bridge : null
}

const WEB_UNAVAILABLE: YummyAccountSnapshot = {
  state: 'unavailable',
  user: null,
  lastSync: null,
  source: 'no-session',
  message: 'Постоянная сессия YummyAnime живёт в EXE-сборке.',
}

const WEB_LOGIN_HINT =
  'Войдите в аккаунт YummyAnime — списки, оценки и избранное хранятся в вашем аккаунте на сайте'

/** Ответ POST /api/yummy/login */
export interface WebLoginResult {
  ok: boolean
  snapshot?: YummyAccountSnapshot
  message?: string
  captchaRequired?: boolean
}

export const avcApi = {
  /**
   * Состояние аккаунта YummyAnime.
   * EXE — через IPC (сессия в main-процессе);
   * Web — живая проверка серверной сессии сайта (GET /api/yummy/account).
   */
  async yummyAccount(refresh = false): Promise<YummyAccountSnapshot> {
    const bridge = getElectronBridge()
    if (bridge) return bridge.getAccountState(refresh)
    try {
      const res = await jsonFetch('/api/yummy/account')
      if (!res.ok) throw new Error(await readError(res))
      return (await res.json()) as YummyAccountSnapshot
    } catch {
      return {
        state: 'unavailable',
        user: null,
        lastSync: null,
        source: 'error',
        message: 'Не удалось проверить аккаунт — сервер недоступен',
      }
    }
  },

  /**
   * Вход в аккаунт YummyAnime логином и паролем (режим превью, без EXE).
   * Пароль отправляется сервером приложения напрямую на сервер сайта и
   * нигде не хранится. EXE использует окно сайта (openLoginWindow).
   */
  async yummyLogin(login: string, password: string): Promise<WebLoginResult> {
    try {
      const res = await jsonFetch('/api/yummy/login', {
        method: 'POST',
        body: JSON.stringify({ login, password }),
      })
      const body = (await res.json()) as WebLoginResult
      return body
    } catch {
      return { ok: false, message: 'Сервер недоступен — попробуйте позже' }
    }
  },

  /** Открыть окно входа на реальный сайт (только EXE). Резолв после закрытия окна. */
  async openLoginWindow(): Promise<YummyAccountSnapshot> {
    const bridge = getElectronBridge()
    if (!bridge) {
      return {
        ...WEB_UNAVAILABLE,
        message: 'В веб-режиме входите формой ниже — пароль уйдёт прямо на сервер сайта.',
      }
    }
    return bridge.openLoginWindow()
  },

  /** Полная проверка аутентификации через сайт (verifyAuthentication) */
  async verifyAuthentication(): Promise<YummyAccountSnapshot> {
    const bridge = getElectronBridge()
    if (bridge) return bridge.verifyAuthentication()
    return avcApi.yummyAccount(true)
  },

  /** Выход ЧЕРЕЗ САЙТ (сайт инвалидирует сессию), затем локальное подтверждение */
  async yummyLogout(): Promise<YummyAccountSnapshot> {
    const bridge = getElectronBridge()
    if (bridge) return bridge.logout()
    try {
      const res = await jsonFetch('/api/yummy/login', { method: 'DELETE' })
      if (!res.ok) throw new Error(await readError(res))
      const body = (await res.json()) as { snapshot?: YummyAccountSnapshot }
      return body.snapshot ?? { state: 'loggedOut', user: null, lastSync: null, source: 'live', message: null }
    } catch {
      return { state: 'loggedOut', user: null, lastSync: null, source: 'error', message: 'Выход выполнен локально' }
    }
  },

  /**
   * Избранное с сайта. EXE — через IPC (данные сессии main-процесса);
   * web — через серверную сессию сайта (GET /api/yummy/favorites).
   */
  async yummyFavorites(refresh = false): Promise<YummyFavoritesResult> {
    const bridge = getElectronBridge()
    if (bridge) return bridge.getFavorites(refresh)
    try {
      const res = await jsonFetch('/api/yummy/favorites')
      if (!res.ok) throw new Error(await readError(res))
      return (await res.json()) as YummyFavoritesResult
    } catch {
      return {
        available: false,
        items: [],
        reason: WEB_LOGIN_HINT,
        lastSync: null,
      }
    }
  },

  /**
   * РЕАЛЬНОЕ действие аккаунта YummyAnime (список/оценка/избранное).
   * EXE — same-origin внутри постоянной сессии сайта (main-процесс);
   * web — POST /api/yummy/action (серверная сессия сайта) с верификацией
   * чтением серверного HTML страницы тайтла.
   */
  async animeAction(req: YummyAnimeActionRequest): Promise<YummyAnimeActionResponse> {
    const bridge = getElectronBridge()
    if (bridge?.animeAction) return bridge.animeAction(req)
    try {
      const res = await jsonFetch('/api/yummy/action', {
        method: 'POST',
        body: JSON.stringify(req),
      })
      const body = (await res.json()) as YummyAnimeActionResponse
      return body
    } catch {
      return {
        ok: false,
        httpStatus: 0,
        verification: 'unconfirmed',
        state: null,
        message: 'Сервер недоступен — действие не выполнено',
      }
    }
  },

  /**
   * Прочитать своё состояние тайтла (список/избранное/оценка) для подсветки
   * на странице аниме. EXE — чтение в сессии сайта (main-процесс);
   * web — GET /api/yummy/anime-state (серверная сессия сайта).
   */
  async animeOwnState(slug: string): Promise<YummyAnimeOwnState | null> {
    const bridge = getElectronBridge()
    if (bridge?.readAnimeOwnState) {
      try {
        return await bridge.readAnimeOwnState(slug)
      } catch {
        return null
      }
    }
    try {
      const res = await jsonFetch(`/api/yummy/anime-state?slug=${encodeURIComponent(slug)}`)
      if (!res.ok) return null
      const body = (await res.json()) as { state: YummyAnimeOwnState | null }
      return body.state
    } catch {
      return null
    }
  },

  /** Диагностический selftest аутентификации (только EXE; web → null) */
  async authSelfTest(): Promise<YummyAuthSelfTestReport | null> {
    const bridge = getElectronBridge()
    if (!bridge) return null
    return bridge.runAuthSelfTest()
  },

  /** Сброс постоянной сессии сайта (backup + явное подтверждение в UI, секция 22) */
  async resetYummySession(): Promise<{ ok: boolean; backupPath: string | null; message: string } | null> {
    const bridge = getElectronBridge()
    if (!bridge) return null
    return bridge.resetYummySession()
  },

  /**
   * ПОЛНАЯ библиотека YummyAnime — списки статусов с сайта
   * (Смотрю/В Планах/Просмотрено/Брошено/Отложено/Любимые).
   * EXE — чтение ВНУТРИ постоянной сессии main-процесса (IPC readLibrary):
   * серверная cookie-сессия Next.js в EXE отсутствует, поэтому web-маршрут
   * /api/yummy/library там всегда был «не вошёл» — это и был баг отчёта.
   * Web (превью) — GET /api/yummy/library (серверная сессия сайта).
   */
  async yummyLibrary(): Promise<YummyLibraryResult> {
    const bridge = getElectronBridge()
    if (bridge?.readLibrary) {
      try {
        return await bridge.readLibrary()
      } catch {
        // падение моста не маскируем фейковыми данными — честная причина ниже
      }
    }
    try {
      const res = await jsonFetch('/api/yummy/library')
      if (!res.ok) throw new Error(await readError(res))
      return (await res.json()) as YummyLibraryResult
    } catch (e) {
      return {
        available: false,
        lists: [],
        reason: e instanceof Error ? e.message : 'Не удалось загрузить библиотеку',
        lastSync: null,
      }
    }
  },

  /**
   * Локальный трекинг просмотра (БД приложения): что смотрели, на какой серии.
   * Работает и без входа на сайт (accountKey='anon').
   */
  async watchProgressList(accountKey: string): Promise<WatchProgressResult> {
    try {
      const res = await jsonFetch(
        `/api/watch-progress?accountKey=${encodeURIComponent(accountKey)}`,
      )
      if (!res.ok) throw new Error(await readError(res))
      return (await res.json()) as WatchProgressResult
    } catch {
      return { available: false, items: [], reason: 'Не удалось загрузить прогресс' }
    }
  },

  /** Сохранить/обновить прогресс просмотра (fire-and-forget; ошибки молча). */
  async watchProgressSave(entry: {
    accountKey: string
    animeId: number
    slug?: string
    title: string
    poster?: string | null
    episode?: number | null
    episodesTotal?: number | null
    dubbing?: string | null
  }): Promise<void> {
    try {
      await jsonFetch('/api/watch-progress', {
        method: 'POST',
        body: JSON.stringify(entry),
        keepalive: true,
      })
    } catch {
      /* прогресс — вспомогательные данные: не мешаем просмотру */
    }
  },

  /** Удалить запись прогресса (одно аниме или всё) */
  async watchProgressDelete(accountKey: string, animeId?: number): Promise<boolean> {
    try {
      const q = new URLSearchParams({ accountKey })
      if (animeId !== undefined) q.set('animeId', String(animeId))
      const res = await jsonFetch(`/api/watch-progress?${q.toString()}`, { method: 'DELETE' })
      return res.ok
    } catch {
      return false
    }
  },

  /** Пользовательские отметки таймкодов (Skip Segments P3) — все или по тайтлу */
  async skipMarksList(accountKey: string, animeId?: number): Promise<SkipMarkRow[]> {
    try {
      const q = new URLSearchParams({ accountKey })
      if (animeId !== undefined) q.set('animeId', String(animeId))
      const res = await jsonFetch(`/api/skip-marks?${q.toString()}`)
      if (!res.ok) return []
      const body = (await res.json()) as { marks?: SkipMarkRow[] }
      return body.marks ?? []
    } catch {
      return []
    }
  },

  /** Сохранить границу отметки (upsert мержит: старая граница не затирается) */
  async skipMarkSave(req: {
    accountKey: string
    animeId: number
    dubbing?: string | null
    type: 'op' | 'ed' | 'recap'
    startSec?: number | null
    endSec?: number | null
  }): Promise<boolean> {
    try {
      const res = await jsonFetch('/api/skip-marks', {
        method: 'POST',
        body: JSON.stringify(req),
      })
      return res.ok
    } catch {
      return false
    }
  },

  /** Удалить отметку (по тайтлу+типу) или очистить все отметки аккаунта */
  async skipMarksDelete(accountKey: string, animeId?: number, type?: string): Promise<boolean> {
    try {
      const q = new URLSearchParams({ accountKey })
      if (animeId !== undefined) q.set('animeId', String(animeId))
      if (type) q.set('type', type)
      const res = await jsonFetch(`/api/skip-marks?${q.toString()}`, { method: 'DELETE' })
      return res.ok
    } catch {
      return false
    }
  },

  /** Пользовательские алиасы озвучек (глобальные) */
  async aliases(): Promise<VoiceAliasRow[]> {
    const res = await jsonFetch('/api/aliases')
    if (!res.ok) throw new Error(await readError(res))
    const body = (await res.json()) as { aliases?: VoiceAliasRow[] }
    return body.aliases ?? []
  },

  /** Добавить алиас озвучки. */
  async addAlias(
    targetName: string,
    alias: string,
    targetType: string = 'voice',
  ): Promise<VoiceAliasRow> {
    const res = await jsonFetch('/api/aliases', {
      method: 'POST',
      body: JSON.stringify({ targetType, targetName, alias }),
    })
    if (!res.ok) throw new Error(await readError(res))
    const body = (await res.json()) as { alias: VoiceAliasRow }
    return body.alias
  },

  /** Удалить алиас по id. */
  async deleteAlias(id: string): Promise<boolean> {
    try {
      const res = await jsonFetch(`/api/aliases?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      return res.ok
    } catch {
      return false
    }
  },
}
