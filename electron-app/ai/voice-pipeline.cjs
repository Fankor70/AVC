/**
 * VoicePipeline — оркестратор локального голосового слоя AVC-Anime.
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА (релиз 1.0.12): LLM и TTS УБРАНЫ из релиза.
 * Остался только рабочий слой распознавания речи:
 *   STT (sherpa-onnx, T-One Russian + Silero VAD) — частичные/финальные
 *   транскрипты + EarlyCommandDetector (безопасные частичные фразы).
 *
 * Архитектура (единая точка исполнения):
 *   ЭКСПУАТАЦИЯ: детерминированный парсер рендерера (parser.ts) остаётся единственным
 *   исполнителем команд. Main-процесс добавляет:
 *     1. STT-события (partial/final) → рендерер → СУЩЕСТВУЮЩИЙ парсер → СУЩЕСТВУЮЩИЙ executor;
 *     2. EarlyCommandDetector: безопасные ЧАСТИЧНЫЕ фразы → рендереру как
 *        'early-command' { type } — рендерер исполняет через ТОТ ЖЕ executor;
 *        опасное (удали/оценка/аккаунт) рано НЕ исполняется никогда.
 *
 * Слои LLM/TTS были удалены честно: контракт status/IPC сохранён (готовность = false),
 * чтобы main-процесс и UI не ломались, но воркер больше НЕ содержит их код и
 * пак с нативными зависимостями llama.cpp/sherpa-TTS не собирается (§113).
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const { AIModelManager } = require('./model-manager.cjs')
const { checkModelIntegrity, checkVadIntegrity, quarantineModel, listQuarantined } = require('./model-integrity.cjs')
const { createSttEngine, engineForModel, sttModelFilesPresent, resolveSttModelId, DEFAULT_STT_MODEL } = require('./stt-engines.cjs')

/** Честная причина недоступности убранных слоёв (для UI/диагностики) */
const REMOVED_REASON = 'Убрано из релиза (решение владельца, 1.0.12)'

/** §12: безопасные ранние команды — только очевидные и обратимые действия плеера/навигации.
 *  Частичные фразы STT обрезают окончания, поэтому допускаются НЕПОЛНЫЕ слова,
 *  но только для тех команд, где ложное срабатывание безвредно (пауза/громкость). */
const EARLY_SAFE_PATTERNS = [
  { re: /^(следующ\w*|дальше|вперёд|next)\b.*$/, type: 'NextEpisode' },
  { re: /^(предыдущ\w*|назад|previous)\b.*$/, type: 'PreviousEpisode' },
  { re: /^(пау|пауз\w*|стоп|останови\w*)\s*\.?$/, type: 'Pause' },
  { re: /^(продолж\w*|плей|играть|play)\s*\.?$/, type: 'Play' },
  { re: /^громче\s*\.?$/, type: 'VolumeUp' },
  { re: /^тише\s*\.?$/, type: 'VolumeDown' },
  { re: /^(без звука|выключи звук)\s*\.?$/, type: 'Mute' },
  { re: /^(со звуком|включи звук)\s*\.?$/, type: 'Unmute' },
]

/** §13: опасные намерения — НИКОГДА не исполняются по частичной фразе */
const UNSAFE_PATTERN = /(удал|убер|сн[иь]м|оцен|выйд|войд|аккаунт|списк|загрузк|коммент)/i

class VoicePipeline extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.modelsDir = opts.modelsDir || path.join(__dirname, '..', 'models')
    this.profile = opts.profile || 'max_responsiveness'
    this.enabled = opts.enabled !== false // §0/§129: AI — модульное расширение, можно отключить
    /** Модель-исключение (безопасный режим после нативного краша): её НЕ выбираем,
     *  пока пользователь явно не вернёт её (переустановка/активация в Настройках). */
    this.excludeModelId = opts.excludeModel || process.env.AVC_EXCLUDE_MODEL || null
    /** Активная модель STT (каталог моделей); движок выбирается по модели.
     *  Релиз 1.0.15: по умолчанию GigaAM v3 (точная). Если её файлов нет —
     *  честный fallback на установленную (T-One), чтобы приложение работало сразу.
     *  Урок 0xC0000409: «установленная» = файлы на месте И целостность пройдена. */
    this.activeModelId = resolveSttModelId(this.modelsDir, opts.modelId || DEFAULT_STT_MODEL, this.excludeModelId)
    /** Модель, запрошенная конфигом (до fallback) — для честного статуса в UI */
    this.requestedModelId = opts.modelId || DEFAULT_STT_MODEL

    this.manager = new AIModelManager({ baseDir: this.modelsDir })
    this.stt = createSttEngine({ modelsDir: this.modelsDir, profile: this.profile, modelId: this.activeModelId })

    /** Информация о последнем карантине (для честного UI) */
    this.quarantine = null

    // если ЗАПРОШЕННАЯ модель битая (файлы есть, целостности нет) — карантируем сразу:
    // иначе она навсегда остаётся невидимым «мине» (повторный краш при переключении)
    this._quarantineDamaged(this.requestedModelId)

    /** исполненные ранние команды (§14): utteranceId → type */
    this._executedEarly = new Map()
    this._lastEarlyText = ''
    this._wireStt()
  }

  /**
   * Если файлы модели на месте, но целостность нарушена — карантин (переименование)
   * + запись в this.quarantine. Возвращает true, если модель была повреждена.
   * Урок 0xC0000409: битый каталог нельзя оставлять «выглядящим установленным».
   */
  _quarantineDamaged(modelId) {
    try {
      if (!sttModelFilesPresent(this.modelsDir, modelId)) return false
      const integ = checkModelIntegrity(this.modelsDir, modelId)
      if (integ.ok) return false
      const q = quarantineModel(this.modelsDir, modelId, integ.problems.join('; '))
      this.quarantine = {
        modelId,
        reason: integ.problems.join('; '),
        to: (q && q.to) || null,
        at: new Date().toISOString(),
      }
      return true
    } catch {
      // сбой карантина не должен ронять воркер — честно запишем и продолжим
      return false
    }
  }

  /** Мостинг событий движка наружу с проверкой ранних команд (§12) */
  _wireStt() {
    this.stt.on('partial', (p) => {
      const early = this._detectEarly(p.text, p.utteranceId)
      this.emit('stt-partial', { ...p, earlyCommand: early ? early.type : null })
    })
    this.stt.on('final', (p) => {
      // если раннее исполнение уже произошло для этой фразы — помечаем final как дедуплицированный
      const alreadyEarly = this._executedEarly.get(p.utteranceId) || null
      this.emit('stt-final', { ...p, earlyCommandType: alreadyEarly })
    })
    this.stt.on('status', (s) => this.emit('services-status', this.getStatus().ready))
  }

  /** Общий статус для AI Setup/диагностики (§97) */
  getStatus() {
    const st = this.manager.status()
    // РЕЛИЗ 1.0.12: llm/tts убраны из статуса вместе со слоями (решение владельца)
    return {
      enabled: this.enabled,
      profile: this.profile,
      modelsDir: this.modelsDir,
      models: st.components,
      freeDisk: st.freeDisk,
      activeModel: this.activeModelId,
      requestedModel: this.requestedModelId,
      modelFallback: this.activeModelId !== this.requestedModelId,
      excludeModel: this.excludeModelId || null,
      quarantine: this.quarantine,
      quarantinedDirs: listQuarantined(this.modelsDir),
      engine: engineForModel(this.activeModelId)?.id || 't-one-streaming',
      benchmark: this.benchmarkResult || null,
      stt: this.stt.getMetrics(),
      ready: {
        stt: this.stt.isReady(),
      },
    }
  }

  /** Аппаратная информация для первого запуска (§50) */
  async getHardware() {
    const os = require('os')
    const { freeDiskSpace, fmtBytes } = require('./model-manager.cjs')
    let gpu = null
    try {
      // В Electron main: app.getGPUInfo; вне electron — null (честно)
      const electron = require('electron')
      if (electron && electron.app && electron.app.getGPUInfo) {
        const info = await electron.app.getGPUInfo('basic')
        const dev = info && info.gpuDevice && info.gpuDevice[0]
        gpu = dev ? { vendor: dev.vendorId, device: dev.deviceId, name: dev.deviceString || null } : null
      }
    } catch { /* не electron — gpu null */ }
    return {
      cpu: `${os.cpus()[0]?.model || 'unknown'} ×${os.cpus().length}`,
      cpuCount: os.cpus().length,
      ramBytes: os.totalmem(),
      ramHuman: fmtBytes(os.totalmem()),
      freeDisk: freeDiskSpace(this.modelsDir),
      platform: `${os.platform()} ${os.arch()}`,
      gpu,
    }
  }

  /** §50–§53: установка компонентов (кнопка Install) — STT/VAD включая каталог "stt:<id>" */
  async installComponents(keys, opts = {}) {
    const allowed = (k) => k === 'stt' || k === 'vad' || k.startsWith('stt:') || k.startsWith('vad:')
    const wanted = keys.filter(allowed)
    const results = []
    for (const key of wanted) {
      try {
        // если модель в карантине/под исключением и её ставят заново — снимаем карантин
        const installedId = key.startsWith('stt:') ? key.slice(4) : null
        if (installedId && (installedId === this.excludeModelId || installedId === (this.quarantine && this.quarantine.modelId))) {
          this.excludeModelId = null
          this.quarantine = null
          this.requestedModelId = installedId
        }
        const r = await this.manager.install(key, opts)
        results.push({ key, ok: true, skipped: !!r.skipped })
        // установили компонент STT — инициализируем движок сразу
        if (key === 'stt') {
          await this.initializeServices()
        } else if (key.startsWith('stt:')) {
          if (installedId === this.activeModelId) {
            // установили уже активную модель (или её файлы) — инициализируем
            await this.initializeServices()
          } else if (this.requestedModelId === installedId && this.activeModelId !== installedId) {
            // активная модель была fallback'ом (запрошенной не было) — теперь
            // желаемая установлена: переключаемся на неё сразу
            const sw = await this.setSttModel(installedId)
            if (!sw.ok) results.push({ key, ok: false, kind: 'SWITCH_FAILED', message: sw.message })
          }
        }
      } catch (e) {
        results.push({ key, ok: false, kind: e.kind || 'ERROR', message: e.message })
      }
    }
    for (const key of keys.filter((k) => !allowed(k))) {
      results.push({ key, ok: false, kind: 'REMOVED', message: REMOVED_REASON })
    }
    return results
  }

  /** Удалить модель каталога (перед удалением движок должен быть переключён/выгружен) */
  async removeComponent(key) {
    try {
      const r = await this.manager.remove(key)
      return { ok: true, ...r }
    } catch (e) {
      return { ok: false, message: e.message }
    }
  }

  /** Проверить установленную модель (файлы/маркер) */
  async verifyComponent(key) {
    try {
      return await this.manager.verify(key)
    } catch (e) {
      return { ok: false, message: e.message }
    }
  }

  /** Каталог моделей для UI (статусы/лицензии/рекомендации) */
  getCatalog() {
    return this.manager.catalogStatus()
  }

  cancelInstall(key) {
    this.manager.cancel(key)
  }

  /**
   * Инициализация STT (единственный оставшийся AI-сервис).
   * UI не блокируется: вызывается фоном после создания окна.
   *
   * УРОК 0xC0000409 (GitHub issue #2): повреждённая модель = нативный краш всего
   * воркера. Здесь: пред-проверка целостности → карантин битой модели → честный
   * авто-fallback на здоровую, чтобы голос работал даже после битой установки.
   */
  async initializeServices() {
    const out = {}

    // если запрошенная модель битая — карантируем и честно переключаемся на здоровую
    if (sttModelFilesPresent(this.modelsDir, this.activeModelId)) {
      const integ = checkModelIntegrity(this.modelsDir, this.activeModelId)
      if (!integ.ok) {
        this._quarantineDamaged(this.activeModelId)
        const healthy = resolveSttModelId(this.modelsDir, null, this.activeModelId)
        if (healthy && healthy !== this.activeModelId) {
          this.activeModelId = healthy
          try { this.stt.shutdown() } catch { /* ок */ }
          this.stt = createSttEngine({ modelsDir: this.modelsDir, profile: this.profile, modelId: healthy })
          this._wireStt()
        } else {
          // здоровой альтернативы нет — честная ошибка без нативного вызова
          if (!sttModelFilesPresent(this.modelsDir, this.activeModelId)) {
            this.emit('services-status', this.getStatus().ready)
            return { stt: { state: 'failed', error: `Модель ${this.activeModelId} повреждена и помещена в карантин. Скачайте модель заново в Настройках → AI.` } }
          }
        }
      }
    }

    // VAD общий для всех движков — тоже не пропускаем битым
    const vadInteg = checkVadIntegrity(this.modelsDir)
    if (!vadInteg.ok && sttModelFilesPresent(this.modelsDir, this.activeModelId)) {
      out.stt = { state: 'failed', error: `Silero VAD повреждён (${vadInteg.problems[0]})` }
      this.emit('services-status', this.getStatus().ready)
      return out
    }

    if (sttModelFilesPresent(this.modelsDir, this.activeModelId)) out.stt = await this.stt.initialize()
    this.emit('services-status', this.getStatus().ready)
    return out
  }

  /**
   * Смена активной модели STT (hexagonal: движок заменяется целиком).
   * Если модель не установлена — честный отказ, старый движок продолжает работать.
   */
  async setSttModel(modelId) {
    const spec = engineForModel(modelId)
    if (!spec) return { ok: false, message: `Неизвестная модель: ${modelId}` }
    if (!sttModelFilesPresent(this.modelsDir, modelId)) {
      return { ok: false, message: `Модель ${modelId} не установлена — сначала скачайте её` }
    }
    // урок 0xC0000409: повреждённую модель НЕ грузим — честный отказ
    const integ = checkModelIntegrity(this.modelsDir, modelId)
    if (!integ.ok) {
      return { ok: false, message: `Модель ${modelId} повреждена (${integ.problems[0]}) — удалите и скачайте заново` }
    }
    const old = this.stt
    this.activeModelId = modelId
    // явный выбор пользователя снимает безопасный режим и меняет «запрошенную»:
    // иначе статус показал бы ложный fallback («модель X не установлена») до перезапуска
    this.requestedModelId = modelId
    this.excludeModelId = null
    this.stt = createSttEngine({ modelsDir: this.modelsDir, profile: this.profile, modelId })
    this._wireStt()
    try { old.shutdown() } catch { /* ок */ }
    const state = await this.stt.initialize()
    this.emit('services-status', this.getStatus().ready)
    return { ok: state === 'ready', message: state === 'ready' ? `Активная модель: ${modelId}` : (this.stt.error || String(state)) }
  }

  /**
   * Бенчмарк «Проверить скорость на этом ПК» (спецификация STT): декодирование
   * тестового WAV активным движком → RTF и задержка; рекомендация профиля.
   * RTF > 0.5 на слабом ПК → max_responsiveness + стриминговая модель.
   */
  async benchmark() {
    const wav = path.join(this.modelsDir, 'stt', 't-one-russian', '0.wav')
    if (!this.stt.isReady()) {
      return { ok: false, message: 'STT не готов — сначала установите и инициализируйте модель' }
    }
    if (!fs.existsSync(wav)) {
      return { ok: false, message: 'Тестовый WAV не найден в каталоге модели T-One (0.wav)' }
    }
    try {
      const { readWavAsFloat32 } = require('./stt-service.cjs')
      const { samples, sampleRate } = readWavAsFloat32(wav)
      const audioMs = Math.round((samples.length / sampleRate) * 1000)
      const t0 = Date.now()
      const res = this.stt.decodeFileForTest
        ? this.stt.decodeFileForTest(wav)
        : (() => { // движок без decodeFileForTest — прогон через feed/flush
            const n = Math.floor(samples.length / 2)
            const int16 = new Int16Array(n)
            for (let i = 0; i < n; i++) int16[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)))
            this.stt.feed(int16)
            this.stt.flush()
            return { ms: Date.now() - t0 }
          })()
      const decodeMs = Date.now() - t0
      const rtf = audioMs > 0 ? Math.round((decodeMs / audioMs) * 1000) / 1000 : null
      const recommendedProfile = rtf !== null && rtf > 0.5 ? 'max_responsiveness' : this.profile
      const recommendation = rtf !== null && rtf > 0.5
        ? 'ПК слабый для офлайн-декода — рекомендуется стриминговая модель (ru-fast) и профиль «Максимальная отзывчивость»'
        : rtf !== null && rtf > 0.25
          ? 'Скорость приемлемая; при лагах переключитесь на профиль «Максимальная отзывчивость»'
          : 'Скорость отличная — можно использовать точную модель и профиль «Качество»'
      this.benchmarkResult = { ranAt: new Date().toISOString(), audioMs, decodeMs, rtf, text: (res.text || '').slice(0, 120), recommendedProfile, recommendation }
      return { ok: true, ...this.benchmarkResult }
    } catch (e) {
      return { ok: false, message: e.message }
    }
  }

  /**
   * Поэтапная инициализация: сейчас только STT (голос готов ASAP).
   * Имя сохранено для совместимости вызовов (§49 + фаза 2 аудита).
   */
  async initializeCoreThenDeferred() {
    return this.initializeServices()
  }

  /** Совместимость со старыми вызовами (больше нечего догружать) */
  async initializeDeferred() {
    return this.initializeServices()
  }

  /**
   * §12: EarlyCommandDetector — распознавание безопасных намерений по ЧАСТИЧНОЙ транскрипции.
   * Возвращает { type } или null. Дедупликация: одна ранне-исполненная команда на utterance.
   */
  _detectEarly(partialText, utteranceId) {
    if (!partialText) return null
    const t = String(partialText).trim().toLowerCase().replace(/\s+/g, ' ')
    if (t.length < 3) return null
    if (UNSAFE_PATTERN.test(t)) return null // §13
    if (t === this._lastEarlyText) return null // тот же partial — не дублируем
    for (const p of EARLY_SAFE_PATTERNS) {
      if (p.re.test(t)) {
        const prev = this._executedEarly.get(utteranceId)
        if (prev && prev !== p.type) return null // на одну фразу — одно раннее исполнение
        if (!prev) {
          this._executedEarly.set(utteranceId, p.type)
          // ограничиваем память реестра
          if (this._executedEarly.size > 200) {
            const firstKey = this._executedEarly.keys().next().value
            this._executedEarly.delete(firstKey)
          }
        }
        this._lastEarlyText = t
        return { type: p.type, matched: t }
      }
    }
    return null
  }

  /** §14: пометка рендерером исполненного final (текст уже исполнился по partial) */
  markUtteranceHandled(utteranceId, type) {
    this._executedEarly.set(Number(utteranceId), type || 'handled')
  }

  /** Подача аудио из рендерера (Int16Array 16 кГц) — путь живого микрофона (§6, §8) */
  feedAudio(int16Samples) {
    if (!this.enabled) return
    this.stt.feed(int16Samples)
  }

  flushAudio() {
    this.stt.flush()
  }

  /** Режим рации (push-to-talk): аудио без VAD-гейта, финал по flushAudio */
  setCaptureMode(on) {
    try {
      this.stt.setCaptureMode && this.stt.setCaptureMode(!!on)
    } catch { /* движок без поддержки — работаем как раньше */ }
  }

  shutdown() {
    try {
      this.stt.shutdown()
    } catch { /* ок */ }
  }
}

module.exports = { VoicePipeline, EARLY_SAFE_PATTERNS, UNSAFE_PATTERN, REMOVED_REASON }
