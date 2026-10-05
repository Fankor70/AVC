/**
 * TTSService — локальный русский синтез речи (спецификация §22–§29).
 *
 * Рантайм: sherpa-onnx OfflineTts (тот же нативный слой, что и STT — одна зависимость).
 * Голоса: официальные русские VITS-модели k2-fsa (irina/ruslan/dmitri).
 *   Честная заметка: Silero v5_5_ru.pt — PyTorch-модель, в Node/Electron без Python/libtorch
 *   неисполнима (спецификация запрещает Python/ручные установки §112). См. models-manifest.json.
 *
 * Требования:
 *   §23  короткие ответы — приложение генерирует фразы-шаблоны, TTS их озвучивает;
 *   §24  TTSCache: hash(normalizedText + voice + speed + sampleRate) → WAV-файл на диске;
 *   §25  prewarm при старте: синтез короткой фразы до первой команды;
 *   §26  cancelCurrentSpeech(): отмена воспроизведения (вызывается при новой речи пользователя);
 *   §27  ducking — делает рендерер (player volume), сервис отдаёт WAV/эвенты.
 *
 * Модуль НЕ зависит от electron — автономно тестируется на Node ≥18.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const { writeWavFromFloat32 } = require('./stt-service.cjs')

function lazySherpa() {
  try {
    // eslint-disable-next-line global-require
    return require('sherpa-onnx-node')
  } catch {
    return null
  }
}

class TTSService extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.modelsDir = opts.modelsDir || path.join(__dirname, '..', 'models')
    this.voiceId = opts.voiceId || 'irina'
    this.speed = opts.speed || 1.0
    this.cacheDir = opts.cacheDir || path.join(this.modelsDir, 'tts-cache')
    this.state = 'uninitialized'
    this.error = null
    this.metrics = { modelLoadMs: null, warmupMs: null, lastFirstAudioMs: null, lastSynthMs: null, synthCount: 0, cacheHits: 0 }
    this._speaking = false
    this._cancelled = false
  }

  get voiceDir() {
    return path.join(this.modelsDir, 'tts', this.voiceId)
  }

  isReady() {
    return this.state === 'ready'
  }

  static modelPresent(modelsDir, voiceId = 'irina') {
    const dir = path.join(modelsDir || path.join(__dirname, '..', 'models'), 'tts', voiceId)
    try {
      return fs.existsSync(path.join(dir, `${TTSService.onnxName(voiceId)}.onnx`)) && fs.existsSync(path.join(dir, 'tokens.txt'))
    } catch {
      return false
    }
  }

  static onnxName(voiceId) {
    return `ru_RU-${voiceId}-medium`
  }

  async initialize() {
    if (this.state === 'ready' || this.state === 'loading') return this.state
    this.state = 'loading'
    const t0 = Date.now()
    try {
      const sherpa = lazySherpa()
      if (!sherpa) throw new Error('Пакет sherpa-onnx-node не установлен')
      if (!TTSService.modelPresent(this.modelsDir, this.voiceId)) throw new Error(`Модель TTS «${this.voiceId}» не установлена — запустите AI Setup`)
      const onnx = path.join(this.voiceDir, `${TTSService.onnxName(this.voiceId)}.onnx`)
      const dataDir = path.join(this.voiceDir, 'espeak-ng-data')

      this._tts = new sherpa.OfflineTts({
        model: {
          vits: {
            model: onnx,
            tokens: path.join(this.voiceDir, 'tokens.txt'),
            dataDir: fs.existsSync(dataDir) ? dataDir : '',
          },
          numThreads: 1,
          debug: 0,
          provider: 'cpu',
        },
        maxNumSentences: 1,
      })
      this.metrics.modelLoadMs = Date.now() - t0
      fs.mkdirSync(this.cacheDir, { recursive: true })

      // warm-up (§25): короткая фраза до первой команды
      const tWarm = Date.now()
      await this.synthesize('Готова.', { noCache: true })
      this.metrics.warmupMs = Date.now() - tWarm

      this.state = 'ready'
      this.emit('status', { state: this.state, voice: this.voiceId, modelLoadMs: this.metrics.modelLoadMs, warmupMs: this.metrics.warmupMs })
      return this.state
    } catch (e) {
      this.state = 'failed'
      this.error = e.message
      this.emit('status', { state: this.state, error: this.error })
      return this.state
    }
  }

  cachePath(text, { voice = this.voiceId, speed = this.speed, sampleRate = 0 } = {}) {
    const hash = crypto.createHash('sha1').update(`${String(text).trim().toLowerCase()}|${voice}|${speed}|${sampleRate}`).digest('hex')
    return path.join(this.cacheDir, `${voice}-${hash}.wav`)
  }

  /**
   * Синтез фразы → WAV-файл (или кэш). Возвращает { file, cached, ms, sampleRate }.
   * Текст приходит ИЗ ШАБЛОНОВ приложения (§88) — LLM произвольные тексты не генерирует.
   */
  async synthesize(text, opts = {}) {
    if (!this._tts) throw new Error(this.error || 'TTS не инициализирован')
    const clean = String(text || '').trim().slice(0, 220)
    if (!clean) throw new Error('Пустой текст для синтеза')

    const cacheFile = this.cachePath(clean, { speed: opts.speed || this.speed })
    if (!opts.noCache && fs.existsSync(cacheFile)) {
      this.metrics.cacheHits += 1
      return { file: cacheFile, cached: true, ms: 0, sampleRate: this._sampleRate || 0 }
    }

    const t0 = Date.now()
    const audio = this._tts.generate({ text: clean, sid: 0, speed: opts.speed || this.speed })
    const ms = Date.now() - t0
    this.metrics.lastSynthMs = ms
    this.metrics.synthCount += 1
    if (!audio || !audio.samples || !audio.samples.length) throw new Error('Синтез вернул пустой звук')
    this._sampleRate = audio.sampleRate
    // атомарная запись в кэш
    const tmp = `${cacheFile}.tmp.wav`
    writeWavFromFloat32(tmp, audio.samples, audio.sampleRate)
    fs.renameSync(tmp, cacheFile)
    return { file: cacheFile, cached: false, ms, sampleRate: audio.sampleRate, samples: opts.returnSamples ? audio.samples : undefined }
  }

  /**
   * Проговорить фразу: синтез (или кэш) + воспроизведение через Electron (audio в рендерере).
   * Здесь — только подготовка: сервисы main-процесса не имеют аудиоустройства.
   * Событие 'speak-file' { file, text } уходит рендереру; отмена — cancelCurrentSpeech() (§26).
   */
  async speak(text, opts = {}) {
    const res = await this.synthesize(text, opts)
    this._speaking = true
    this._cancelled = false
    const t0 = Date.now()
    this.metrics.lastFirstAudioMs = res.cached ? 0 : res.ms
    this.emit('speak-file', { file: res.file, text, cached: res.cached, ms: res.ms })
    // воспроизведение выполняет рендерер; длительность оценочно: duration = samples/sampleRate
    let durMs = 800
    try {
      const stat = fs.statSync(res.file)
      durMs = Math.max(500, ((stat.size - 44) / 2 / (res.sampleRate || 24000)) * 1000)
    } catch { /* оценка не критична */ }
    this._speakingUntil = Date.now() + durMs
    return { ...res, durationMs: durMs, speakStartMs: Date.now() - t0 }
  }

  isSpeaking() {
    return this._speaking && Date.now() < (this._speakingUntil || 0)
  }

  /** §26: немедленная отмена текущей речи (новая команда пользователя важнее) */
  cancelCurrentSpeech() {
    this._cancelled = true
    this._speaking = false
    this._speakingUntil = 0
    this.emit('cancel-speech')
  }

  setVoice(voiceId) {
    if (voiceId === this.voiceId) return
    this.voiceId = voiceId
    if (this.state === 'ready') {
      this.state = 'uninitialized'
      this._tts = null
    }
  }

  getMetrics() {
    return { ...this.metrics, state: this.state, voice: this.voiceId, error: this.error }
  }

  shutdown() {
    try {
      this._tts = null
      this.state = 'uninitialized'
    } catch { /* ок */ }
  }
}

module.exports = { TTSService }
