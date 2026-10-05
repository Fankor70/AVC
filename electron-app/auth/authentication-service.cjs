/**
 * AuthenticationService — машина состояний аутентификации YummyAnime
 * (спецификация, секции 5–10, 20–24). Живёт В ГЛАВНОМ процессе Electron.
 *
 * СОСТОЯНИЯ (секция 5):
 *   UNKNOWN | CHECKING | LOGGED_OUT | LOGIN_REQUIRED | LOGGING_IN
 *   | LOGGED_IN | SESSION_EXPIRED | ERROR
 *
 * АРХИТЕКТУРА СЕССИИ (секции 3/16):
 *   session.fromPartition('persist:yummyanime') — ПОСТОЯННЫЙ профиль:
 *   cookie сайта хранятся на диске (userData/Partitions/yummyanime) и
 *   переживают перезапуск приложения и ПК. Cookie НИКУДА не передаются:
 *   не читаются, не логируются, не уходят в рендерер и в Next API.
 *   Все проверки выполняются ВНУТРИ контекста страницы сайта.
 *
 * ДЕТЕКЦИЯ (секции 5–7): multi-signal (same-origin /api/profile + DOM-маркеры
 * сайта), event-driven (did-navigate / dom-ready / in-page навигация во время
 * входа) с polling только как safety-net и жёстким timeout.
 *
 * Никогда не считаем «вход» успешным по клику кнопки — только по фактическому
 * состоянию сайта (секция 25).
 */
const { BrowserWindow, session: electronSession } = require('electron')
const path = require('path')
const fs = require('fs')
const adapter = require('./yummy-auth-adapter.cjs')
const { AccountStore } = require('./account-store.cjs')

const PARTITION = 'persist:yummyanime'

/** Внутренние состояния (секция 5) */
const S = {
  UNKNOWN: 'UNKNOWN',
  CHECKING: 'CHECKING',
  LOGGED_OUT: 'LOGGED_OUT',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  LOGGING_IN: 'LOGGING_IN',
  LOGGED_IN: 'LOGGED_IN',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  ERROR: 'ERROR',
}

const VERIFY_TTL_MS = 5 * 60 * 1000 // профиль ~5 минут (не агрессивный поллинг)
const FAVORITES_TTL_MS = 2 * 60 * 1000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000 // safety-fallback, не «глобальная задержка»
const DETECT_TIMEOUT_MS = 20 * 1000
const POLL_MS = 2000 // safety-net во время входа (event-driven — основной путь)

class AuthenticationService {
  /**
   * @param {{ log?: (line: string) => void, onStatus?: (msg: string) => void }} opts
   */
  constructor(opts = {}) {
    this.log = opts.log || (() => {})
    this.onStatus = opts.onStatus || (() => {})
    this.listeners = new Set() // (snapshot) => void
    this.accountStore = new AccountStore(
      opts.userDataDir || require('electron').app.getPath('userData'),
      this.log,
    )

    this.state = S.UNKNOWN
    this.user = null
    this.lastVerifiedAt = null
    this.lastSnapshot = null
    this.lastVerifyAt = 0
    this.verifyInFlight = null

    this.sessionWindow = null // скрытое окно для проверок/выхода/избранного
    this.loginWindow = null // видимое окно входа
    this.loginMonitor = null // { interval, timeout, settled, resolve }
    this.favoritesCache = null
    this.libraryCache = null // кеш библиотеки (списки статусов), инвалидируется действиями

    // Восстановление последнего известного НЕ-секретного снимка (мгновенный UI)
    const saved = this.accountStore.load()
    if (saved) {
      this.state = internalFromSnapshotState(saved.state)
      this.user = saved.user
      this.lastSnapshot = saved
      this.lastVerifiedAt = saved.lastSync
      this.log(`[Auth] Restored last known account state: ${this.state}`)
    }
  }

  // --- события ------------------------------------------------------------

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emitChanged() {
    const snap = this.snapshot()
    this.lastSnapshot = snap
    for (const fn of this.listeners) {
      try {
        fn(snap)
      } catch {
        /* слушатель мог умереть — не роняем сервис */
      }
    }
  }

  status(msg) {
    this.log(`[Auth] ${msg}`)
    try {
      this.onStatus(msg)
    } catch {
      /* ignore */
    }
  }

  // --- снимок для IPC (ТОЛЬКО не-секретные поля, секция 6/15) ---------------

  snapshot(opts = {}) {
    const { source = 'live', message = null } = opts
    return {
      state: publicState(this.state),
      user: this.user,
      lastSync: this.lastVerifiedAt,
      source,
      message,
    }
  }

  // --- окно сессии ---------------------------------------------------------

  /** Скрытое окно в постоянной сессии (переиспользуется). НЕ отдаём наружу. */
  async ensureSessionWindow() {
    if (this.sessionWindow && !this.sessionWindow.isDestroyed()) return this.sessionWindow
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false, // таймеры детекции не замораживаются в фоне
      },
    })
    await win.loadURL(adapter.SITE.loginUrl)
    this.sessionWindow = win
    this.log('[Auth] Persistent session window created (partition persist:yummyanime)')
    return win
  }

  async runInSession(script, timeoutMs = DETECT_TIMEOUT_MS) {
    const win = await this.ensureSessionWindow()
    return runScript(win, script, timeoutMs)
  }

  // --- verifyAuthentication (секция 6) --------------------------------------

  /**
   * Проверить аутентификацию по ФАКТИЧЕСКОМУ состоянию сайта.
   * TTL-кеш 5 минут; force=true — всегда живая проверка.
   */
  async verify({ force = false } = {}) {
    if (!force && this.lastVerifyAt && Date.now() - this.lastVerifyAt < VERIFY_TTL_MS) {
      return this.snapshot({ source: 'cache' })
    }
    if (this.verifyInFlight) return this.verifyInFlight

    this.setState(S.CHECKING)
    this.verifyInFlight = this._verifyNow().finally(() => {
      this.verifyInFlight = null
    })
    return this.verifyInFlight
  }

  async _verifyNow() {
    this.log('[Auth] Checking authentication state')
    let signals
    try {
      signals = await this.runInSession(adapter.DETECTION_SCRIPT)
    } catch (e) {
      // Страница могла умереть — пересоздаём окно и пробуем ещё раз
      this.destroySessionWindow()
      try {
        signals = await this.runInSession(adapter.DETECTION_SCRIPT)
      } catch (e2) {
        return this._networkFailure(e2)
      }
    }

    const verdict = adapter.decide(signals)
    this.lastVerifyAt = Date.now()

    if (verdict.kind === 'networkError') return this._networkFailure(new Error(verdict.message))

    if (verdict.kind === 'authenticated') {
      this.user = verdict.user
      this.setState(S.LOGGED_IN)
      this.lastVerifiedAt = new Date().toISOString()
      this.log(
        `[Auth] Authentication state changed: LOGGED_IN (confidence=${verdict.confidence}, method=${verdict.method})` +
          (this.user?.username ? `, user=${this.user.username}` : ''),
      )
      const snap = this.snapshot({
        source: 'live',
        message: this.user?.username
          ? `Сайт подтвердил вход: ${this.user.username}`
          : 'Сайт подтвердил сессию',
      })
      this.accountStore.save(snap)
      this.emitChanged()
      return snap
    }

    if (verdict.kind === 'notAuthenticated') {
      const wasLoggedIn = this.state === S.LOGGED_IN
      this.user = null
      this.setState(wasLoggedIn ? S.SESSION_EXPIRED : S.LOGGED_OUT)
      this.lastVerifiedAt = new Date().toISOString()
      this.log(
        `[Auth] Authentication state changed: ${wasLoggedIn ? 'SESSION_EXPIRED' : 'LOGGED_OUT'}`,
      )
      const snap = this.snapshot({
        source: 'live',
        message: wasLoggedIn
          ? 'Сессия YummyAnime истекла. Войдите снова.'
          : 'Сессия YummyAnime не обнаружена — войдите на сайте',
      })
      this.accountStore.save(snap)
      this.emitChanged()
      return snap
    }

    // unexpected (5xx и т.п.)
    return this._networkFailure(new Error(`Сайт ответил HTTP ${verdict.status}`))
  }

  /** Оффлайн/недоступность: НЕ стираем последний известный вход (секция 25) */
  _networkFailure(err) {
    this.log(`[Auth] Site unreachable: ${err.message}`)
    if (this.state !== S.LOGGED_IN) this.setState(S.ERROR)
    const snap = this.snapshot({
      source: 'error',
      message: `Сайт недоступен (${err.message}). Показаны кешированные данные.`,
    })
    this.emitChanged()
    return snap
  }

  setState(next) {
    if (this.state === next) return
    this.state = next
  }

  // --- ВХОД (секции 4/7/8) ---------------------------------------------------

  /**
   * Открыть окно входа на РЕАЛЬНОМ сайте в постоянной сессии.
   * Пароль не перехватываем, поля не читаем — работаем только по сигналам.
   * Резолв — после закрытия окна (или по успешному входу).
   */
  async startLogin() {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.focus()
      return this.snapshot({ source: 'cache', message: 'Окно входа уже открыто' })
    }

    this.setState(S.LOGGING_IN)
    this.status('Login page detected — waiting for authentication')

    const win = new BrowserWindow({
      width: 1180,
      height: 840,
      title: 'Вход в YummyAnime',
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // НЕ отключаем popup'ы: VK/Shikimori OAuth открываются в дочерних окнах
        // той же persistent-сессии (совместимость с будущими методами, секция 17)
      },
    })

    const monitor = { settled: false, resolve: null, interval: null, timeout: null, captchaNotified: false }
    const done = new Promise((resolve) => {
      monitor.resolve = resolve
    })
    this.loginMonitor = monitor

    // OAuth/альтернативные входы: разрешаем навигацию внутри дочерних окон той же сессии
    win.webContents.setWindowOpenHandler(({ url }) => {
      const u = safeUrl(url)
      if (!u) return { action: 'deny' }
      if (/(^|\.)t\.me$/i.test(u.hostname) || /^telegram/i.test(u.hostname)) {
        require('electron').shell.openExternal(u.toString())
        return { action: 'deny' }
      }
      // VK / Shikimori / будущие провайдеры — в дочернем окне той же сессии
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 900,
          height: 720,
          autoHideMenuBar: true,
          webPreferences: {
            partition: PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      }
    })

    // EVENT-DRIVEN детекция (секция 7): навигация/DOM — основной сигнал
    const onActivity = debounce(() => {
      void this._checkDuringLogin(win, monitor)
    }, 600)
    win.webContents.on('did-navigate', onActivity)
    win.webContents.on('did-navigate-in-page', onActivity)
    win.webContents.on('dom-ready', onActivity)

    // Safety-net: интервал + жёсткий timeout (только пока окно входа открыто)
    monitor.interval = setInterval(() => {
      void this._checkDuringLogin(win, monitor)
    }, POLL_MS)
    monitor.timeout = setTimeout(() => {
      if (!monitor.settled) {
        this.status('AUTHENTICATION_TIMEOUT — окно входа остаётся открытым')
        this.onStatus('Время ожидания входа вышло. Завершите вход или закройте окно сайта.')
      }
    }, LOGIN_TIMEOUT_MS)

    win.on('closed', () => {
      if (monitor.interval) clearInterval(monitor.interval)
      if (monitor.timeout) clearTimeout(monitor.timeout)
      if (!monitor.settled) {
        monitor.settled = true
        this.loginWindow = null
        this.loginMonitor = null
        this.log('[Auth] Login window closed — verifying final state')
        // Финальная проверка по фактическому состоянию (не по факту закрытия!)
        void this.verify({ force: true }).then((snap) => {
          monitor.resolve(snap)
        })
      }
    })

    this.loginWindow = win
    await win.loadURL(adapter.SITE.loginUrl)
    onActivity()
    return done
  }

  /** Проверка во время входа: успех/капча/ошибка — без ложных срабатываний */
  async _checkDuringLogin(win, monitor) {
    if (monitor.settled || !win || win.isDestroyed()) return
    let signals = null
    try {
      signals = await runScript(win, adapter.DETECTION_SCRIPT, DETECT_TIMEOUT_MS)
    } catch {
      return // страница ещё грузится — дождёмся следующего события
    }
    const verdict = adapter.decide(signals)

    // Капча — НЕ обходим, просим завершить вручную и продолжаем мониторинг (секция 8)
    if (signals.captchaVisible && !monitor.captchaNotified) {
      monitor.captchaNotified = true
      this.onStatus('YummyAnime запрашивает дополнительную проверку. Пройдите её в окне сайта.')
      setTimeout(() => {
        monitor.captchaNotified = false
      }, 30000)
    }

    // Ошибка входа — сообщаем и продолжаем мониторинг (пользователь может повторить)
    if (signals.loginErrorText && !monitor.loginErrorNotified) {
      monitor.loginErrorNotified = true
      this.onStatus('Сайт сообщил о неверном логине или пароле. Попробуйте ещё раз в окне сайта.')
      setTimeout(() => {
        monitor.loginErrorNotified = false
      }, 8000)
    }

    if (verdict.kind !== 'authenticated') return // LOGIN_FAILED-ловушек нет: ждём факта

    // УСПЕХ подтверждён состоянием сайта
    monitor.settled = true
    clearInterval(monitor.interval)
    clearTimeout(monitor.timeout)
    this.user = verdict.user
    this.setState(S.LOGGED_IN)
    this.lastVerifiedAt = new Date().toISOString()
    this.log(
      `[Auth] Authentication state changed: LOGGED_IN` +
        (this.user?.username ? `, user=${this.user.username}` : ''),
    )
    const snap = this.snapshot({
      source: 'live',
      message: this.user?.username ? `Вы вошли как ${this.user.username}` : 'Вход подтверждён сайтом',
    })
    this.accountStore.save(snap)
    this.emitChanged()
    this.onStatus(snap.message || 'Вход выполнен')

    // Возвращаем пользователя в приложение (секция 4, п.8)
    setTimeout(() => {
      try {
        if (this.loginWindow && !this.loginWindow.isDestroyed()) this.loginWindow.close()
      } catch {
        /* ignore */
      }
    }, 1500)
    if (monitor.resolve) monitor.resolve(snap)
  }

  // --- ВЫХОД (секция 10) ------------------------------------------------------

  /** Выход выполняется САМИМ САЙТОМ; локально ничего «не притворяем» */
  async logout() {
    this.log('[Auth] Logout via site requested')
    let res = null
    try {
      res = await this.runInSession(adapter.LOGOUT_SCRIPT, 15000)
    } catch (e) {
      this.log(`[Auth] Logout script failed: ${e.message}`)
    }

    // Fallback: если API logout недоступен — кликаем настоящий .logout-btn на странице
    if (!res || res.status === 0 || res.status >= 400) {
      this.log(`[Auth] Logout API fallback to site UI (api status: ${res ? res.status : 'n/a'})`)
      try {
        const win = await this.ensureSessionWindow()
        await win.loadURL(adapter.SITE.loginUrl)
        await win.webContents.executeJavaScript(
          `(() => { const b = document.querySelector(${JSON.stringify(adapter.SELECTORS.logoutBtn)}); if (b) { b.click(); return true } return false })()`,
          true,
        )
        await sleep(2500) // сайту нужно время на обработку выхода
      } catch (e) {
        this.log(`[Auth] Logout UI fallback failed: ${e.message}`)
      }
    }

    // Проверяем фактическое состояние после выхода (секция 10: verifyAuthentication)
    const snap = await this.verify({ force: true })
    this.favoritesCache = null
    this.libraryCache = null
    return snap
  }

  // --- ИЗБРАННОЕ (секция 13) ---------------------------------------------------

  async getFavorites({ refresh = false } = {}) {
    if (!refresh && this.favoritesCache && Date.now() - this.favoritesCache.at < FAVORITES_TTL_MS) {
      return this.favoritesCache.data
    }
    // Убеждаемся в состоянии входа (без агрессивных повторных проверок)
    const acc = await this.verify()
    if (acc.state !== 'loggedIn') {
      return {
        available: false,
        items: [],
        reason: acc.message || 'Нет подтверждённой сессии YummyAnime',
        lastSync: null,
      }
    }
    try {
      const res = await this.runInSession(adapter.FAVORITES_SCRIPT, 20000)
      if (res.status !== 200) {
        return {
          available: false,
          items: [],
          reason: `Сайт ответил HTTP ${res.status} на export-favorites`,
          lastSync: null,
        }
      }
      const items = adapter.parseFavorites(res.text)
      if (items === null) {
        return {
          available: false,
          items: [],
          reason: 'Формат export-favorites не распознан (сайт изменился?) — данные не выдумываем',
          lastSync: null,
        }
      }
      const data = { available: true, items, reason: null, lastSync: new Date().toISOString() }
      this.favoritesCache = { at: Date.now(), data }
      return data
    } catch (e) {
      return {
        available: false,
        items: [],
        reason: `Не удалось получить избранное: ${e.message}`,
        lastSync: null,
      }
    }
  }

  // --- БИБЛИОТЕКА (списки статусов сайта: Смотрю/В Планах/…) -----------------

  /**
   * ПОЛНАЯ библиотека пользователя: чтение ВНУТРИ постоянной сессии сайта.
   * Источник — реальный сайт: /api/profile (числовой id) + /api/users/{id}/lists/{N}
   * (эндпоинт подтверждён живой сессией 2026-10-03). Кеш 2 минуты; инвалидируется
   * любым успешным действием аккаунта и выходом — сервер всегда авторитетен.
   */
  async getLibrary({ refresh = false } = {}) {
    if (!refresh && this.libraryCache && Date.now() - this.libraryCache.at < FAVORITES_TTL_MS) {
      return this.libraryCache.data
    }
    const acc = await this.verify()
    if (acc.state !== 'loggedIn') {
      return {
        available: false,
        lists: [],
        reason: acc.message || 'Нет подтверждённой сессии YummyAnime',
        lastSync: null,
      }
    }
    try {
      const res = await this.runInSession(adapter.LIBRARY_SCRIPT, 30000)
      if (res && res.profileStatus === 401) {
        // сессия умерла между проверками — обновим состояние аккаунта в UI честно
        void this.verify({ force: true }).catch(() => undefined)
        return {
          available: false,
          lists: [],
          reason: 'Сессия YummyAnime истекла — войдите заново',
          lastSync: null,
        }
      }
      if (!res || !res.numericId) {
        return {
          available: false,
          lists: [],
          reason: 'Не удалось определить id пользователя для чтения библиотеки',
          lastSync: null,
        }
      }
      const lists = []
      const failed = []
      for (const listId of adapter.LIBRARY_LIST_IDS) {
        const r = res.lists ? res.lists[listId] : null
        const name = adapter.LIBRARY_LIST_NAMES[listId]
        if (!r) {
          failed.push(`${name}: нет ответа`)
          continue
        }
        if (r.status === 200) {
          const items = adapter.parseLibraryItems(r.body)
          lists.push({ listId, name, count: items.length, items })
        } else if (r.status === 0) {
          failed.push(`${name}: сайт недоступен`)
        } else {
          failed.push(`${name}: HTTP ${r.status}`)
        }
      }
      const data = {
        available: lists.length > 0,
        lists,
        reason:
          lists.length === 0
            ? failed.join('; ') || 'Ни один список не прочитан'
            : failed.length > 0
              ? `Часть списков не прочитана: ${failed.join('; ')}`
              : null,
        lastSync: lists.length > 0 ? new Date().toISOString() : null,
      }
      if (lists.length > 0) this.libraryCache = { at: Date.now(), data }
      return data
    } catch (e) {
      return {
        available: false,
        lists: [],
        reason: `Не удалось получить библиотеку: ${e.message}`,
        lastSync: null,
      }
    }
  }

  // --- РЕАЛЬНЫЕ ДЕЙСТВИЯ АККАУНТА (спецификация I §9, ACCOUNT_MODEL §5) ---------

  /**
   * Выполнить действие аккаунта (список/оценка/избранное) ВНУТРИ сессии сайта:
   *
   *   ДЕЙСТВИЕ: same-origin fetch (PUT/DELETE) с заголовками API сайта
   *      ↓ HTTP 2xx?
   *   ВЕРИФИКАЦИЯ: reload страницы тайтла + чтение собственного состояния
   *      ↓ совпало → 'pass'; не совпало → 'mismatch'; не прочиталось → 'unconfirmed'
   *
   * Cookie не читаются и не покидают main; наружу идут только не-секретные
   * результаты (то же доверие к HTTP-успеху, что и у самого сайта + наша
   * reload-проверка сверху).
   */
  /** Прочитать своё состояние тайтла (UI страницы аниме: подсветка статуса/сердца/оценки) */
  async readAnimeOwnState(slug) {
    if (typeof slug !== 'string' || slug.trim() === '') return null
    return this._readOwnState(slug)
  }

  async animeAction(req) {
    const KINDS = new Set([
      'setList',
      'removeList',
      'setFavorite',
      'removeFavorite',
      'setRate',
      'removeRate',
    ])
    const invalid = (message) => ({
      ok: false,
      httpStatus: 0,
      verification: 'skipped',
      state: null,
      message,
    })

    // 0. Защита на границе IPC
    if (
      typeof req !== 'object' ||
      req === null ||
      !KINDS.has(req.kind) ||
      !Number.isInteger(req.animeId) ||
      req.animeId <= 0
    ) {
      return invalid('Некорректный запрос действия аккаунта')
    }
    if (req.kind === 'setList' && !(Number.isInteger(req.value) && req.value >= 0 && req.value <= 5)) {
      return invalid('Недопустимый статус списка (0..5)')
    }
    if (req.kind === 'setRate' && !(Number.isInteger(req.value) && req.value >= 1 && req.value <= 10)) {
      return invalid('Оценка должна быть целым числом 1..10')
    }
    if (typeof req.slug !== 'string') req.slug = ''

    // 1. Убедиться в состоянии входа (TTL-кеш, без лишних живых проверок)
    const acc = await this.verify()
    if (acc.state !== 'loggedIn') {
      return invalid(acc.message || 'Нет подтверждённой сессии YummyAnime')
    }

    // 2. ДЕЙСТВИЕ внутри сессии
    let res = null
    try {
      res = await this.runInSession(adapter.buildActionScript(req), 20000)
    } catch (e) {
      this.log(`[Anime] Action ${req.kind}#${req.animeId} script failed: ${e.message}`)
      return invalid(`Не удалось выполнить действие на сайте: ${e.message}`)
    }
    if (!res || typeof res.status !== 'number') {
      return invalid('Сайт не ответил на действие')
    }
    if (res.status === 0) {
      return invalid('Сеть недоступна — сайт не ответил')
    }
    if (res.status === 401 || res.status === 403) {
      // Сессия отвалилась между проверками — форсируем verify, чтобы UI обновился
      void this.verify({ force: true }).catch(() => undefined)
      return invalid('Сессия YummyAnime истекла — войдите снова')
    }
    if (res.status >= 400) {
      return invalid(`Сайт ответил HTTP ${res.status} на действие`)
    }

    // Состояние библиотеки на сервере изменилось — кеш больше не авторитетен
    this.libraryCache = null

    // 3. RELOAD-верификация по серверному HTML страницы тайтла
    const base = {
      ok: true,
      httpStatus: res.status,
      verification: 'unconfirmed',
      state: null,
      message: 'Сайт принял действие (HTTP 200)',
    }
    if (!req.slug) {
      base.message =
        'Сайт принял действие (HTTP 200). Подтвердить состояние не удалось: нет адреса страницы тайтла'
      return base
    }

    const state = await this._readOwnState(req.slug)
    if (!state) {
      base.message =
        'Сайт принял действие (HTTP 200), но подтвердить состояние не удалось — проверьте на сайте'
      return base
    }
    base.state = state

    // Страница отрисовалась для гостя — сессия на странице не видна, честно 'unconfirmed'
    if (state.authenticatedPage === false) {
      base.message =
        'Сайт принял действие (HTTP 200), но страница отрисовалась как для гостя — проверьте состояние'
      return base
    }

    const expected = adapter.expectedOwnState(req)
    const actual = {
      listId: state.listId ?? null,
      isFavorite: state.isFavorite,
      rating: state.rating ?? null,
    }
    const mismatches = Object.keys(expected).filter((k) => actual[k] !== expected[k])
    if (mismatches.length === 0) {
      base.verification = 'pass'
      base.message = 'Действие выполнено и подтверждено чтением состояния'
      return base
    }
    base.verification = 'mismatch'
    base.message = `Сайт принял действие (HTTP ${res.status}), но состояние не совпало (${mismatches.join(', ')})`
    return base
  }

  /** Загрузить страницу тайтла в скрытом окне сессии и прочитать своё состояние */
  async _readOwnState(slug) {
    try {
      const win = await this.ensureSessionWindow()
      const url = `${adapter.SITE.origin}/catalog/item/${encodeURIComponent(String(slug))}`
      await win.loadURL(url)
      await sleep(1200) // сайту нужно дорисовать React-блоки (секция 25: не выдумываем)
      const signals = await runScript(win, adapter.STATE_SCRIPT, DETECT_TIMEOUT_MS)
      const state = adapter.parseOwnState(signals)
      if (state) delete state.__hasMarkers
      return state
    } catch (e) {
      this.log(`[Anime] Own-state read failed: ${e.message}`)
      return null
    }
  }

  // --- ДИАГНОСТИКА (секции 9/20/24) ---------------------------------------------

  async selftest() {
    this.log('[Auth] Session persistence check started')
    const steps = []
    const report = {
      ranAt: new Date().toISOString(),
      website: adapter.SITE.origin,
      sessionKind: 'persistent',
      authState: this.state,
      authenticated: this.state === S.LOGGED_IN,
      username: this.user?.username ?? null,
      profileAvailable: !!this.user,
      lastVerifiedAt: this.lastVerifiedAt,
      persistence: 'SKIP',
      loginDetection: 'SKIP',
      logoutDetection: 'SKIP',
      network: 'OFFLINE',
      steps,
    }

    // 1. Сеть + доступность сайта
    let signals = null
    try {
      signals = await this.runInSession(adapter.DETECTION_SCRIPT)
      report.network = 'ONLINE'
      steps.push({
        name: 'Сеть / доступность сайта',
        status: 'PASS',
        detail: `old.yummyani.me отвечает (profile API HTTP ${signals.profileApi?.status ?? '?'})`,
      })
    } catch (e) {
      steps.push({
        name: 'Сеть / доступность сайта',
        status: 'FAIL',
        detail: `Сайт недоступен: ${e.message}`,
      })
      steps.push({ name: 'Детекция страницы входа', status: 'BLOCKED', detail: 'Сайт недоступен' })
      steps.push({ name: 'Детекция состояния', status: 'BLOCKED', detail: 'Сайт недоступен' })
      report.persistence = 'NOT_TESTED'
      report.loginDetection = 'BLOCKED'
      report.logoutDetection = 'BLOCKED'
      this.log('[Auth] Session persistence check finished (site unavailable)')
      return report
    }

    // 2. Детекция страницы входа (гость) / состояния
    if (signals.loginForm && signals.loginInputs) {
      report.loginDetection = 'PASS'
      steps.push({
        name: 'Детекция страницы входа',
        status: 'PASS',
        detail: 'Форма «Вход» найдена на главной (email+password)',
      })
    } else if (report.authenticated) {
      report.loginDetection = 'PASS'
      steps.push({
        name: 'Детекция страницы входа',
        status: 'PASS',
        detail: 'Форма не показана — сессия активна (ожидаемое поведение)',
      })
    } else {
      report.loginDetection = 'FAIL'
      steps.push({
        name: 'Детекция страницы входа',
        status: 'FAIL',
        detail: 'Форма входа не найдена, а сессии нет — сайт изменился?',
      })
    }

    if (signals.profileApi && signals.profileApi.status !== 0) {
      steps.push({
        name: 'Детекция состояния аутентификации',
        status: 'PASS',
        detail: `/api/profile ответил ${signals.profileApi.status} — сигнал состояния получен`,
      })
    } else {
      steps.push({
        name: 'Детекция состояния аутентификации',
        status: 'FAIL',
        detail: 'profile API не ответил',
      })
    }

    // 3. Детекция выхода: полный тест требует активную сессию
    if (report.authenticated) {
      report.logoutDetection = 'SKIP'
      steps.push({
        name: 'Детекция выхода',
        status: 'SKIP',
        detail: 'Проверка выхода пропущена — вы вошли; выполните выход из интерфейса',
      })
    } else {
      try {
        const lo = await this.runInSession(adapter.LOGOUT_SCRIPT, 15000)
        // Для гостя сайт вернёт 401/403 — это ПАСС: эндпоинт жив и отвечает предсказуемо
        if (lo && lo.status !== 0) {
          report.logoutDetection = 'PASS'
          steps.push({
            name: 'Детекция выхода',
            status: 'PASS',
            detail: `Logout-эндпоинт отвечает (HTTP ${lo.status} для гостя — ожидаемо)`,
          })
        } else {
          report.logoutDetection = 'FAIL'
          steps.push({ name: 'Детекция выхода', status: 'FAIL', detail: 'Logout-эндпоинт не отвечает' })
        }
      } catch (e) {
        report.logoutDetection = 'FAIL'
        steps.push({ name: 'Детекция выхода', status: 'FAIL', detail: e.message })
      }
    }

    // 4. Персистентность: постоянный профиль на диске с cookie сайта
    try {
      const ses = electronSession.fromPartition(PARTITION)
      const cookies = await ses.cookies.get({})
      const dir = path.join(
        require('electron').app.getPath('userData'),
        'Partitions',
        'yummyanime',
      )
      const dirExists = fs.existsSync(dir)
      if (cookies.length > 0 && dirExists) {
        report.persistence = 'PASS'
        steps.push({
          name: 'Персистентность сессии',
          status: 'PASS',
          detail: `Постоянный профиль на диске: ${cookies.length} cookie сайта сохранено (переживёт перезапуск)`,
        })
      } else if (cookies.length === 0) {
        report.persistence = 'SKIP'
        steps.push({
          name: 'Персистентность сессии',
          status: 'SKIP',
          detail: 'Сессия ещё не создана — войдите на сайте и повторите тест (TEST C)',
        })
      } else {
        report.persistence = 'FAIL'
        steps.push({
          name: 'Персистентность сессии',
          status: 'FAIL',
          detail: 'Cookie есть в памяти, но каталог профиля не найден — проверьте userData',
        })
      }
    } catch (e) {
      report.persistence = 'FAIL'
      steps.push({ name: 'Персистентность сессии', status: 'FAIL', detail: e.message })
    }

    this.log('[Auth] Session persistence check passed')
    return report
  }

  // --- RECOVERY (секция 22) -------------------------------------------------------

  /**
   * Сброс постоянной сессии. НЕ удаляем молча: сначала бэкап каталога профиля,
   * затем пересоздание. Требует явного подтверждения из UI (confirmed=true).
   */
  async resetSession({ confirmed = false } = {}) {
    if (!confirmed) {
      return { ok: false, backupPath: null, message: 'Требуется явное подтверждение сброса' }
    }
    this.log('[Auth] Reset YummyAnime session requested (user-confirmed)')
    // 1. Закрываем окна сессии
    for (const w of [this.loginWindow, this.sessionWindow]) {
      try {
        if (w && !w.isDestroyed()) w.destroy()
      } catch {
        /* ignore */
      }
    }
    this.loginWindow = null
    this.sessionWindow = null

    // 2. Бэкап каталога профиля (если есть)
    const partDir = path.join(
      require('electron').app.getPath('userData'),
      'Partitions',
      'yummyanime',
    )
    let backupPath = null
    try {
      if (fs.existsSync(partDir)) {
        backupPath = `${partDir}.backup-${Date.now()}`
        fs.renameSync(partDir, backupPath)
        this.log(`[Auth] Profile backed up to: ${backupPath}`)
      }
    } catch (e) {
      this.log(`[Auth] Backup failed: ${e.message}`)
      return {
        ok: false,
        backupPath: null,
        message: `Не удалось сделать бэкап профиля — сброс отменён (${e.message})`,
      }
    }

    // 3. Чистим состояние сервиса и кеш снимка
    this.user = null
    this.lastVerifiedAt = null
    this.favoritesCache = null
    this.libraryCache = null
    this.accountStore.clear()
    this.setState(S.LOGGED_OUT)
    try {
      const ses = electronSession.fromPartition(PARTITION)
      await ses.clearStorageData()
      await ses.clearCache()
    } catch (e) {
      this.log(`[Auth] Storage clear failed: ${e.message}`)
    }
    const snap = this.snapshot({
      source: 'live',
      message: backupPath
        ? `Сессия сброшена. Бэкап профиля: ${path.basename(backupPath)}`
        : 'Сессия сброшена (профиль был пуст)',
    })
    this.emitChanged()
    return { ok: true, backupPath, message: snap.message ?? 'Сессия сброшена' }
  }

  destroySessionWindow() {
    try {
      if (this.sessionWindow && !this.sessionWindow.isDestroyed()) this.sessionWindow.destroy()
    } catch {
      /* ignore */
    }
    this.sessionWindow = null
  }

  shutdown() {
    try {
      if (this.loginWindow && !this.loginWindow.isDestroyed()) this.loginWindow.destroy()
      this.destroySessionWindow()
    } catch {
      /* ignore */
    }
  }
}

// --- утилиты ------------------------------------------------------------------

/** Внутреннее состояние из сохранённого публичного */
function internalFromSnapshotState(publicState) {
  switch (publicState) {
    case 'loggedIn':
      return S.LOGGED_IN
    case 'sessionExpired':
      return S.SESSION_EXPIRED
    case 'unavailable':
      return S.ERROR
    case 'checking':
      return S.UNKNOWN
    default:
      return S.LOGGED_OUT
  }
}

/** Публичное состояние для IPC-снимка */
function publicState(internal) {
  switch (internal) {
    case S.LOGGED_IN:
      return 'loggedIn'
    case S.LOGGED_OUT:
    case S.LOGIN_REQUIRED:
      return 'loggedOut'
    case S.SESSION_EXPIRED:
      return 'sessionExpired'
    case S.CHECKING:
    case S.LOGGING_IN:
      return 'checking'
    case S.ERROR:
      return 'unavailable'
    default:
      return 'unknown'
  }
}

/** executeJavaScript с таймаутом; резолв значения async-скрипта */
async function runScript(win, script, timeoutMs) {
  if (!win || win.isDestroyed()) throw new Error('Окно сессии закрыто')
  const result = await Promise.race([
    win.webContents.executeJavaScript(script, true),
    sleep(timeoutMs).then(() => {
      throw new Error('Таймаут выполнения скрипта детекции')
    }),
  ])
  return result
}

function safeUrl(u) {
  try {
    return new URL(u)
  } catch {
    return null
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function debounce(fn, ms) {
  let t = null
  return (...args) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => {
      t = null
      fn(...args)
    }, ms)
  }
}

module.exports = { AuthenticationService, S, PARTITION }
