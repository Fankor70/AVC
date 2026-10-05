/**
 * STTService — локальное стриминговое распознавание русской речи (спецификация §5–§21).
 *
 *   микрофон (рендерер, PCM 16 кГц mono) → IPC → Silero VAD (16 кГц) →
 *   ресемпл 8 кГц → T-One Streaming CTC (sherpa-onnx) → частичные/финальные результаты
 *
 * Требования спецификации, реализованные здесь:
 *   §5–§7   T-One streaming CTC, модель загружается ОДИН раз, warm-up, никогда не перегружается;
 *   §6      НЕ batch/WAV: непрерывный поток, частичные результаты;
 *   §10     Silero VAD постоянно активен, тишина не тратит ходов распознавателя;
 *   §11–§12 partial'ы отдаются наружу сразу (early command detection решает рендерер);
 *   §14     дедупликация по utteranceId (final уходит один раз);
 *   §15–§16 быстрый endpointing (адаптивное окно тишины), метрики честные;
 *   §19     профили: max-responsiveness / balanced / quality (threads, endpoint);
 *   §21     измеряются все задержки (vad, partial, final, endpoint).
 *
 * Модуль НЕ зависит от electron — автономно тестируется (selftest) на любом Node ≥18.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const { checkModelIntegrity, checkVadIntegrity } = require('./model-integrity.cjs')

const SAMPLE_RATE_STT = 8000 // T-One: 8 кГц (спецификация §5)
const SAMPLE_RATE_VAD = 16000 // Silero VAD: 16 кГц

/** Профили производительности (§19).
 *  Релиз 1.0.15 — быстрее финал после конца речи (жалоба: «много времени проходит,
 *  и только потом распознаёт»): minSilence (Silero: конец речи) 0.35→0.25 с,
 *  хвост тишины в пайплайне 250→200 мс, кулдаун 350→250 мс. */
const PROFILES = {
  max_responsiveness: { numThreads: 1, minSilence: 0.25, threshold: 0.5, minSpeech: 0.15 },
  balanced: { numThreads: 2, minSilence: 0.4, threshold: 0.5, minSpeech: 0.2 },
  quality: { numThreads: 3, minSilence: 0.6, threshold: 0.45, minSpeech: 0.25 },
}

function lazySherpa() {
  try {
    // eslint-disable-next-line global-require
    return require('sherpa-onnx-node')
  } catch (e) {
    return null
  }
}

class STTService extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.modelsDir = opts.modelsDir || path.join(__dirname, '..', 'models')
    this.profileKey = PROFILES[opts.profile] ? opts.profile : 'max_responsiveness'
    this.state = 'uninitialized' // uninitialized | loading | ready | failed
    this.error = null
    this.metrics = {
      modelLoadMs: null,
      warmupMs: null,
      lastPartialMs: null,
      lastFinalMs: null,
      lastEndpointMs: null,
      utterances: 0,
    }
    this.lastFinalText = ''
    this.utteranceSeq = 0
    this._vadBuffer = []
    this._inSpeech = false
    this._speechSamples = [] // 16кГц Int16 текущей фразы
    this._silenceMsAccum = 0
    this._speechMsTotal = 0
    this._lastEmit = 0
    // РЕЖИМ РАЦИИ (push-to-talk): пока удерживается кнопка, VAD ОБХОДИТСЯ —
    // всё аудио считаем речью. УРОК: «STT работает через раз» — короткие фразы
    // не успевали раскачать VAD (~0.3-0.4 с) до отпускания кнопки, flush
    // находил _inSpeech=false и молча выбрасывал фразу.
    this._captureMode = false
  }

  get sttDir() {
    return path.join(this.modelsDir, 'stt', 't-one-russian')
  }

  get vadDir() {
    return path.join(this.modelsDir, 'vad', 'silero-vad')
  }

  isReady() {
    return this.state === 'ready'
  }

  /** Установлены ли файлы моделей (без загрузки) */
  static modelsPresent(modelsDir) {
    const stt = path.join(modelsDir || path.join(__dirname, '..', 'models'), 'stt', 't-one-russian', 'model.onnx')
    const vad = path.join(modelsDir || path.join(__dirname, '..', 'models'), 'vad', 'silero-vad', 'silero_vad.onnx')
    return fs.existsSync(stt) && fs.existsSync(vad)
  }

  /**
   * Загрузка моделей (один раз на процесс). Не бросает — переходит в failed,
   * детерминированный голос остаётся рабочим (§0, §129).
   */
  async initialize() {
    if (this.state === 'ready' || this.state === 'loading') return this.state
    this.state = 'loading'
    const t0 = Date.now()
    try {
      // ПРЕД-ПОЛЁТНАЯ проверка целостности (урок 0xC0000409, GitHub issue #2): битый
      // ONNX в sherpa-onnx → необработанное C++ исключение → мгновенная смерть процесса.
      // Проверяем чистым Node ДО любого нативного вызова.
      const integ = checkModelIntegrity(this.modelsDir, 't-one-russian')
      if (!integ.ok) {
        throw new Error(`Файлы модели T-One повреждены (${integ.problems[0]}) — удалите и скачайте заново в Настройках → AI`)
      }
      const vadInteg = checkVadIntegrity(this.modelsDir)
      if (!vadInteg.ok) {
        throw new Error(`Silero VAD повреждён/не установлен (${vadInteg.problems[0]}) — скачайте его в Настройках → AI`)
      }
      const sherpa = lazySherpa()
      if (!sherpa) throw new Error('Пакет sherpa-onnx-node не установлен (нативный рантайм отсутствует)')
      if (!STTService.modelsPresent(this.modelsDir)) throw new Error('Модели STT/VAD не установлены — запустите AI Setup')

      const profile = PROFILES[this.profileKey]

      // --- Silero VAD (16 кГц) — ПЛОСКАЯ конфигурация (проверено на sherpa-onnx 1.13.8) ---
      const vad = new sherpa.Vad({
        sileroVad: { model: path.join(this.vadDir, 'silero_vad.onnx'), version: 4 },
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
      this._vad = vad

      // --- T-One Streaming CTC (8 кГц) ---
      const recognizer = new sherpa.OnlineRecognizer({
        featConfig: { sampleRate: SAMPLE_RATE_STT, featureDim: 80 },
        modelConfig: {
          toneCtc: { model: path.join(this.sttDir, 'model.onnx') }, // ключ T-One в sherpa-onnx 1.13+ (проверено нативно)
          tokens: path.join(this.sttDir, 'tokens.txt'),
          numThreads: profile.numThreads,
          provider: 'cpu',
          debug: 0,
        },
        decodingMethod: 'greedy_search',
        endpointConfig: {
          rule1: 2.0, // тишина до первой речи (сек) — технический фон
          rule2: profile.minSilence + 0.15, // тишина после речи — быстрый endpoint (§16)
          rule3: 8.0, // предельная длина фразы — команды короткие (§17)
        },
        enableEndpoint: true,
      })
      this._recognizer = recognizer

      // --- warm-up (§7, §48): прогон короткого шума через модель ---
      const tWarm0 = Date.now()
      try {
        const warm = recognizer.createStream()
        const silence = new Float32Array(SAMPLE_RATE_STT) // 1с тишины
        warm.acceptWaveform({ sampleRate: SAMPLE_RATE_STT, samples: silence })
        while (recognizer.isReady(warm)) recognizer.decode(warm)
        recognizer.reset(warm)
      } catch (e) {
        // warm-up не обязателен к успеху
      }
      this.metrics.modelLoadMs = tWarm0 - t0 - this.metrics.warmupMs // восстановим ниже
      this.metrics.modelLoadMs = Date.now() - t0
      this.metrics.warmupMs = Date.now() - tWarm0
      this.state = 'ready'
      this.emit('status', { state: this.state, modelLoadMs: this.metrics.modelLoadMs, warmupMs: this.metrics.warmupMs })
      return this.state
    } catch (e) {
      this.state = 'failed'
      this.error = e.message
      this.emit('status', { state: this.state, error: this.error })
      return this.state
    }
  }

  /**
   * Подать аудио (Int16Array 16 кГц mono; окно произвольной длины, кратно 512).
   * Silero VAD имеет задержку срабатывания ~0.3–0.4 с (внутренний буфер контекста),
   * поэтому используется кольцевой буфер ~1.2 с: при старте речи в распознаватель
   * сначала уходит ПРЕДЫСТОРИЯ (тишина+начало фразы), затем живой поток.
   * События: 'partial' { utteranceId, text, ms }, 'final' { utteranceId, text, ms } (§14: final один раз).
   */
  feed(int16Samples) {
    if (!this.isReady()) return
    const win = 512 // 32 мс @16кГц — окно Silero VAD
    const RING_WINDOWS = 38 // ~1.2 с предыстории до флага VAD
    let offset = 0
    while (offset + win <= int16Samples.length) {
      const chunk = int16Samples.subarray(offset, offset + win)
      offset += win

      const f32 = new Float32Array(win)
      for (let i = 0; i < win; i++) f32[i] = chunk[i] / 32768
      try {
        this._vad.acceptWaveform(f32)
      } catch {
        return // сбой VAD не роняет процесс
      }

      const isSpeech =
        this._captureMode || (this._vad.isDetected() && Date.now() > (this._cooldownUntil || 0))
      if (isSpeech) {
        if (!this._inSpeech) {
          // старт фразы: отдаём распознавателю предысторию из кольца (§10–§11)
          this._inSpeech = true
          this._utteranceStart = Date.now()
          this._sttStream = this._recognizer.createStream()
          this._emittedFinalForUtterance = false
          this._tailWindows = 0
          const ring = this._ring || []
          for (const rc of ring) this._feedStt(rc)
          this._ring = []
        }
        this._tailWindows = 0
        this._feedStt(chunk)
      } else if (this._inSpeech) {
        // хвост тишины после речи: собираем немного и завершаем фразу (§16 — быстро)
        this._feedStt(chunk)
        this._tailWindows += 1
        const tailMs = this._tailWindows * (win / SAMPLE_RATE_VAD) * 1000
        if (tailMs >= 200 && !this._captureMode) {
          this._finishUtterance('endpoint')
        }
      } else {
        // тишина до фразы: копим кольцо предыстории
        if (!this._ring) this._ring = []
        this._ring.push(Int16Array.from(chunk))
        if (this._ring.length > RING_WINDOWS) this._ring.shift()
      }

      // частичный результат — не чаще, чем раз в 120 мс (§11)
      if (this._inSpeech && this._sttStream && Date.now() - this._lastEmit > 120) {
        while (this._recognizer.isReady(this._sttStream)) this._recognizer.decode(this._sttStream)
        const text = this._readPartial()
        if (text) {
          this._lastEmit = Date.now()
          const ms = Date.now() - this._utteranceStart
          this.metrics.lastPartialMs = ms
          this.emit('partial', { utteranceId: this.utteranceSeq + 1, text, ms })
        }
      }
    }
  }

  /** 16 кГц → 8 кГц (усреднение пар) + стриминговое декодирование */
  _feedStt(chunk16k) {
    if (!this._sttStream) return
    const n = Math.floor(chunk16k.length / 2)
    if (n === 0) return
    const down8k = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      down8k[i] = ((chunk16k[2 * i] + chunk16k[2 * i + 1]) / 2) / 32768
    }
    try {
      this._sttStream.acceptWaveform({ sampleRate: SAMPLE_RATE_STT, samples: down8k })
      while (this._recognizer.isReady(this._sttStream)) this._recognizer.decode(this._sttStream)
    } catch {
      /* сбой декодирования не роняет сервис */
    }
  }

  _readPartial() {
    try {
      const r = this._recognizer.getResult(this._sttStream)
      return r && r.text ? String(r.text).trim() : ''
    } catch {
      return ''
    }
  }

  /** Завершить текущую фразу (endpoint/max-duration/внешняя команда) */
  _finishUtterance(reason) {
    if (!this._inSpeech) return
    if (!this._emittedFinalForUtterance) {
      let text = this._readPartial()
      try {
        // финал: завершаем поток и забираем итог
        this._recognizer.inputFinished(this._sttStream)
        while (this._recognizer.isReady(this._sttStream)) this._recognizer.decode(this._sttStream)
        text = this._readPartial() || text
      } catch { /* используем последний partial */ }
      this.utteranceSeq += 1
      this.metrics.utterances += 1
      this.metrics.lastFinalMs = Date.now() - this._utteranceStart
      this.lastFinalText = text || this.lastFinalText
      // дедупликация (§14): final один раз на utteranceId
      this._emittedFinalForUtterance = true
      this.emit('final', {
        utteranceId: this.utteranceSeq,
        text: text || '',
        reason,
        ms: this.metrics.lastFinalMs,
      })
    }
    this._inSpeech = false
    this._silenceMsAccum = 0
    this._tailWindows = 0
    // кулдаун после финала: VAD может мигнуть на реверб-хвосте —
    // не начинаем новую фразу и чистим кольцо предыстории (§14)
    this._cooldownUntil = Date.now() + 250
    this._ring = []
    try { if (this._sttStream) this._recognizer.reset(this._sttStream) } catch { /* ок */ }
    this._sttStream = null
  }

  /**
   * Режим рации: пока on — весь аудио-поток считается речью (VAD обходится),
   * фраза завершается только по flush() (отпускание кнопки). Делает PTT
   * детерминированным: что сказал в микрофон при удержании — то и распознаётся.
   */
  setCaptureMode(on) {
    const next = !!on
    if (next === this._captureMode) return
    this._captureMode = next
    if (next && this.isReady() && !this._inSpeech) {
      // фраза начинается немедленно: предыстория из кольца + живой поток
      this._inSpeech = true
      this._utteranceStart = Date.now()
      this._sttStream = this._recognizer.createStream()
      this._emittedFinalForUtterance = false
      this._tailWindows = 0
      const ring = this._ring || []
      for (const rc of ring) this._feedStt(rc)
      this._ring = []
    }
    if (!next && this._inSpeech) {
      // кнопка отпущена — завершаем тем, что успели захватить
      this._finishUtterance('flush')
    }
  }

  /** Ручное завершение фразы (push-to-talk отпустили) */
  flush() {
    this._finishUtterance('flush')
  }

  /** Полный сброс состояния фразы без финала */
  resetUtterance() {
    this._inSpeech = false
    this._tailWindows = 0
    this._silenceMsAccum = 0
    try { if (this._sttStream) this._recognizer.reset(this._sttStream) } catch { /* ок */ }
    this._sttStream = null
  }

  /** Прямое декодирование файла/буфера (selftest; НЕ путь приложения — §6 запрещает batch в живом пайплайне) */
  decodeFileForTest(wavPath) {
    if (!this.isReady()) throw new Error('STT не инициализирован')
    const { samples, sampleRate } = readWavAsFloat32(wavPath)
    // ресемпл в 8кГц при необходимости
    let s8k = samples
    if (sampleRate === 16000) {
      const n = Math.floor(samples.length / 2)
      s8k = new Float32Array(n)
      for (let i = 0; i < n; i++) s8k[i] = (samples[2 * i] + samples[2 * i + 1]) / 2
    } else if (sampleRate !== 8000) {
      throw new Error(`Неподдерживаемая частота в selftest: ${sampleRate}`)
    }
    const stream = this._recognizer.createStream()
    const t0 = Date.now()
    // прогон через VAD-стиль: окнами по 512 (16кГц-эквивалент = 256 сэмплов 8кГц)
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE_STT, samples: s8k })
    stream.inputFinished()
    while (this._recognizer.isReady(stream)) this._recognizer.decode(stream)
    const r = this._recognizer.getResult(stream)
    return { text: r && r.text ? r.text.trim() : '', ms: Date.now() - t0 }
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

// --- WAV (selftest) -------------------------------------------------------------

function readWavAsFloat32(file) {
  const buf = fs.readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Не WAV файл')
  let pos = 12
  let sampleRate = 16000
  let bits = 16
  let channels = 1
  let data = null
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(pos + 10)
      sampleRate = buf.readUInt32LE(pos + 12)
      bits = buf.readUInt16LE(pos + 22)
    } else if (id === 'data') {
      data = buf.subarray(pos + 8, pos + 8 + size)
    }
    pos += 8 + size + (size % 2)
  }
  if (!data) throw new Error('Нет data-чанка')
  let samples
  if (bits === 16) {
    const n = Math.floor(data.length / 2)
    samples = new Float32Array(n)
    for (let i = 0; i < n; i++) samples[i] = data.readInt16LE(i * 2) / 32768
  } else if (bits === 32 && data.length / 4 > 0) {
    const n = Math.floor(data.length / 4)
    samples = new Float32Array(n)
    for (let i = 0; i < n; i++) samples[i] = data.readFloatLE(i * 4)
  } else {
    throw new Error(`Формат WAV не поддержан в selftest: ${bits} бит`)
  }
  if (channels > 1) {
    const mono = new Float32Array(Math.floor(samples.length / channels))
    for (let i = 0; i < mono.length; i++) {
      let acc = 0
      for (let c = 0; c < channels; c++) acc += samples[i * channels + c]
      mono[i] = acc / channels
    }
    samples = mono
  }
  return { samples, sampleRate }
}

function writeWavFromFloat32(file, samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    data.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  fs.writeFileSync(file, Buffer.concat([header, data]))
}

module.exports = { STTService, PROFILES, SAMPLE_RATE_STT, SAMPLE_RATE_VAD, readWavAsFloat32, writeWavFromFloat32 }
