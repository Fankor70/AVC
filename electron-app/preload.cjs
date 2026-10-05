/**
 * AVC-Anime preload — безопасный мост между Next.js UI и главным процессом.
 *
 * ПРИНЦИПЫ (спецификация, секция 15):
 *   - наружу выставлены ТОЛЬКО методы высокого уровня, возвращающие
 *     НЕ-секретные данные (снимки аккаунта, избранное, отчёты диагностики);
 *   - никаких ipcRenderer, webContents, cookies наружу;
 *   - cookie/пароли/токены через мост не проходят никогда.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('avcElectron', {
  platform: 'electron',

  /** Состояние аккаунта (не-секретный снимок) */
  getAccountState: (refresh) => ipcRenderer.invoke('avc:auth:getState', { refresh: !!refresh }),

  /** Открыть окно входа на реальный сайт; резолв после закрытия окна */
  openLoginWindow: () => ipcRenderer.invoke('avc:auth:open-login'),

  /** Принудительная проверка аутентификации через сайт */
  verifyAuthentication: () => ipcRenderer.invoke('avc:auth:verify'),

  /** Выход ЧЕРЕЗ САЙТ + подтверждение состояния */
  logout: () => ipcRenderer.invoke('avc:auth:logout'),

  /** Избранное с сайта (данные сессии main-процесса, без секретов) */
  getFavorites: (refresh) => ipcRenderer.invoke('avc:auth:favorites', { refresh: !!refresh }),

  /**
   * ПОЛНАЯ библиотека сайта (Смотрю/В Планах/Просмотрено/Брошено/Любимые/Отложено).
   * Читается ВНУТРИ постоянной сессии main-процесса; наружу — только не-секретные
   * списки тайтлов с сайта (то же доверие, что и у самого сайта).
   */
  readLibrary: (refresh) => ipcRenderer.invoke('avc:anime:library', { refresh: !!refresh }),

  /** Сброс постоянной сессии (backup + подтверждение в main) */
  resetYummySession: () => ipcRenderer.invoke('avc:auth:reset-session', { confirmed: true }),

  /** Диагностический selftest (безопасный отчёт) */
  runAuthSelfTest: () => ipcRenderer.invoke('avc:auth:selftest'),

  /**
   * РЕАЛЬНОЕ действие аккаунта ВНУТРИ сессии сайта (список/оценка/избранное).
   * Выполняется same-origin в main-процессе; наружу — только не-секретный
   * результат { ok, httpStatus, verification, state, message }.
   */
  animeAction: (req) => ipcRenderer.invoke('avc:anime:action', req),

  /**
   * Прочитать своё состояние тайтла (список/избранное/оценка) внутри сессии
   * сайта — подсветка активного статуса/сердца/оценки на странице аниме.
   * Наружу — только не-секретное состояние { listId, isFavorite, rating }.
   */
  readAnimeOwnState: (slug) => ipcRenderer.invoke('avc:anime:own-state', slug),

  /** Подписка на изменения состояния аккаунта (вход/выход/истечение) */
  onAccountChanged: (cb) => {
    const handler = (_event, snap) => cb(snap)
    ipcRenderer.on('avc:account-changed', handler)
    return () => ipcRenderer.removeListener('avc:account-changed', handler)
  },

  /** Подписка на статусы входа (капча/ошибка/успех) для toast-сообщений */
  onAuthStatus: (cb) => {
    const handler = (_event, msg) => cb(msg)
    ipcRenderer.on('avc:auth-status', handler)
    return () => ipcRenderer.removeListener('avc:auth-status', handler)
  },

  // ---------------------------------------------------------------------------
  // ЛОКАЛЬНЫЙ AI-СЛОЙ (спецификация §4–§134). Наружу — только не-секретные данные:
  // статусы моделей, прогресс загрузок, события STT, WAV-пути TTS, JSON команд LLM.
  // ---------------------------------------------------------------------------
  ai: {
    /** Доступен ли AI-слой в этом EXE (пакеты/нативные рантаймы установлены) */
    available: true,

    /** Общий статус: модели, сервисы (ready), метрики, голоса */
    getStatus: () => ipcRenderer.invoke('avc:ai:status'),

    /** Аппаратная информация для AI Setup (§50): CPU/RAM/диск/GPU */
    getHardware: () => ipcRenderer.invoke('avc:ai:hardware'),

    /** Установка компонентов (§52): keys ⊂ ['stt','vad','tts','llm'] */
    install: (keys, voiceId) => ipcRenderer.invoke('avc:ai:install', { keys, voiceId }),

    /** Отмена текущей загрузки (§57) */
    cancelInstall: (key) => ipcRenderer.invoke('avc:ai:cancel-install', { key }),

    /** Незавершённые загрузки после перезапуска (§128) */
    recover: () => ipcRenderer.invoke('avc:ai:recover'),

    /** Включение/выключение AI-слоя целиком */
    setEnabled: (enabled) => ipcRenderer.invoke('avc:ai:set-enabled', { enabled }),

    /** Профиль производительности (§19): max_responsiveness | balanced | quality */
    setProfile: (profile) => ipcRenderer.invoke('avc:ai:set-profile', { profile }),

    // УРОК РЕЛИЗА 1.0.12: llmRoute/ttsSpeak/ttsCancel/setVoice удалены вместе
    // со слоями LLM/TTS — по решению владельца они не нужны в релизах

    /** Повторная инициализация сервисов после установки моделей */
    initialize: () => ipcRenderer.invoke('avc:ai:initialize'),

    /**
     * Подача аудио в локальный STT (§6, §8): Int16Array, 16 кГц mono.
     * События распознавания приходят через onSttPartial/onSttFinal.
     */
    feedAudio: (int16Samples) => ipcRenderer.invoke('avc:ai:stt-feed', { samples: int16Samples }),

    /** Принудительное завершение текущей фразы (push-to-talk отпустили) */
    flushStt: () => ipcRenderer.invoke('avc:ai:stt-flush'),
    /** Режим рации: аудио при удержании PTT без VAD-гейта (детерминированный PTT) */
    setCaptureMode: (enabled) => ipcRenderer.invoke('avc:ai:stt-capture', { enabled }),

    /** Частичная транскрипция { utteranceId, text, ms, earlyCommand? } (§11–§12) */
    onSttPartial: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('avc:ai:stt-partial', handler)
      return () => ipcRenderer.removeListener('avc:ai:stt-partial', handler)
    },

    /** Финальная транскрипция { utteranceId, text, ms, earlyCommandType? } (§14 — дедупликация) */
    onSttFinal: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('avc:ai:stt-final', handler)
      return () => ipcRenderer.removeListener('avc:ai:stt-final', handler)
    },

    /** Прогресс загрузки моделей (§56) */
    onModelProgress: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('avc:ai:model-progress', handler)
      return () => ipcRenderer.removeListener('avc:ai:model-progress', handler)
    },

    /** Статусы инициализации сервисов после старта */
    onServicesStatus: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('avc:ai:services-status', handler)
      return () => ipcRenderer.removeListener('avc:ai:services-status', handler)
    },

    // --- Каталог AI-моделей (фаза 5 аудита): выбор/миграция/открытие ---

    /** Текущий каталог моделей + конфиг (не-секретные пути) */
    getModelsDirConfig: () => ipcRenderer.invoke('avc:ai:models:get-config'),

    /** Системный диалог выбора папки (возвращает абсолютный путь или null) */
    pickModelsDir: () => ipcRenderer.invoke('avc:ai:models:pick-dir'),

    /**
     * Безопасная смена каталога: валидация → место → копирование → сверка →
     * конфиг → рестарт AI-воркера. Старый каталог не удаляется.
     */
    setModelsDir: (dir) => ipcRenderer.invoke('avc:ai:models:set-dir', { dir }),

    /** Открыть каталог моделей в системном проводнике */
    openModelsDir: () => ipcRenderer.invoke('avc:ai:models:open-dir'),

    /** Каталог моделей STT: статусы/лицензии/рекомендации (спецификация STT) */
    catalog: () => ipcRenderer.invoke('avc:ai:catalog'),

    /** Бенчмарк «Проверить скорость на этом ПК»: RTF + рекомендация профиля */
    benchmark: () => ipcRenderer.invoke('avc:ai:benchmark'),

    /** Сменить активную модель STT (движок заменяется целиком; сохраняется в конфиг) */
    setSttModel: (modelId) => ipcRenderer.invoke('avc:ai:set-stt-model', { modelId }),

    /** Удалить модель каталога */
    removeComponent: (key) => ipcRenderer.invoke('avc:ai:remove-component', { key }),

    /** Проверить установленную модель (файлы/маркер) */
    verifyComponent: (key) => ipcRenderer.invoke('avc:ai:verify-component', { key }),

    /** Ручной перезапуск AI-воркера (кнопка в Настройках → AI) */
    restartWorker: () => ipcRenderer.invoke('avc:ai:restart-worker'),

    /** Открыть папку с логами (диагностика без поддержки) */
    openLogsFolder: () => ipcRenderer.invoke('avc:ai:open-logs'),

    /** Диагностика владельца: версия/пути/состояние воркера */
    getAppInfo: () => ipcRenderer.invoke('avc:debug:appinfo'),
    /** Хвост лога приложения */
    readDebugLogs: (lines) => ipcRenderer.invoke('avc:debug:logs', { lines }),

    /** Подписка на состояние AI-воркера (запущен/упал + честная причина) */
    onWorkerState: (cb) => {
      const handler = (_event, payload) => cb(payload)
      ipcRenderer.on('avc:ai:worker-state', handler)
      return () => ipcRenderer.removeListener('avc:ai:worker-state', handler)
    },
  },

  // --- ОБНОВЛЕНИЕ ПРИЛОЖЕНИЯ: ВЕРХНИЙ уровень моста (НЕ внутри ai) -------------
  // УРОК РЕЛИЗА 1.0.16: эти методы находились внутри ai.* — а UI вызывал их
  // на верхнем уровне (bridge.checkUpdate === undefined) → кнопка всегда
  // проваливалась в web-ветку и СКАЧИВАЛА EXE даже без обновления.
  /** Проверить обновление (GitHub releases/latest vs встроенная версия; сверка в main) */
  checkUpdate: () => ipcRenderer.invoke('avc:update:check'),
  /** Скачать и установить обновление (main сам повторно сверяет версии + SHA-256) */
  installUpdate: () => ipcRenderer.invoke('avc:update:install'),
  /** Прогресс обновления (фазы: checking/downloading/verifying/preparing/restarting/error) */
  onUpdateProgress: (cb) => {
    const handler = (_event, payload) => cb(payload)
    ipcRenderer.on('avc:update:progress', handler)
    return () => ipcRenderer.removeListener('avc:update:progress', handler)
  },
  /** Итог прошлого обновления после перезапуска (успех/не завершилось — §3.12) */
  onUpdateResult: (cb) => {
    const handler = (_event, payload) => cb(payload)
    ipcRenderer.on('avc:update:result', handler)
    return () => ipcRenderer.removeListener('avc:update:result', handler)
  },
})
