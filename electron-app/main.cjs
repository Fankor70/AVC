/**
 * AVC-Anime — Electron main process.
 *
 * РОЛИ:
 *   1. Владелец ПОСТОЯННОЙ браузерной сессии YummyAnime
 *      (partition 'persist:yummyanime' — cookie живут на диске в userData и
 *      переживают перезапуск приложения и ПК; спецификация, секция 3).
 *   2. Хост Next.js UI (packaged: standalone-сервер; dev: localhost:3000).
 *   3. IPC-шлюз аутентификации: рендерер получает ТОЛЬКО не-секретные снимки
 *      (cookie/пароли/токены никогда не пересекают границу — секция 15).
 *
 * РЕЖИМЫ ЗАПУСКА:
 *   electron .                 — обычное приложение
 *   electron . --auth-selftest — диагностический прогон (JSON-отчёт в stdout,
 *                                секции 9/20/24), окно UI не открывается
 */
const { app, BrowserWindow, ipcMain, session, shell, dialog } = require('electron')
const { spawn, fork: childFork } = require('child_process')
const childProcess = { fork: childFork }
const http = require('http')
const https = require('https')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { performance } = require('perf_hooks')
const { AuthenticationService, PARTITION } = require('./auth/authentication-service.cjs')

// --- режимы самопроверки (читаются reportFatal — объявлены ДО обработчиков) -----
const SELFTEST = process.argv.includes('--auth-selftest')
const AI_SELFTEST = process.argv.includes('--ai-selftest')
if (SELFTEST || AI_SELFTEST) {
  app.disableHardwareAcceleration()
}

// --- структурированный лог (секция 21): без секретов ---------------------------
// УРОК РЕЛИЗА 1.0.9 («Cannot access 'fileLogEnabled' before initialization»):
// раньше этот блок стоял НИЖЕ верхнеуровневого try/catch с require AI-пайплайна.
// В packaged-сборке тот require падал (ai/** лежит в extraResources, а НЕ в
// app.asar), catch вызывал log(), а переменные лога ещё не были инициализированы
// → ReferenceError из TDZ убивала запуск ещё до регистрации обработчика ошибок.
// Правило: лог объявлен ДО любого верхнеуровневого кода, который может его вызвать.
const LOG_MAX_BYTES = 512 * 1024
let logStream = null
// Ранний буфер: до app ready писать некуда (portable EXE не имеет консоли) —
// копим и дописываем в файл сразу после ready, чтобы не терять ошибки старта
const EARLY_LOG_LINES = []
let fileLogEnabled = false

function logFile() {
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'avc.log')
    try {
      const st = fs.statSync(file)
      if (st.size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`)
    } catch {
      /* файла могло не быть */
    }
    if (!logStream) logStream = fs.createWriteStream(file, { flags: 'a' })
    return logStream
  } catch {
    return null
  }
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`
  console.log(stamped)
  if (!fileLogEnabled) {
    EARLY_LOG_LINES.push(stamped)
    if (EARLY_LOG_LINES.length > 1500) EARLY_LOG_LINES.shift()
    return
  }
  const stream = logFile()
  if (stream) stream.write(`${stamped}\n`)
}

function flushEarlyLogs() {
  fileLogEnabled = true
  const stream = logFile()
  if (stream && EARLY_LOG_LINES.length) stream.write(`${EARLY_LOG_LINES.join('\n')}\n`)
  EARLY_LOG_LINES.length = 0
}

/** Редактирование секретов из любых диагностических строк (секция 15) */
function redact(text) {
  return String(text)
    .replace(/(cookie|token|authorization|password)=[^;\s"']+/gi, '$1=[REDACTED]')
    .replace(/PHPSESSID=[^;\s"']+/gi, 'PHPSESSID=[REDACTED]')
}

// --- изменяемое состояние приложения -------------------------------------------
// Инициализируется ДО регистрации обработчиков фатальных ошибок: reportFatal
// читает mainWindow/fatalPromise — они не должны встречаться в TDZ никогда.
let nextProcess = null
let mainWindow = null
let authService = null
let splashWindow = null
let fatalWindow = null
let fatalPromise = null
/** Результат незавершённого обновления (маркер update-pending.json) — для UI после перезапуска */
let pendingUpdateResult = null

// --- фатальные ошибки: обработчики регистрируем как можно раньше ----------------
process.on('uncaughtException', (err) => reportFatal(err, 'uncaughtException'))
process.on('unhandledRejection', (reason) => reportFatal(reason, 'unhandledRejection'))

// --- стартовая телеметрия (фаза 2 аудита: измеряем, а не «кажется быстрее») ---
// Монотонные метки от загрузки модуля до готового UI и готового AI; JSON-отчёт
// пишется в userData/logs/startup-report.json (для сравнения сборок до/после).
const START_T0 = performance.now()
const STARTUP_MARKS = [{ mark: 'main-module-loaded', ms: 0 }]
function markStartup(name) {
  STARTUP_MARKS.push({ mark: name, ms: Math.round(performance.now() - START_T0) })
  log(`[Startup] ${name}: +${STARTUP_MARKS[STARTUP_MARKS.length - 1].ms} мс`)
}
function writeStartupReport(extra = {}) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const report = {
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron,
      writtenAt: new Date().toISOString(),
      totalMs: Math.round(performance.now() - START_T0),
      marks: STARTUP_MARKS,
      ...extra,
    }
    fs.writeFileSync(path.join(dir, 'startup-report.json'), JSON.stringify(report, null, 2))
  } catch {
    /* телеметрия не должна ломать запуск */
  }
}

// Локальный AI-слой (спецификация §4–§134) живёт В ИЗОЛИРОВАННОМ воркере на чистом
// Node: startAiWorker() → resources/ai/ai-worker.cjs (packaged) | ai/ai-worker.cjs
// (dev), IPC-мост — setupAiIpc(). Прямой require('./ai/voice-pipeline.cjs') из main
// УДАЛЁН: (1) класс VoicePipeline в main нигде не использовался — мёртвый код;
// (2) в packaged-сборке ai/** НЕ входит в app.asar (electron-builder files), поэтому
// require падал всегда, а его catch-блок убивал запуск через TDZ-баг лога выше
// (урок релиза 1.0.9). Модульность сохранена: без моделей/воркера приложение
// продолжает работать (§0, §129) — статус честно отражается в UI.

// --- верификация результата обновления после перезапуска (§3.12) ----------------
// Маркер update-pending.json пишет установщик ПЕРЕД перезапуском; при следующем
// старте сравниваем версию процесса с ожидаемой: совпала — «обновлено успешно»,
// нет — честно сообщаем «обновление не завершилось» (ни то, ни другое не выдумываем).
function updatePendingMarkerPath() {
  return path.join(app.getPath('userData'), 'update-pending.json')
}

/** Нормализация версии для СРАВНЕНИЯ: тег v1.0.18 и app.getVersion()=1.0.18 равны.
 *  УРОК v1.0.18: маркер писал tag_name с префиксом «v», а getVersion() без —
 *  успешное обновление ошибочно считалось «не завершившимся». */
function versionKey(s) {
  const m = String(s || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/i)
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : String(s || '').trim()
}

function checkPendingUpdate() {
  try {
    const marker = updatePendingMarkerPath()
    if (!fs.existsSync(marker)) return
    let data = null
    try {
      data = JSON.parse(fs.readFileSync(marker, 'utf8'))
    } catch {
      fs.rmSync(marker, { force: true })
      return
    }
    fs.rmSync(marker, { force: true })
    const running = app.getVersion()
    if (data.expectedVersion && versionKey(running) === versionKey(data.expectedVersion)) {
      pendingUpdateResult = {
        ok: true,
        from: data.previousVersion || null,
        to: running,
        startedAt: data.startedAt || null,
      }
      log(`[Update] Обновление подтверждено: работает ${running}`)
    } else {
      pendingUpdateResult = {
        ok: false,
        expected: data.expectedVersion || null,
        running,
        startedAt: data.startedAt || null,
      }
      log(`[Update] Обновление НЕ завершилось: ожидалось ${data.expectedVersion}, работает ${running}`)
    }
  } catch (e) {
    log(`[Update] Проверка маркера обновления не удалась: ${e.message}`)
  }
}


// --- Next.js сервер для packaged-сборки -----------------------------------------
// (nextProcess объявлен вверху модуля — до регистрации обработчиков ошибок)

function findFreePort(start) {
  return new Promise((resolve) => {
    const srv = http.createServer()
    srv.listen(start, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
    srv.on('error', () => resolve(findFreePort(start + 1)))
  })
}

function waitForServer(url, timeoutMs = 90000, onTick) {
  const started = Date.now()
  let lastTick = 0
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(url, (res) => {
        res.resume()
        if (res.statusCode && res.statusCode < 500) return resolve()
        retry()
      })
      req.on('error', retry)
      req.setTimeout(2000, () => {
        req.destroy()
        retry()
      })
    }
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Локальный сервер интерфейса не ответил за ${Math.round(timeoutMs / 1000)} с (подробности в логе [Next] выше)`))
      }
      if (onTick && Date.now() - lastTick > 5000) {
        lastTick = Date.now()
        onTick(Math.round((Date.now() - started) / 1000))
      }
      setTimeout(probe, 300)
    }
    probe()
  })
}

async function startNextServer() {
  // Dev-режим: используем уже запущенный сервер разработки
  const devUrl = process.env.AVC_APP_URL || 'http://localhost:3000'
  const resourcesDir = process.env.AVC_RESOURCES_DIR || (app.isPackaged ? process.resourcesPath : null)
  const standaloneDir = resourcesDir ? path.join(resourcesDir, 'next-app') : null

  if (!standaloneDir || !fs.existsSync(path.join(standaloneDir, 'server.js'))) {
    log(`[Main] Packaged Next server not found — using dev URL ${devUrl}`)
    return devUrl
  }

  const port = await findFreePort(3010)
  const dataDir = app.getPath('userData')
  const dbDir = path.join(dataDir, 'db')
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })
  // Первичный перенос локальной БД (Prisma/SQLite) в стабильное userData
  const dbTarget = path.join(dbDir, 'custom.db')
  const devDb = path.join(app.getAppPath(), '..', 'db', 'custom.db')
  try {
    if (!fs.existsSync(dbTarget) && fs.existsSync(devDb)) fs.copyFileSync(devDb, dbTarget)
  } catch (e) {
    log(`[Main] DB copy skipped: ${e.message}`)
  }

  const serverEntry = path.join(standaloneDir, 'server.js')
  log(`[Main] Starting packaged Next server on port ${port}`)
  nextProcess = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
      // Windows-пути с "\" ломают file:-URL Prisma — всегда прямые слэши
      DATABASE_URL: `file:${dbTarget.split(path.sep).join('/')}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  nextProcess.stdout.on('data', (d) => {
    const s = String(d).trim()
    if (s) log(`[Next] ${redact(s.slice(0, 400))}`)
  })
  nextProcess.stderr.on('data', (d) => {
    const s = String(d).trim()
    if (s) log(`[Next:err] ${redact(s.slice(0, 400))}`)
  })
  const url = `http://127.0.0.1:${port}`
  // Если серверный процесс умер ДО готовности — падаем сразу с понятной причиной,
  // а не ждём таймаут «в тишине»
  let serverReady = false
  nextProcess.once('exit', (code, signal) => {
    if (!serverReady) {
      const why = code !== null ? `код ${code}` : `сигнал ${signal}`
      log(`[Main] Next server exited before ready (${why})`)
      setSplashStage(`Сервер интерфейса неожиданно завершился (${why}) — смотрите окно ошибки`)
      fatalPromise = Promise.resolve(showFatalError(new Error(`Сервер интерфейса завершился до готовности (${why}). Подробности в логе ([Next]/[Next:err] строки выше).`)))
    }
  })
  await waitForServer(url, 90000, (sec) => {
    setSplashStage(`Запуск локального сервера… ${sec} с (первый запуск может занять дольше)`)
  })
  serverReady = true
  return url
}

// --- основная сборка --------------------------------------------------------------
// Состояние (mainWindow/authService/splash/fatal) объявлено вверху модуля —
// до регистрации обработчиков фатальных ошибок (урок релиза 1.0.9, TDZ).

// --- окно запуска (splash) и окно ошибки запуска --------------------------------
// Проблема, которую они решают: до готовности Next-сервера у приложения НЕ БЫЛО ни
// одного окна — при долгой распаковке portable EXE (минуты) или сбое старта
// пользователь видел «висит в процессах и ничего не происходит».

function createSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) return
  try {
    splashWindow = new BrowserWindow({
      width: 470,
      height: 250,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: true,
      fullscreenable: false,
      // УРОК РЕЛИЗА 1.0.11 («процессы есть, окон нет»): show:false + ожидание
      // ready-to-show зависит от исправности композитора — если GPU-конвейер
      // тормозит/падает, событие могло не прийти и окно НЕ показывалось НИКОГДА
      // (пользователь видел ~10 процессов в диспетчере и ни одного окна).
      // Теперь окно показывается СРАЗУ: тёмный фон уже задан, контент дорисуется.
      show: true,
      center: true,
      alwaysOnTop: true,
      skipTaskbar: false,
      backgroundColor: '#07111F',
      title: 'AVC-Anime',
      webPreferences: {
        preload: path.join(__dirname, 'splash-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    splashWindow.on('closed', () => { splashWindow = null })
    splashWindow.loadFile(path.join(__dirname, 'splash.html')).catch(() => { /* не критично */ })
    log('[Splash] окно запуска показано (сразу, без ожидания ready-to-show)')
  } catch (e) {
    log(`[Splash] не удалось показать окно запуска: ${e.message}`)
    splashWindow = null
  }
}

function setSplashStage(text) {
  const win = splashWindow && !splashWindow.isDestroyed() ? splashWindow : null
  if (!win) return
  win.webContents.executeJavaScript(`window.__stage(${JSON.stringify(String(text || ''))})`).catch(() => { /* окно закрыли */ })
}

function closeSplash() {
  try {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy()
  } catch { /* уже закрыто */ }
  splashWindow = null
}

/** Последние n строк журнала — для окна ошибки */
function readLogTail(n = 80) {
  try {
    const file = path.join(app.getPath('userData'), 'logs', 'avc.log')
    const raw = fs.readFileSync(file, 'utf8')
    return raw.split('\n').slice(-n).join('\n')
  } catch {
    return '(лог ещё не создан)'
  }
}

/** Окно фатальной ошибки запуска: сообщение + хвост лога + перезапуск/выход */
async function showFatalError(err) {
  if (SELFTEST || AI_SELFTEST) return
  closeSplash()
  if (fatalWindow && !fatalWindow.isDestroyed()) return
  const message = String((err && (err.stack || err.message)) || err || 'Неизвестная ошибка').slice(0, 3000)
  log(`[Boot] FATAL: ${redact(message)}`)
  try {
    fatalWindow = new BrowserWindow({
      width: 780,
      height: 620,
      title: 'AVC-Anime — ошибка запуска',
      backgroundColor: '#0b1626',
      resizable: true,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'splash-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    fatalWindow.on('closed', () => {
      fatalWindow = null
      // Окно ошибки закрыли без перезапуска — если главного окна нет, завершаем приложение
      if (!mainWindow || mainWindow.isDestroyed()) app.exit(1)
    })
    await fatalWindow.loadFile(path.join(__dirname, 'splash.html'), { search: 'mode=fatal' })
    fatalWindow.webContents
      .executeJavaScript(`window.__fatal(${JSON.stringify({ message, logTail: readLogTail(80) })})`)
      .catch(() => { /* окно закрыли до загрузки */ })
  } catch (e) {
    // Последний рубеж — нативный диалог, чтобы приложение НИКОГДА не висело молча
    log(`[Boot] не удалось показать окно ошибки: ${e.message}`)
    try { dialog.showErrorBox('AVC-Anime — ошибка запуска', message) } catch { /* ignore */ }
    app.exit(1)
  }
}

/**
 * Единый обработчик фатальных ошибок (uncaughtException/unhandledRejection).
 * Пока интерфейс не открыт — ЛЮБАЯ ошибка старта показывается пользователю,
 * чтобы приложение никогда не «висело в процессах молча».
 */
function reportFatal(err, origin) {
  const text = redact(String((err && (err.stack || err.message)) || err || 'unknown'))
  try { log(`[Main] ${origin}: ${text}`) } catch { /* слишком рано даже для лога */ }
  if (SELFTEST || AI_SELFTEST) return
  if (mainWindow && !mainWindow.isDestroyed()) return // рабочее приложение — не пугаем пользователя
  if (fatalPromise) return
  fatalPromise = showFatalError(new Error(`${origin}\n\n${text}`)).catch(() => { /* уже залогировано */ })
}

function setupSplashIpc() {
  ipcMain.on('avc:splash:open-logs', async () => {
    try {
      const dir = path.join(app.getPath('userData'), 'logs')
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const err = await shell.openPath(dir)
      if (err) log(`[Splash] открыть папку логов не удалось: ${err}`)
    } catch (e) {
      log(`[Splash] открыть папку логов не удалось: ${e.message}`)
    }
  })
  ipcMain.on('avc:splash:quit', () => app.exit(1))
  ipcMain.on('avc:splash:relaunch', () => {
    try { app.relaunch() } catch { /* не получилось — просто выходим */ }
    app.exit(0)
  })
}

async function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'AVC-Anime',
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#07111F',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Главный экран приложения не улетает на сторонние сайты
  mainWindow.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) e.preventDefault()
  })
  // УРОК РЕЛИЗА 1.0.11 («открыло вот столько вкладок»): реклама в кросс-доменном
  // iframe плеера вызывает window.open пачками, и раньше КАЖДЫЙ попап улетал в
  // shell.openExternal → десятки вкладок в системном браузере. Теперь: только
  // https, не чаще 3 за 30 с, всё остальное — тихий отказ с записью в лог.
  let externalOpens = []
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    let parsed = null
    try { parsed = new URL(target) } catch { /* мусорная ссылка */ }
    const now = Date.now()
    externalOpens = externalOpens.filter((t) => now - t < 30_000)
    const okUrl = parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:')
    if (!okUrl || externalOpens.length >= 3) {
      log(`[Main] Попап заблокирован (внешние вкладки): ${String(target).slice(0, 120)}`)
      return { action: 'deny' }
    }
    externalOpens.push(now)
    shell.openExternal(target) // внешние ссылки — в системный браузер, дозированно
    return { action: 'deny' }
  })

  // Загрузка с повторами: transient-сбои старта сервера не должны убивать запуск
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await mainWindow.loadURL(url)
      lastErr = null
      break
    } catch (e) {
      lastErr = e
      log(`[Main] loadURL попытка ${attempt} не удалась: ${e.message}`)
      if (attempt < 3) {
        setSplashStage(`Подключение к интерфейсу… (попытка ${attempt + 1})`)
        await new Promise((r) => setTimeout(r, 1500))
      }
    }
  }
  if (lastErr) {
    try { mainWindow.destroy() } catch { /* уже закрыто */ }
    mainWindow = null
    throw lastErr
  }
  // Показ главного окна с ГАРАНТИЕЙ: по ready-to-show ИЛИ по страховочному
  // таймеру 4 с (урок 1.0.11 — окно не имело права оставаться невидимым,
  // даже если композитор не отдаёт ready-to-show).
  let shown = false
  const showOnce = () => {
    if (shown) return
    shown = true
    try {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show()
    } catch { /* окно могли закрыть */ }
  }
  mainWindow.once('ready-to-show', showOnce)
  const fallbackTimer = setTimeout(showOnce, 4000)
  mainWindow.once('closed', () => clearTimeout(fallbackTimer))
  closeSplash()
  markStartup('ui-loaded')
  mainWindow.webContents.once('did-finish-load', () => {
    markStartup('ui-usable')
    writeStartupReport()
  })
  return mainWindow
}

function setupIpc(service) {
  ipcMain.handle('avc:auth:getState', (_e, args) => service.verify({ force: !!args?.refresh }))
  ipcMain.handle('avc:auth:open-login', () => service.startLogin())
  ipcMain.handle('avc:auth:verify', () => service.verify({ force: true }))
  ipcMain.handle('avc:auth:logout', () => service.logout())
  ipcMain.handle('avc:auth:favorites', (_e, args) => service.getFavorites({ refresh: !!args?.refresh }))
  ipcMain.handle('avc:auth:reset-session', (_e, args) =>
    service.resetSession({ confirmed: !!args?.confirmed }),
  )
  ipcMain.handle('avc:auth:selftest', () => service.selftest())
  // РЕАЛЬНОЕ действие аккаунта ВНУТРИ сессии сайта (список/оценка/избранное)
  ipcMain.handle('avc:anime:action', (_e, req) => service.animeAction(req))
  // Своё состояние тайтла — подсветка активного статуса/сердца/оценки (UI страницы аниме)
  ipcMain.handle('avc:anime:own-state', (_e, slug) =>
    typeof slug === 'string' && slug.trim() !== ''
      ? service.readAnimeOwnState(slug)
      : Promise.resolve(null),
  )
  // ПОЛНАЯ библиотека сайта (Смотрю/В Планах/Просмотрено/Брошено/Любимые/Отложено):
  // читается ВНУТРИ постоянной сессии main-процесса — в EXE серверной cookie-сессии
  // Next.js нет, поэтому раньше панель библиотеки всегда показывала «войдите»
  ipcMain.handle('avc:anime:library', (_e, args) => service.getLibrary({ refresh: !!args?.refresh }))
}

/**
 * Мост IPC ⇔ AI-воркер (utilityProcess, §130 process isolation).
 * В main-процессе Electron N-API external arraybuffers запрещены («External buffers
 * are not allowed») — нативный sherpa-onnx TTS требует их, поэтому весь нативный AI
 * живёт в изолированном utilityProcess (полный Node), а main только пересылает сообщения.
 */
const AI_EVENT_CHANNELS = {
  'stt-partial': 'avc:ai:stt-partial',
  'stt-final': 'avc:ai:stt-final',
  'services-status': 'avc:ai:services-status',
  'model-progress': 'avc:ai:model-progress',
  'worker-state': 'avc:ai:worker-state',
}

let aiWorker = null
let aiWorkerReqId = 0
const aiWorkerPending = new Map()
let aiWorkerFailed = null

/** УРОК 0xC0000409 (GitHub issue #2): воркер умирает нативным фейл-фастом при загрузке
 *  битой модели. Коды нативных крашей Windows (fail-fast/abort/access-violation) + SIGABRT(134). */
const NATIVE_CRASH_CODES = new Set([134, 3221225477, 3221226505, 3221225786, 3221226019])
/** Момент старта воркера — нативный краш при загрузке модели происходит в первые секунды */
let aiWorkerSpawnAt = 0
/** Серия нативных крашей подряд (для safe-mode при целостных файлах) */
let aiWorkerNativeCrashStreak = 0
/** Информация о карантине модели (для честного UI) */
let aiWorkerQuarantine = null
/** Безопасный режим (записан на диск — переживает перезапуск) */
let aiWorkerSafeMode = null

// УРОК v1.0.20 (краш при старте EXE «Cannot find module './ai/model-integrity.cjs'»):
// main.cjs пакуется в app.asar, а папка ai/ живёт РЯДОМ (resources/ai — extraResources).
// Относительный require('./ai/...') работал в dev, но ломал packaged-EXE.
// Используем тот же паттерн разрешения пути, что и для спавна воркера (см. startAiWorker).
const modelIntegrityPath = app.isPackaged
  ? path.join(process.resourcesPath, 'ai', 'model-integrity.cjs')
  : path.join(__dirname, 'ai', 'model-integrity.cjs')
const { checkModelIntegrity, quarantineModel, listQuarantined } = require(modelIntegrityPath)

function safeModePath() {
  return path.join(app.getPath('userData'), 'ai-safe-mode.json')
}
function readSafeMode() {
  try { return JSON.parse(fs.readFileSync(safeModePath(), 'utf8')) } catch { return null }
}
function writeSafeMode(rec) {
  try { fs.writeFileSync(safeModePath(), JSON.stringify(rec, null, 2)) } catch { /* некритично */ }
}
function clearSafeMode() {
  try { fs.unlinkSync(safeModePath()) } catch { /* нет файла */ }
  aiWorkerSafeMode = null
}

function aiWorkerRequest(type, args) {
  if (!aiWorker) return Promise.reject(new Error(aiWorkerFailed || 'AI-воркер не запущен'))
  return new Promise((resolve, reject) => {
    const id = `req-${++aiWorkerReqId}`
    const timer = setTimeout(() => {
      aiWorkerPending.delete(id)
      reject(new Error(`AI-воркер: таймаут запроса ${type}`))
    }, args?.__timeoutMs || 300000)
    aiWorkerPending.set(id, { resolve, reject, timer })
    try {
      aiWorker.send({ id, type, args })
    } catch (e) {
      clearTimeout(timer)
      aiWorkerPending.delete(id)
      reject(e)
    }
  })
}

/** Путь к чистому Node для AI-воркера: packaged → bundled runtime, dev → PATH */
function findSystemNode() {
  if (process.env.AVC_NODE_EXE && fs.existsSync(process.env.AVC_NODE_EXE)) return process.env.AVC_NODE_EXE
  try {
    const resourcesDir = process.resourcesPath || null
    if (resourcesDir) {
      const cand =
        process.platform === 'win32'
          ? path.join(resourcesDir, 'runtime-node', 'node.exe')
          : path.join(resourcesDir, 'runtime-node', 'bin', 'node')
      if (fs.existsSync(cand)) return cand
    }
  } catch { /* dev-режим */ }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const p = process.platform === 'win32' ? path.join(dir, 'node.exe') : path.join(dir, 'node')
    try { if (fs.existsSync(p)) return p } catch { /* ок */ }
  }
  return null
}

/** Конфиг каталога моделей (фаза 5 аудита): userData/models-dir.json */
function modelsDirConfigPath() {
  return path.join(app.getPath('userData'), 'models-dir.json')
}

/** Релиз 1.0.15: модель по умолчанию — GigaAM v3 (точная). Значения sttModel,
 *  записанные СТАРЫМ дефолтом (t-one-russian) без явного выбора пользователя
 *  (sttModelChosen), считаются остатком старого дефолта и НЕ блокируют новый. */
const STT_MODEL_DEFAULT = 'gigaam-v3-russian'

function readModelsDirConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(modelsDirConfigPath(), 'utf8'))
    const dir = typeof raw.modelsDir === 'string' ? raw.modelsDir.trim() : ''
    let sttModel = typeof raw.sttModel === 'string' && /^[a-z0-9-]{1,64}$/i.test(raw.sttModel) ? raw.sttModel : null
    const chosen = raw.sttModelChosen === true
    // миграция старого дефолта: t-one-russian без явного выбора → новый дефолт
    if (sttModel === 't-one-russian' && !chosen) sttModel = null
    return {
      modelsDir: dir && path.isAbsolute(dir) ? dir : null,
      sttModel,
    }
  } catch {
    return { modelsDir: null, sttModel: null }
  }
}

function writeModelsDirConfig(dir, sttModel, sttModelChosen) {
  const prev = readModelsDirConfig()
  const prevRaw = (() => {
    try { return JSON.parse(fs.readFileSync(modelsDirConfigPath(), 'utf8')) } catch { return {} }
  })()
  fs.writeFileSync(
    modelsDirConfigPath(),
    JSON.stringify(
      {
        modelsDir: dir ?? prev.modelsDir,
        sttModel: sttModel ?? prev.sttModel,
        // явный выбор пользователя (кнопка «Сделать активной») — уважается всегда;
        // миграция старого дефолта сбрасывает только «остатки» без флага
        sttModelChosen: sttModelChosen === true ? true : prevRaw.sttModelChosen === true,
      },
      null,
      2,
    ),
  )
}

/** Каталог моделей: конфиг пользователя → dev-models → userData/ai-models */
function resolveModelsDir() {
  const configured = readModelsDirConfig().modelsDir
  if (configured) return configured
  const devModels = path.join(app.getAppPath(), 'models')
  if (fs.existsSync(path.join(devModels, 'stt'))) return devModels
  return path.join(app.getPath('userData'), 'ai-models')
}

/** Размер каталога в байтах и число файлов (для проверки миграции) */
function dirStats(dir) {
  let bytes = 0
  let files = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        bytes += fs.statSync(p).size
        files++
      }
    }
  }
  walk(dir)
  return { bytes, files }
}

/**
 * Запуск AI-воркера с РЕТРАМИ и ЧЕСТНОЙ причиной отказа в UI.
 * УРОК РЕЛИЗА 1.0.12: на машинах пользователей форк мог временно падать
 * (антивирус блокирует свеже-распакованный node.exe на первые секунды) —
 * без ретраев и видимой причины пользователь видел «зависшее» приложение.
 */
function startAiWorker(retry = 0) {
  try {
    const modelsDir = resolveModelsDir()
    const requestedModel = readModelsDirConfig().sttModel || STT_MODEL_DEFAULT
    const safeMode = readSafeMode()
    aiWorkerSafeMode = safeMode
    const workerScript = app.isPackaged
      ? path.join(process.resourcesPath, 'ai', 'ai-worker.cjs')
      : path.join(__dirname, 'ai', 'ai-worker.cjs')
    if (aiWorker) {
      try { aiWorker.kill() } catch { /* уже мёртв */ }
      aiWorker = null
    }
    const nodeExe = findSystemNode()
    if (!nodeExe) {
      aiWorkerFailed = 'Node-рантайм для AI-воркера не найден (ожидался resources/runtime-node или node в PATH)'
      log(`[AI] ${aiWorkerFailed}`)
      notifyWorkerState()
      return
    }
    if (!fs.existsSync(workerScript)) {
      aiWorkerFailed = `Скрипт воркера не найден: ${workerScript}`
      log(`[AI] ${aiWorkerFailed}`)
      notifyWorkerState()
      return
    }
    aiWorker = childFork(workerScript, [], {
      execPath: nodeExe,
      env: {
        ...process.env,
        AVC_MODELS_DIR: modelsDir,
        AVC_STT_MODEL: requestedModel,
        // безопасный режим после нативного краша: не выбирать модель-виновника
        AVC_EXCLUDE_MODEL: (safeMode && safeMode.modelId) || '',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'advanced',
    })
    aiWorkerFailed = null
    aiWorkerSpawnAt = Date.now()
    aiWorker.stdout && aiWorker.stdout.on('data', (d) => log(`[AIWorker] ${String(d).trim().slice(0, 300)}`))
    aiWorker.stderr && aiWorker.stderr.on('data', (d) => log(`[AIWorker] ${String(d).trim().slice(0, 300)}`))
    aiWorker.on('message', (msg) => {
      if (msg && msg.event) {
        if (msg.event === 'services-status') markStartup('ai-worker-services-status')
        // переустановка модели в карантине снята — честно чистим флаги
        if (msg.event === 'model-progress' && msg.payload && msg.payload.phase === 'done' && aiWorkerQuarantine && msg.payload.id === aiWorkerQuarantine.modelId) {
          aiWorkerQuarantine = null
          clearSafeMode()
        }
        const channel = AI_EVENT_CHANNELS[msg.event]
        if (channel && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(channel, msg.payload)
        }
        return
      }
      if (msg && msg.id) {
        const pending = aiWorkerPending.get(msg.id)
        if (!pending) return
        aiWorkerPending.delete(msg.id)
        clearTimeout(pending.timer)
        if (msg.ok) pending.resolve(msg.result)
        else pending.reject(new Error(msg.error || 'ошибка AI-воркера'))
      }
    })
    aiWorker.on('exit', (code) => {
      aiWorker = null
      for (const [id, p] of aiWorkerPending) {
        clearTimeout(p.timer)
        p.reject(new Error('AI-воркер завершился'))
        aiWorkerPending.delete(id)
      }
      // воркер не должен умирать сам: если умер без нашей команды — причина в UI/лог
      if (!app.isQuitting) {
        const aliveMs = Date.now() - aiWorkerSpawnAt
        const nativeCrash = NATIVE_CRASH_CODES.has(Number(code)) || (Number(code) >= 3221225472)
        // --- УРОК 0xC0000409: диагностика нативного краша вместо глухого ретрая ---
        if (nativeCrash && aliveMs < 30000) {
          const integ = checkModelIntegrity(modelsDir, requestedModel)
          const suspectDir = path.join(modelsDir, 'stt', requestedModel)
          // файлы на месте, но повреждены (с маркером или без — остатки старых
          // установок тоже ловим) — КАРАНТИН и авто-fallback на здоровую модель
          if (!integ.ok && fs.existsSync(suspectDir)) {
            // файлы на месте, но повреждены — КАРАНТИН и авто-fallback на здоровую модель
            const q = quarantineModel(modelsDir, requestedModel, integ.problems.join('; '))
            aiWorkerQuarantine = { modelId: requestedModel, reason: integ.problems.join('; '), to: (q && q.to) || null, at: new Date().toISOString() }
            clearSafeMode()
            aiWorkerNativeCrashStreak = 0
            aiWorkerFailed = `Модель ${requestedModel} повреждена (${integ.problems[0]}) и помещена в карантин. Голос автоматически работает на здоровой модели — переустановите ${requestedModel} в Настройках → AI.`
            log(`[AI] ${aiWorkerFailed}`)
            notifyWorkerState()
            setTimeout(() => startAiWorker(0), 1000)
            return
          }
          // файлы целы, а нативный краш всё равно — считаем серию, на 2-й включаем безопасный режим
          aiWorkerNativeCrashStreak += 1
          if (aiWorkerNativeCrashStreak >= 2) {
            const rec = { modelId: requestedModel, code, at: new Date().toISOString(), reason: 'native-crash-loop при целостных файлах' }
            writeSafeMode(rec)
            aiWorkerSafeMode = rec
            aiWorkerFailed = `Модель ${requestedModel} дважды вызвала нативный краш (код ${code}) при целостных файлах — включён безопасный режим на T-One. Вернуть модель можно переустановкой в Настройках → AI.`
            log(`[AI] ${aiWorkerFailed}`)
            notifyWorkerState()
            setTimeout(() => startAiWorker(0), 1000)
            return
          }
        } else if (!nativeCrash) {
          aiWorkerNativeCrashStreak = 0
        }
        aiWorkerFailed = `AI-воркер завершился сам (код ${code ?? '?'}) — смотрите логи`
        log(`[AI] ${aiWorkerFailed}`)
        notifyWorkerState()
        // одна автопопытка поднять воркер снова (транзиентный сбой нативного модуля)
        if (retry < 2) {
          setTimeout(() => {
            log(`[AI] Автоперезапуск AI-воркера (попытка ${retry + 2}/3)…`)
            startAiWorker(retry + 1)
          }, 2000 * (retry + 1))
        }
      }
    })
    log(`[AI] AI-воркер запущен (попытка ${retry + 1}): models=${modelsDir}, модель=${requestedModel}${safeMode && safeMode.modelId ? ` (безопасный режим: без ${safeMode.modelId})` : ''}`)
    markStartup('ai-worker-spawned')
    notifyWorkerState()
  } catch (e) {
    aiWorkerFailed = e.message
    log(`[AI] Не удалось запустить AI-воркер (AI недоступен): ${e.message}`)
    notifyWorkerState()
  }
}

/** Сообщить рендереру состояние воркера (честная причина — Настройки → AI) */
function notifyWorkerState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(AI_EVENT_CHANNELS['worker-state'], {
      running: !!aiWorker,
      error: aiWorkerFailed,
      quarantine: aiWorkerQuarantine,
      safeMode: aiWorkerSafeMode,
    })
  }
}

/** IPC локального AI-слоя (наружу — только не-секретные данные) */
function setupAiIpc() {
  ipcMain.handle('avc:ai:status', async () => {
    try {
      const st = await aiWorkerRequest('status')
      return { ...st, worker: 'ok', workerError: null }
    } catch (e) {
      // УРОК РЕЛИЗА 1.0.12: причина отказа воркера обязана дойти до UI —
      // пользователь имеет право знать, ПОЧЕМУ голос не работает
      return { enabled: false, worker: 'failed', reason: e.message, workerError: aiWorkerFailed || e.message, ready: { stt: false } }
    }
  })
  ipcMain.handle('avc:ai:hardware', async () => {
    const hw = await aiWorkerRequest('hardware')
    try {
      const info = await app.getGPUInfo('basic')
      const dev = info && info.gpuDevice && info.gpuDevice[0]
      if (dev) hw.gpu = { vendor: dev.vendorId, device: dev.deviceId, name: dev.deviceString || null }
    } catch { /* gpu остаётся null — честно */ }
    return hw
  })
  ipcMain.handle('avc:ai:install', (_e, args) => aiWorkerRequest('install', { ...args, __timeoutMs: 3600000 }))
  ipcMain.handle('avc:ai:cancel-install', (_e, args) => aiWorkerRequest('cancel-install', args))
  ipcMain.handle('avc:ai:recover', () => aiWorkerRequest('recover'))
  ipcMain.handle('avc:ai:set-enabled', (_e, args) => aiWorkerRequest('set-enabled', args))
  ipcMain.handle('avc:ai:set-profile', (_e, args) => aiWorkerRequest('set-profile', args))
  // РЕЛИЗ 1.0.12: обработчики LLM ('avc:ai:llm-route') и TTS ('avc:ai:tts-speak',
  // 'avc:ai:tts-cancel', 'avc:ai:set-voice') удалены вместе со слоями —
  // рендерер больше не вызывает их (мост в api.ts/use-voice.ts снят).
  ipcMain.handle('avc:ai:initialize', () => aiWorkerRequest('initialize', { __timeoutMs: 600000 }))
  // --- Каталог моделей STT (спецификация STT, фазы 3–6): бенчмарк, смена модели, ---
  // --- проверка/удаление. Всё выполняется в изолированном воркере. ---
  ipcMain.handle('avc:ai:catalog', () => aiWorkerRequest('catalog'))
  ipcMain.handle('avc:ai:benchmark', () => aiWorkerRequest('benchmark', { __timeoutMs: 300000 }))
  ipcMain.handle('avc:ai:set-stt-model', async (_e, args) => {
    const modelId = String(args?.modelId || '').trim()
    if (!/^[a-z0-9-]{1,64}$/i.test(modelId)) return { ok: false, message: 'Некорректный id модели' }
    const res = await aiWorkerRequest('set-stt-model', { modelId, __timeoutMs: 600000 })
    if (res?.ok) {
      // явный успешный выбор пользователя снимает безопасный режим/карантин
      clearSafeMode()
      aiWorkerQuarantine = null
      aiWorkerNativeCrashStreak = 0
      // активная модель сохраняется как ЯВНЫЙ выбор пользователя — переживает
      // перезапуск приложения и смены дефолта в будущих релизах
      try { writeModelsDirConfig(null, modelId, true) } catch { /* не критично */ }
    }
    return res
  })
  ipcMain.handle('avc:ai:remove-component', (_e, args) => aiWorkerRequest('remove-component', args))
  ipcMain.handle('avc:ai:verify-component', (_e, args) => aiWorkerRequest('verify-component', { ...args, __timeoutMs: 300000 }))
  ipcMain.handle('avc:ai:stt-feed', (_e, args) => {
    const samples = args?.samples
    if (!samples) return false
    return aiWorkerRequest('feed', { samples })
  })
  ipcMain.handle('avc:ai:stt-flush', () => aiWorkerRequest('flush'))
  // Режим рации: пока кнопка PTT удерживается — аудио без VAD-гейта
  ipcMain.handle('avc:ai:stt-capture', (_e, args) => aiWorkerRequest('set-capture-mode', { enabled: !!args?.enabled }))

  // --- Фаза 5 (аудит №4): каталог AI-моделей — выбор, миграция, открытие ---

  ipcMain.handle('avc:ai:models:get-config', () => {
    const current = resolveModelsDir()
    let usedBytes = null
    try {
      if (fs.existsSync(current)) usedBytes = dirStats(current).bytes
    } catch { /* каталог мог быть пуст/недоступен */ }
    return {
      currentDir: current,
      // строка|null — как ожидает UI (не объект конфига)
      configured: readModelsDirConfig().modelsDir,
      defaultDir: path.join(app.getPath('userData'), 'ai-models'),
      usedBytes,
      workerReady: !!aiWorker,
      workerError: aiWorkerFailed,
    }
  })

  /** Ручной перезапуск AI-воркера (кнопка в Настройках → AI) */
  /** Диагностика для владельца (открывается из шапки): версия/пути/состояние воркера */
  ipcMain.handle('avc:debug:appinfo', () => ({
    version: app.getVersion(),
    platform: `${process.platform} ${process.arch}`,
    electron: process.versions.electron || null,
    node: process.versions.node || null,
    userData: app.getPath('userData'),
    logsFile: path.join(app.getPath('userData'), 'logs', 'avc.log'),
    modelsDir: resolveModelsDir(),
    workerRunning: !!aiWorker,
    workerError: aiWorkerFailed,
    isPackaged: app.isPackaged,
  }))

  /** Хвост лога приложения (лог пишется с redact-секретов на этапе записи) */
  ipcMain.handle('avc:debug:logs', (_e, args) => {
    const lines = Math.min(400, Math.max(50, Number(args?.lines) || 200))
    try {
      const file = path.join(app.getPath('userData'), 'logs', 'avc.log')
      if (!fs.existsSync(file)) return { lines: [], file }
      const stat = fs.statSync(file)
      const start = Math.max(0, stat.size - 512 * 1024)
      const fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(stat.size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      fs.closeSync(fd)
      const all = buf.toString('utf8').split('\n').filter((l) => l.trim() !== '')
      return { lines: all.slice(-lines), file }
    } catch (e) {
      return { lines: [], error: e.message }
    }
  })

  ipcMain.handle('avc:ai:restart-worker', async () => {
    log('[AI] Перезапуск AI-воркера по запросу пользователя')
    startAiWorker(0)
    // дать воркеру секунду на поднятие, затем честный статус
    await new Promise((r) => setTimeout(r, 1000))
    try {
      const st = await aiWorkerRequest('status', { __timeoutMs: 15000 })
      return { ok: true, running: true, ready: st.ready, activeModel: st.activeModel }
    } catch (e) {
      return { ok: !!aiWorker, running: !!aiWorker, error: aiWorkerFailed || e.message }
    }
  })

  /** Открыть папку с логами (диагностика «что происходит» без поддержки) */
  // --- ОБНОВЛЕНИЕ ПРИЛОЖЕНИЯ (портативное сам-обновление, двухфазная схема) ----
  // §3.2  Источник истины: GitHub releases/latest (опубликованный, не draft/pre).
  // §3.3  Версии сравниваются ВСЕГДА ДО скачивания, причём ДВАЖДЫ: в check и
  //       повторно в install (рендерер не может заставить установить равную/старую).
  // §3.9  Целостность: SHA-256 по SHA256SUMS.txt из релиза; не совпало — файл
  //       удаляется, установленная версия не трогается.
  // §3.10 Двухфазная подмена: приложение завершается ШТАТНО (before-quit снимает
  //       своих детей), а cmd-скрипт (detached) только ЖДЁТ исчезновения PID,
  //       подменяет EXE (move; fallback: ren старого → move нового), стартует новый.
  //       НИКАКИХ taskkill изнутри дерева — прежний скрипт убивал сам себя
  //       (cmd.exe был потомком mainPid при taskkill /T).
  // §3.12 Маркер update-pending.json: пишется до перезапуска; при следующем старте
  //       версия процесса сверяется с ожидаемой → честный итог в UI.
  const UPDATE_REPO = 'HellShaftSam/AVC-AnimeVoiceCommand'

  const httpsGetJson = (url, redirects = 0) =>
    new Promise((resolve, reject) => {
      if (redirects > 5) return reject(new Error('too many redirects'))
      const req = https.get(url, { headers: { 'User-Agent': 'AVC-Anime-Updater', Accept: 'application/vnd.github+json' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          return httpsGetJson(new URL(res.headers.location, url).toString(), redirects + 1).then(resolve, reject)
        }
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }) } catch (e) { reject(e) }
        })
      })
      req.on('error', reject)
      req.setTimeout(15000, () => req.destroy(new Error('timeout')))
    })

  /** Формат версии проекта: 1.0.<run_number> (CI extraMetadata); теги v1.0.<N>. */
  const parseVersion = (s) => {
    const m = String(s || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/i)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  /** Правильное числовое сравнение (1.10.0 > 1.9.0); null — формат не распознан */
  const compareVersions = (a, b) => {
    const va = parseVersion(a)
    const vb = parseVersion(b)
    if (!va || !vb) return null
    for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return va[i] > vb[i] ? 1 : -1
    return 0
  }

  const httpsDownloadFile = (url, destPath, onProgress, redirects = 0) =>
    new Promise((resolve, reject) => {
      if (redirects > 6) return reject(new Error('Слишком много перенаправлений'))
      const req = https.get(url, { headers: { 'User-Agent': 'AVC-Anime-Updater' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          return httpsDownloadFile(new URL(res.headers.location, url).toString(), destPath, onProgress, redirects + 1).then(resolve, reject)
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode}`))
        }
        const total = Number(res.headers['content-length'] || 0)
        let received = 0
        let lastEmit = 0
        const samples = [] // скользящее окно скорости (~2 с)
        const file = fs.createWriteStream(destPath)
        res.on('data', (chunk) => {
          received += chunk.length
          if (onProgress) {
            const now = Date.now()
            samples.push({ t: now, b: received })
            while (samples.length > 2 && now - samples[0].t > 2000) samples.shift()
            if (now - lastEmit > 250) {
              lastEmit = now
              const first = samples[0]
              const speed = first && now > first.t ? (received - first.b) / ((now - first.t) / 1000) : 0
              onProgress({ received, total, speed })
            }
          }
        })
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve({ received, total })))
        file.on('error', (e) => reject(e))
        res.on('error', (e) => {
          try { file.close() } catch { /* ок */ }
          reject(e)
        })
      })
      req.on('error', reject)
      req.setTimeout(60000, () => req.destroy(new Error('Таймаут скачивания обновления')))
    })

  const sha256File = (file) =>
    new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256')
      const stream = fs.createReadStream(file)
      stream.on('data', (c) => hash.update(c))
      stream.on('error', reject)
      stream.on('end', () => resolve(hash.digest('hex')))
    })

  /** releases/latest → нормализованная информация об обновлении (без скачивания) */
  const fetchLatestReleaseInfo = async () => {
    const current = app.getVersion()
    const releasesUrl = `https://github.com/${UPDATE_REPO}/releases/latest`
    try {
      const { status, body } = await httpsGetJson(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`)
      if (status === 404) return { current, latest: null, relation: 'unknown', available: false, error: 'На GitHub нет опубликованного релиза', releasesUrl, lastUpdateResult: pendingUpdateResult }
      if (status !== 200) return { current, latest: null, relation: 'unknown', available: false, error: `GitHub API: HTTP ${status}`, releasesUrl, lastUpdateResult: pendingUpdateResult }
      const latest = String(body.tag_name || '')
      const assets = Array.isArray(body.assets) ? body.assets : []
      const asset = assets.find((a) => /\.exe$/i.test(a.name)) || null
      const shaAsset = assets.find((a) => /^SHA256SUMS\.txt$/i.test(a.name)) || null
      const cmp = compareVersions(latest, current)
      const relation = cmp === null ? 'unknown' : cmp > 0 ? 'newer' : cmp < 0 ? 'older' : 'up-to-date'
      return {
        current,
        latest: latest || null,
        releaseName: body.name || null,
        releasedAt: body.published_at || null,
        releaseNotes: typeof body.body === 'string' ? body.body.slice(0, 2000) : null,
        relation,
        // §3.3: доступно обновление ТОЛЬКО если latest строго новее и есть EXE
        available: relation === 'newer' && !!asset,
        assetUrl: asset ? asset.browser_download_url : null,
        assetName: asset ? asset.name : null,
        assetSizeBytes: asset ? asset.size : null,
        shaUrl: shaAsset ? shaAsset.browser_download_url : null,
        releasesUrl,
        lastUpdateResult: pendingUpdateResult,
      }
    } catch (e) {
      return { current, latest: null, relation: 'unknown', available: false, error: e.message, releasesUrl, lastUpdateResult: pendingUpdateResult }
    }
  }

  ipcMain.handle('avc:update:check', () => fetchLatestReleaseInfo())

  ipcMain.handle('avc:update:install', async () => {
    const send = (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('avc:update:progress', payload)
      }
    }
    try {
      // §3.3 (защита от рассинхрона): ПОВТОРНАЯ сверка версий в main перед скачиванием
      send({ phase: 'checking' })
      const info = await fetchLatestReleaseInfo()
      if (info.error) return { ok: false, error: info.error }
      if (!info.available || !info.assetUrl) {
        const why =
          info.relation === 'up-to-date'
            ? 'У вас уже последняя версия — установка не требуется'
            : info.relation === 'older'
              ? 'Установленная версия новее опубликованной — откат не выполняется'
              : info.error || 'Обновление недоступно (нет опубликованного EXE)'
        return { ok: false, error: why, relation: info.relation }
      }

      const tmpDir = path.join(app.getPath('temp'), 'avc-update')
      fs.mkdirSync(tmpDir, { recursive: true })
      const newPath = path.join(tmpDir, 'AVC-Anime-new.exe')
      try { fs.rmSync(newPath, { force: true }) } catch { /* ок */ }

      // 1. Скачивание с прогрессом (%, МБ, скорость, ETA считает рендерер по speedBps)
      send({ phase: 'downloading', percent: 0, receivedBytes: 0, totalBytes: info.assetSizeBytes || null })
      await httpsDownloadFile(info.assetUrl, newPath, (p) => {
        send({
          phase: 'downloading',
          percent: p.total ? Math.min(99, (p.received / p.total) * 100) : null,
          receivedBytes: p.received,
          totalBytes: p.total || null,
          speedBps: p.speed || null,
        })
      })

      // 2. Целостность: SHA-256 из SHA256SUMS.txt релиза (если релиз его публикует)
      send({ phase: 'verifying' })
      let shaVerified = false
      let shaWarning = null
      if (info.shaUrl) {
        const sumsPath = path.join(tmpDir, 'SHA256SUMS.txt')
        try { fs.rmSync(sumsPath, { force: true }) } catch { /* ок */ }
        await httpsDownloadFile(info.shaUrl, sumsPath, null)
        const sums = fs.readFileSync(sumsPath, 'utf8')
        const line = sums
          .split(/\r?\n/)
          .map((l) => l.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/))
          .find((m) => m && m[2].trim().toLowerCase() === String(info.assetName || '').toLowerCase())
        if (!line) {
          shaWarning = 'В SHA256SUMS.txt нет записи для файла обновления'
        } else {
          const expected = line[1].toLowerCase()
          const actual = (await sha256File(newPath)).toLowerCase()
          if (actual !== expected) {
            fs.rmSync(newPath, { force: true })
            return {
              ok: false,
              error: `Проверка целостности не пройдена (SHA-256 не совпал). Файл удалён, установленная версия не тронута — повторите обновление позже.`,
            }
          }
          shaVerified = true
        }
      } else {
        shaWarning = 'Релиз не содержит SHA256SUMS.txt — проверка целостности недоступна'
      }

      // 3. Маркер результата (сверится при следующем старте — §3.12)
      send({ phase: 'preparing', shaVerified })
      const exePath = app.getPath('exe')
      const prevPath = path.join(path.dirname(exePath), 'AVC-Anime-previous.exe')
      fs.writeFileSync(
        updatePendingMarkerPath(),
        JSON.stringify(
          {
            // храним БЕЗ префикса «v» — getVersion() его не содержит;
            // сверка при следующем старте всё равно идёт через versionKey
            expectedVersion: String(info.latest || '').trim().replace(/^v/i, ''),
            previousVersion: app.getVersion(),
            exePath,
            startedAt: new Date().toISOString(),
            assetName: info.assetName,
            shaVerified,
          },
          null,
          2,
        ),
      )

      // 4. Двухфазный установщик: ждать выход → подмена → старт. Без taskkill себя.
      const scriptPath = path.join(tmpDir, 'update-avc.cmd')
      const script = [
        '@echo off',
        'setlocal EnableExtensions',
        `set "AVC_EXE=${exePath}"`,
        `set "AVC_NEW=${newPath}"`,
        `set "AVC_PREV=${prevPath}"`,
        `set "AVC_MARKER=${updatePendingMarkerPath()}"`,
        'set /a AVC_WAITED=0',
        ':avc_waitloop',
        `tasklist /FI "PID eq ${process.pid}" 2>nul | find "${process.pid}" >nul`,
        'if errorlevel 1 goto avc_swap',
        'if %AVC_WAITED% GEQ 120 goto avc_timeout',
        'ping -n 2 127.0.0.1 >nul',
        'set /a AVC_WAITED+=1',
        'goto avc_waitloop',
        ':avc_swap',
        'move /y "%AVC_NEW%" "%AVC_EXE%" >nul 2>&1',
        'if not errorlevel 1 goto avc_launch',
        'if exist "%AVC_EXE%" ren "%AVC_EXE%" "AVC-Anime-previous.exe" >nul 2>&1',
        'move /y "%AVC_NEW%" "%AVC_EXE%" >nul 2>&1',
        'if not errorlevel 1 goto avc_launch',
        'if not exist "%AVC_EXE%" if exist "%AVC_PREV%" ren "%AVC_PREV%" "AVC-Anime.exe" >nul 2>&1',
        'goto avc_giveup',
        ':avc_launch',
        'if exist "%AVC_EXE%" start "" "%AVC_EXE%"',
        'del "%~f0" >nul 2>&1',
        'exit /b 0',
        ':avc_timeout',
        'del "%AVC_MARKER%" >nul 2>&1',
        'del "%~f0" >nul 2>&1',
        'exit /b 2',
        ':avc_giveup',
        'del "%AVC_MARKER%" >nul 2>&1',
        'del "%~f0" >nul 2>&1',
        'exit /b 3',
      ].join('\r\n')
      fs.writeFileSync(scriptPath, script, 'utf8')

      send({ phase: 'restarting', shaVerified, warning: shaWarning })
      const child = spawn('cmd.exe', ['/c', scriptPath], { detached: true, stdio: 'ignore' })
      child.unref()
      // Штатный выход: before-quit снимает дерево своих детей; установщик при этом
      // выживает (он НЕ в списке killProcessTree) и завершает подмену.
      setTimeout(() => app.quit(), 300)
      return { ok: true }
    } catch (e) {
      send({ phase: 'error', error: e.message })
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('avc:ai:open-logs', async () => {
    const dir = path.join(app.getPath('userData'), 'logs')
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const err = await shell.openPath(dir)
      return { ok: !err, error: err || null }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('avc:ai:models:pick-dir', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Папка для AI-моделей AVC-Anime',
      buttonLabel: 'Выбрать папку',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: resolveModelsDir(),
    })
    if (res.canceled || !res.filePaths?.[0]) return null
    return res.filePaths[0]
  })

  ipcMain.handle('avc:ai:models:open-dir', async () => {
    const dir = resolveModelsDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const err = await shell.openPath(dir)
    return { ok: !err, error: err || null }
  })

  /**
   * Безопасная смена каталога моделей (фаза 5.4):
   * валидация → свободное место → копирование → сверка → конфиг → рестарт воркера.
   * Старый каталог НЕ удаляется; при ошибке конфиг не меняется (откат = ничего не делаем).
   */
  ipcMain.handle('avc:ai:models:set-dir', async (_e, args) => {
    const target = String(args?.dir || '').trim()
    if (!target || !path.isAbsolute(target)) {
      return { ok: false, error: 'Нужен абсолютный путь к папке' }
    }
    const source = resolveModelsDir()
    if (path.resolve(target) === path.resolve(source)) {
      return { ok: true, migrated: false, dir: target, message: 'Каталог не изменился' }
    }
    try {
      fs.mkdirSync(target, { recursive: true })
      // пробная запись: права доступа (сетевые/съёмные диски, юникод-пути)
      const probe = path.join(target, `.avc-write-test-${Date.now()}`)
      fs.writeFileSync(probe, 'ok')
      fs.rmSync(probe, { force: true })

      const srcExists = fs.existsSync(source)
      const srcStats = srcExists ? dirStats(source) : { bytes: 0, files: 0 }
      if (srcStats.files > 0) {
        // свободное место на целевом диске
        try {
          const stfs = await fs.promises.statfs(target)
          const free = stfs.bavail * stfs.bsize
          if (free < srcStats.bytes * 1.05) {
            return {
              ok: false,
              error: `Недостаточно места: доступно ${Math.floor(free / 1048576)} МБ, нужно ${Math.ceil(srcStats.bytes / 1048576)} МБ`,
            }
          }
        } catch { /* statfs недоступен — проверим сверкой после копирования */ }
        log(`[Models] Миграция моделей: ${source} → ${target} (${srcStats.files} файлов)`)
        await fs.promises.cp(source, target, { recursive: true, force: false, errorOnExist: false })
        // сверка: количество файлов и суммарный размер должны совпасть
        const dstStats = dirStats(target)
        if (dstStats.files < srcStats.files || dstStats.bytes < srcStats.bytes) {
          return {
            ok: false,
            error: `Сверка после копирования не сошлась: было ${srcStats.files} файлов/${srcStats.bytes} байт, стало ${dstStats.files}/${dstStats.bytes}. Конфиг не изменён, старый каталог сохранён.`,
          }
        }
      }
      writeModelsDirConfig(target)
      // перезапуск воркера с новым каталогом (модели подхватятся с места)
      startAiWorker()
      log(`[Models] Каталог моделей переключён: ${target}`)
      return {
        ok: true,
        migrated: srcStats.files > 0,
        dir: target,
        copiedFiles: srcStats.files,
        copiedBytes: srcStats.bytes,
        message: 'Каталог моделей обновлён',
      }
    } catch (err) {
      log(`[Models] Ошибка миграции: ${err.message}`)
      return {
        ok: false,
        error: `Миграция не удалась: ${err.message}. Конфиг не изменён, старый каталог сохранён.`,
      }
    }
  })
}

/** Минимальная блокировка рекламных доменов в сессии сайта (не мешает входу) */
function setupAdShield() {
  const ses = session.fromPartition(PARTITION)
  const adHosts = /(^|\.)adfinity\.pro$/i
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
    try {
      const host = new URL(details.url).hostname
      cb({ cancel: adHosts.test(host) })
    } catch {
      cb({ cancel: false })
    }
  })
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    // В сессии сайта разрешения не нужны (микрофон живёт в основном окне приложения)
    cb(['fullscreen', 'clipboard-read'].includes(permission))
  })
}

async function runSelftest() {
  log('[Auth] Initializing YummyAnime session (selftest mode)')
  authService = new AuthenticationService({ log, userDataDir: app.getPath('userData') })
  const report = await authService.selftest()
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  authService.shutdown()
  app.exit(report.network === 'ONLINE' ? 0 : 2)
}

/**
 * Основная последовательность запуска. ЛЮБОЕ исключение здесь больше не «умирает
 * молча»: whenReady оборачивает вызов в try/catch и показывает окно ошибки.
 */
async function boot() {
  setupAdShield()

  setSplashStage('Инициализация сессии сайта…')
  authService = new AuthenticationService({
    log,
    userDataDir: app.getPath('userData'),
    onStatus: (msg) => {
      // Статусы входа (капча/ошибка/успех) — в UI приложения как toast-сообщения
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('avc:auth-status', msg)
      }
    },
  })

  authService.subscribe((snap) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('avc:account-changed', snap)
    }
  })

  markStartup('auth-service-ready')

  setupIpc(authService)

  // Локальный AI-слой: utilityProcess запускается сразу, IPC ставится до окна (§49):
  // модели могут отсутствовать — детерминированный голос остаётся рабочим (§0/§129)
  setupAiIpc()
  setSplashStage('Запуск голосового AI-слоя…')
  startAiWorker()

  setSplashStage('Запуск локального сервера…')
  const url = await startNextServer()
  markStartup('next-server-ready')

  setSplashStage('Открытие интерфейса…')
  await createMainWindow(url)
  markStartup('window-created')
  log(`[Main] UI ready at ${url}`)

  // §3.12: сообщить рендереру итог прошлого обновления (успех/не завершилось)
  if (pendingUpdateResult && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.once('did-finish-load', () => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('avc:update:result', pendingUpdateResult)
        }
      } catch { /* окно могли закрыть */ }
    })
  }

  // Фоновая сверка состояния аккаунта при старте (одна проверка, без поллинга)
  void authService.verify().catch(() => undefined)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow(url)
  })
}

app.whenReady().then(async () => {
  flushEarlyLogs() // дальше логи сразу пишутся в файл
  markStartup('app-ready')
  checkPendingUpdate() // §3.12: сверка маркера обновления до UI (результат уйдёт в рендерер)
  log('[Auth] Initializing YummyAnime session (persistent partition)')

  if (SELFTEST) {
    await runSelftest()
    return
  }

  // AI-самопроверка в реальном main-процессе: ЧЕРЕЗ воркер на чистом Node (как в продакшне).
  // РЕЛИЗ 1.0.12: LLM/TTS убраны — проверяем запуск воркера и готовность STT.
  if (AI_SELFTEST) {
    try {
      setupAiIpc()
      startAiWorker()
      const report = {
        ranAt: new Date().toISOString(),
        platform: process.platform,
        electron: process.versions.electron,
        workerStarted: !!aiWorker,
        removedFromRelease: { llm: true, tts: true },
      }
      if (!aiWorker) throw new Error(aiWorkerFailed || 'воркер не запустился')
      // ждём готовности STT (воркер инициализирует её сам, ждём до 120 с)
      let status = null
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        status = await aiWorkerRequest('status')
        if (status.ready.stt) break
      }
      report.models = (status.models || []).map((m) => ({ key: m.key, installed: m.installed }))
      report.services = status.ready
      const ok = report.workerStarted && status.ready.stt === true
      process.stdout.write(`[AI-SELFTEST] ok=${ok} services=${JSON.stringify(status.ready)}\n`)
      try {
        fs.writeFileSync(path.join(__dirname, 'tools', 'ai-main-selftest-report.json'), JSON.stringify(report, null, 2))
      } catch { /* ок */ }
      app.exit(ok ? 0 : 2)
    } catch (e) {
      process.stdout.write(`${JSON.stringify({ error: e.message })}\n`)
      app.exit(3)
    }
    return
  }

  // Обычный запуск: сначала окно запуска (обратная связь с первой секунды),
  // затем вся последовательность старта под watchdog'ом — ЛЮБОЕ исключение
  // показывается в окне ошибки, приложение никогда не «висит молча».
  setupSplashIpc()
  createSplashWindow()
  setSplashStage('Инициализация…')
  try {
    await boot()
  } catch (e) {
    await showFatalError(e)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * УРОК РЕЛИЗА 1.0.13 («в диспетчере задач сидит очень много процессов»):
 * kill() на Windows убивает только сам процесс, а не его дерево — дочерние
 * процессы Next-сервера и AI-воркера переживали закрытие приложения.
 * taskkill /T /F снимает всё дерево гарантированно.
 */
function killProcessTree(child) {
  if (!child || !child.pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', detached: true }).unref()
    } else {
      try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    }
  } catch { /* уже мёртв */ }
}

app.on('before-quit', () => {
  app.isQuitting = true // воркер умирает по нашей команде — без автоперезапуска и уведомлений
  if (authService) authService.shutdown()
  if (aiWorker) {
    killProcessTree(aiWorker)
    aiWorker = null
  }
  if (nextProcess) {
    killProcessTree(nextProcess)
    nextProcess = null
  }
})

// страховка: если что-то пережило before-quit — добиваем на will-quit
app.on('will-quit', () => {
  if (aiWorker) killProcessTree(aiWorker)
  if (nextProcess) killProcessTree(nextProcess)
})

// Защита единственного экземпляра.
// ВАЖНО: молчаливый app.quit() выглядел для пользователя как «EXE не запускается» —
// теперь второй экземпляр ЧЕСТНО сообщает о первом (возможно зависшем) экземпляре.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  try {
    dialog.showErrorBox(
      'AVC-Anime уже запущен',
      'Приложение уже работает — возможно, его окно сейчас скрыто, либо предыдущий '
        + 'экземпляр завершился некорректно.\n\n'
        + 'Если окна нет: закройте AVC-Anime.exe в Диспетчере задач (Ctrl+Shift+Esc → '
        + 'вкладка «Подробности») и запустите приложение заново.',
    )
  } catch { /* ignore */ }
  app.exit(0)
} else {
  app.on('second-instance', () => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : splashWindow
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}
