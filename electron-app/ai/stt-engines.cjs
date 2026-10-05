/**
 * stt-engines — реестр движков распознавания (hexagonal: SttEngineRegistry).
 *
 * Ядро пайплайна (VAD → сегментация → результат) зависит только от интерфейса:
 *
 *   engine = {
 *     id, capabilities: { streaming, hotwords, nbest, punctuation },
 *     initialize() -> state,        // 'ready' | 'failed' (не бросает)
 *     feed(int16Samples),           // 16 кГц mono Int16
 *     flush(), resetUtterance(),
 *     isReady(), getMetrics(), shutdown(),
 *     on('partial' { utteranceId, text, ms }), on('final' { utteranceId, text, reason, ms })
 *   }
 *
 * Новый движок = один adapter + запись в ENGINES/каталоге моделей. Код пайплайна
 * (voice-pipeline, ai-worker) не меняется.
 *
 * Движки:
 *  - t-one-streaming: T-One Streaming CTC 8 кГц (обёртка над проверенным STTService,
 *    частичные результаты в реальном времени) — профиль «ru-fast»;
 *  - gigaam-offline: GigaAM v2/v3 (NeMo CTC / transducer, 16 кГц, int8) — профиль
 *    «ru-accurate»: декодирование фразы целиком после endpoint'а VAD, без partial'ов.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

const { STTService, PROFILES, SAMPLE_RATE_VAD } = require('./stt-service.cjs')
const { checkModelIntegrity, checkVadIntegrity } = require('./model-integrity.cjs')

const SAMPLE_RATE_GIGAAM = 16000

/** Модель по умолчанию (релиз 1.0.15): GigaAM v3 точная — «Наруто 20 серия» вместо «уратуту нараратутто» на T-One 8 кГц */
const DEFAULT_STT_MODEL = 'gigaam-v3-russian'

/**
 * УРОК ИНЦИДЕНТА v1.0.19 (0xC0000409): файлы есть, но повреждены — грузить их в
 * sherpa-onnx НЕЛЬЗЯ (нативный краш процесса). Разрешение модели учитывает
 * целостность, а не только существование файлов.
 *
 * @param {string} modelsDir
 * @param {string} preferred
 * @param {string|null} exclude модель-исключение (безопасный режим после нативного краша)
 */
function resolveSttModelId(modelsDir, preferred, exclude) {
  const chain = [preferred, DEFAULT_STT_MODEL, 't-one-russian', 'gigaam-v2-russian'].filter(
    (id, i, a) => id && a.indexOf(id) === i,
  )
  for (const id of chain) {
    if (exclude && id === exclude) continue
    // здоровая = файлы на месте И целостность пройдена (не битый ONNX)
    if (sttModelFilesPresent(modelsDir, id) && checkModelIntegrity(modelsDir, id).ok) return id
  }
  // ничего здорового не установлено — возвращаем предпочитаемый (ошибка будет честной при initialize)
  return preferred || DEFAULT_STT_MODEL
}

function lazySherpa() {
  try {
    // eslint-disable-next-line global-require
    return require('sherpa-onnx-node')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// GigaAM offline-движок (v2 CTC / v3 transducer, 16 кГц)
// ---------------------------------------------------------------------------

/** Найти файл модели: int8 предпочтительнее (спецификация: int8-модели) */
function pickModelFile(dir, prefixes) {
  const names = fs.existsSync(dir) ? fs.readdirSync(dir) : []
  for (const prefix of prefixes) {
    const int8 = names.find((n) => n.startsWith(prefix) && n.endsWith('.int8.onnx'))
    if (int8) return path.join(dir, int8)
    const fp32 = names.find((n) => n.startsWith(prefix) && n.endsWith('.onnx'))
    if (fp32) return path.join(dir, fp32)
  }
  return null
}

class GigaamOfflineEngine extends EventEmitter {
  /**
   * @param {object} opts { modelsDir, profile, modelId: 'gigaam-v3-russian' | 'gigaam-v2-russian' }
   */
  constructor(opts = {}) {
    super()
    this.modelsDir = opts.modelsDir || path.join(__dirname, '..', 'models')
    this.profileKey = PROFILES[opts.profile] ? opts.profile : 'max_responsiveness'
    this.modelId = opts.modelId || 'gigaam-v3-russian'
    this.capabilities = { streaming: false, hotwords: false, nbest: false, punctuation: false }
    this.state = 'uninitialized'
    this.error = null
    this.metrics = {
      modelLoadMs: null,
      warmupMs: null,
      lastFinalMs: null,
      lastEndpointMs: null,
      utterances: 0,
    }
    this.utteranceSeq = 0
    // VAD-состояние (то же колесо, что у стримингового движка: окно 512 @16 кГц)
    this._ring = []
    this._inSpeech = false
    this._tailWindows = 0
    this._utteranceSamples = [] // Float32 16 кГц текущей фразы (декодируем целиком)
    // Режим рации: всё аудио без VAD-гейта (см. STTService.setCaptureMode)
    this._captureMode = false
  }

  get modelDir() {
    return path.join(this.modelsDir, 'stt', this.modelId)
  }

  get vadFile() {
    return path.join(this.modelsDir, 'vad', 'silero-vad', 'silero_vad.onnx')
  }

  static modelFilesPresent(modelsDir, modelId) {
    const dir = path.join(modelsDir, 'stt', modelId)
    const tokens = path.join(dir, 'tokens.txt')
    const hasModel =
      pickModelFile(dir, ['model']) !== null || pickModelFile(dir, ['encoder']) !== null
    return fs.existsSync(tokens) && hasModel
  }

  async initialize() {
    if (this.state === 'ready' || this.state === 'loading') return this.state
    this.state = 'loading'
    const t0 = Date.now()
    try {
      // ПРЕД-ПОЛЁТНАЯ проверка целостности (урок 0xC0000409): битый ONNX в sherpa-onnx
      // вызывает необработанное C++ исключение → мгновенная смерть процесса (try/catch
      // бессилен). Проверяем чистым Node ДО любого нативного вызова.
      const integ = checkModelIntegrity(this.modelsDir, this.modelId)
      if (!integ.ok) {
        throw new Error(`Файлы модели ${this.modelId} повреждены (${integ.problems[0]}) — удалите и скачайте заново в Настройках → AI`)
      }
      const vadInteg = checkVadIntegrity(this.modelsDir)
      if (!vadInteg.ok) {
        throw new Error(`Silero VAD повреждён/не установлен (${vadInteg.problems[0]}) — скачайте его в Настройках → AI`)
      }
      const sherpa = lazySherpa()
      if (!sherpa) throw new Error('Пакет sherpa-onnx-node не установлен (нативный рантайм отсутствует)')

      const profile = PROFILES[this.profileKey]
      this._vad = new sherpa.Vad({
        sileroVad: { model: this.vadFile, version: 4 },
        threshold: profile.threshold,
        minSpeechDuration: profile.minSpeech,
        minSilenceDuration: profile.minSilence,
        windowSize: 512,
        maxSpeechDuration: 15,
        sampleRate: SAMPLE_RATE_VAD,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      }, 120)

      const tokens = path.join(this.modelDir, 'tokens.txt')
      const encoder = pickModelFile(this.modelDir, ['encoder'])
      if (encoder) {
        // GigaAM v3 — NeMo transducer (encoder/decoder/joiner)
        const decoder = pickModelFile(this.modelDir, ['decoder'])
        const joiner = pickModelFile(this.modelDir, ['joiner'])
        if (!decoder || !joiner) throw new Error('Архив модели неполон: нет decoder/joiner')
        this._recognizer = new sherpa.OfflineRecognizer({
          featConfig: { sampleRate: SAMPLE_RATE_GIGAAM, featureDim: 80 },
          modelConfig: {
            transducer: { encoder, decoder, joiner },
            tokens,
            numThreads: profile.numThreads,
            provider: 'cpu',
            debug: 0,
          },
          decodingMethod: 'greedy_search',
        })
      } else {
        // GigaAM v2 — NeMo CTC
        const model = pickModelFile(this.modelDir, ['model'])
        this._recognizer = new sherpa.OfflineRecognizer({
          featConfig: { sampleRate: SAMPLE_RATE_GIGAAM, featureDim: 80 },
          modelConfig: {
            nemoCtc: { model },
            tokens,
            numThreads: profile.numThreads,
            provider: 'cpu',
            debug: 0,
          },
          decodingMethod: 'greedy_search',
        })
      }

      // warm-up: 1 с тишины — первый реальный запрос не тормозит
      const tWarm = Date.now()
      try {
        const warm = this._recognizer.createStream()
        warm.acceptWaveform({ sampleRate: SAMPLE_RATE_GIGAAM, samples: new Float32Array(SAMPLE_RATE_GIGAAM) })
        this._recognizer.decode(warm)
      } catch { /* warm-up не обязателен к успеху */ }
      this.metrics.modelLoadMs = Date.now() - t0
      this.metrics.warmupMs = Date.now() - tWarm
      this.state = 'ready'
      this.emit('status', { state: this.state, modelLoadMs: this.metrics.modelLoadMs })
      return this.state
    } catch (e) {
      this.state = 'failed'
      this.error = e.message
      this.emit('status', { state: this.state, error: this.error })
      return this.state
    }
  }

  isReady() {
    return this.state === 'ready'
  }

  /** Окно аудио → VAD → накопление фразы → декодирование целиком на endpoint */
  feed(int16Samples) {
    if (!this.isReady()) return
    const win = 512
    let offset = 0
    while (offset + win <= int16Samples.length) {
      const chunk = int16Samples.subarray(offset, offset + win)
      offset += win
      const f32 = new Float32Array(win)
      for (let i = 0; i < win; i++) f32[i] = chunk[i] / 32768
      try {
        this._vad.acceptWaveform(f32)
      } catch {
        return
      }
      const isSpeech =
        this._captureMode || (this._vad.isDetected() && Date.now() > (this._cooldownUntil || 0))
      if (isSpeech) {
        if (!this._inSpeech) {
          this._inSpeech = true
          this._utteranceStart = Date.now()
          this._utteranceSamples = []
          // предыстория из кольца — чтобы не терять начало слова
          for (const rc of this._ring) this._accumulate(rc)
        }
        this._ring = []
        this._tailWindows = 0
        this._accumulate(chunk)
      } else if (this._inSpeech) {
        this._accumulate(chunk)
        this._tailWindows += 1
        const tailMs = this._tailWindows * (win / SAMPLE_RATE_VAD) * 1000
        if (tailMs >= 200 && !this._captureMode) this._finishUtterance('endpoint')
      } else {
        this._ring.push(Int16Array.from(chunk))
        if (this._ring.length > 38) this._ring.shift()
      }
    }
  }

  _accumulate(chunk16) {
    for (let i = 0; i < chunk16.length; i++) {
      this._utteranceSamples.push(chunk16[i] / 32768)
    }
  }

  /** Декодировать накопленную фразу целиком (offline-движок без partial'ов) */
  _finishUtterance(reason) {
    if (!this._inSpeech) return
    const samples = new Float32Array(this._utteranceSamples)
    this._utteranceSamples = []
    this._inSpeech = false
    this._tailWindows = 0
    this._cooldownUntil = Date.now() + 250
    if (samples.length < SAMPLE_RATE_GIGAAM * 0.3) return // короче 300 мс — мусор
    const t0 = Date.now()
    let text = ''
    try {
      const stream = this._recognizer.createStream()
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE_GIGAAM, samples })
      this._recognizer.decode(stream)
      const r = this._recognizer.getResult(stream)
      text = r && r.text ? String(r.text).trim() : ''
    } catch {
      text = ''
    }
    this.utteranceSeq += 1
    this.metrics.utterances += 1
    this.metrics.lastFinalMs = Date.now() - this._utteranceStart
    this.metrics.lastEndpointMs = Date.now() - t0
    this.emit('final', { utteranceId: this.utteranceSeq, text, reason, ms: Date.now() - this._utteranceStart })
  }

  /** Режим рации: включение сразу начинает фразу, выключение — завершает */
  setCaptureMode(on) {
    const next = !!on
    if (next === this._captureMode) return
    this._captureMode = next
    if (next && this.isReady() && !this._inSpeech) {
      this._inSpeech = true
      this._utteranceStart = Date.now()
      this._utteranceSamples = []
      for (const rc of this._ring) this._accumulate(rc)
      this._ring = []
    }
    if (!next && this._inSpeech) this._finishUtterance('flush')
  }

  flush() {
    this._finishUtterance('flush')
  }

  resetUtterance() {
    this._inSpeech = false
    this._tailWindows = 0
    this._utteranceSamples = []
    this._ring = []
  }

  /** Прямое декодирование файла (бенчмарк/selftest) — НЕ путь живого микрофона */
  decodeFileForTest(wavPath) {
    if (!this.isReady()) throw new Error('STT не инициализирован')
    const { readWavAsFloat32 } = require('./stt-service.cjs')
    const { samples, sampleRate } = readWavAsFloat32(wavPath)
    let s16k = samples
    if (sampleRate === 8000) {
      // 8 → 16 кГц дублированием (для тестового файла допустимо)
      s16k = new Float32Array(samples.length * 2)
      for (let i = 0; i < samples.length; i++) {
        s16k[2 * i] = samples[i]
        s16k[2 * i + 1] = samples[i]
      }
    } else if (sampleRate !== 16000) {
      throw new Error(`Неподдерживаемая частота в бенчмарке: ${sampleRate}`)
    }
    const stream = this._recognizer.createStream()
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE_GIGAAM, samples: s16k })
    this._recognizer.decode(stream)
    const r = this._recognizer.getResult(stream)
    return { text: r && r.text ? r.text.trim() : '' }
  }

  getMetrics() {
    return { ...this.metrics, state: this.state, profile: this.profileKey, error: this.error }
  }

  shutdown() {
    try {
      this._recognizer = null
      this._vad = null
      this.state = 'uninitialized'
    } catch { /* ок */ }
  }
}

/**
 * Установлены ли файлы модели и VAD (без загрузки нативного рантайма).
 * Единая точка проверки присутствия для pipeline/UI/инициализации.
 */
function sttModelFilesPresent(modelsDir, modelId) {
  const vad = fs.existsSync(path.join(modelsDir, 'vad', 'silero-vad', 'silero_vad.onnx'))
  if (!vad) return false
  if (!modelId || modelId === 't-one-russian') {
    return fs.existsSync(path.join(modelsDir, 'stt', 't-one-russian', 'model.onnx'))
  }
  return GigaamOfflineEngine.modelFilesPresent(modelsDir, modelId)
}

// ---------------------------------------------------------------------------
// Реестр движков (SttEngineRegistry): новый движок = одна запись + adapter
// ---------------------------------------------------------------------------

const ENGINES = {
  't-one-streaming': {
    id: 't-one-streaming',
    title: 'T-One Streaming (быстрый)',
    capabilities: { streaming: true, hotwords: false, nbest: false, punctuation: false },
    modelIds: ['t-one-russian'],
    create: (opts) => new STTService(opts),
  },
  'gigaam-offline': {
    id: 'gigaam-offline',
    title: 'GigaAM (точный, offline)',
    capabilities: { streaming: false, hotwords: false, nbest: false, punctuation: false },
    modelIds: ['gigaam-v3-russian', 'gigaam-v2-russian'],
    create: (opts) => new GigaamOfflineEngine(opts),
  },
}

/** Каталог → движок: какая модель какой движок загружает */
function engineForModel(modelId) {
  for (const engine of Object.values(ENGINES)) {
    if (engine.modelIds.includes(modelId)) return engine
  }
  return null
}

/**
 * Создать движок по активной модели. Неизвестная/неустановленная модель →
 * стриминговый T-One (безопасный дефолт, он же профиль ru-fast).
 */
function createSttEngine(opts = {}) {
  const modelId = opts.modelId || DEFAULT_STT_MODEL
  const engineSpec = engineForModel(modelId) || engineForModel(DEFAULT_STT_MODEL) || ENGINES['t-one-streaming']
  const engine = engineSpec.create({ ...opts, engineId: engineSpec.id })
  engine.capabilities = engineSpec.capabilities
  return engine
}

module.exports = {
  ENGINES,
  GigaamOfflineEngine,
  createSttEngine,
  engineForModel,
  sttModelFilesPresent,
  resolveSttModelId,
  DEFAULT_STT_MODEL,
  PROFILES,
  SAMPLE_RATE_GIGAAM,
  SAMPLE_RATE_VAD,
  EventEmitter,
}
