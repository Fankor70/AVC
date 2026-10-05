/**
 * LLMService — локальный семантический роутер команд на Qwen3-0.6B (GGUF) + llama.cpp
 * (спецификация §28–§47, §82–§86).
 *
 * ПРИНЦИПЫ:
 *  - LLM — НЕ чат-бот (§29): только извлечение intent/entities → строгий JSON по грамматике (§38–§39);
 *  - нормальные команды ДОЛЖНЫ обходить LLM (§30) — роутер вызывает сервис только для неоднозначных;
 *  - контекст минимальный (§32, §85), промпт короткий (§82), выход ограничен (§83);
 *  - таймаут (§46) и отмена при новой команде (§47) обязательны;
 *  - модель загружается один раз, warm-up при старте (§48);
 *  - никакой выдуманной информации: ID/URL/счётчики LLM не назначает (§37) — только query/номера.
 *
 * Контракт ответа ИДЕНТИЧЕН /api/voice/interpret (единая точка выполнения §41):
 *   { commands: [{ type, params, confidence }], needsClarification, clarifyQuestion }
 * где type — значения из VoiceCommandType рендерера.
 *
 * Модуль НЕ зависит от electron — автономно тестируется на Node ≥18.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { EventEmitter } = require('events')

const PROFILE_DEFAULTS = {
  max_responsiveness: { timeoutMs: 5000, maxTokens: 96, temperature: 0.1, contextSize: 2048 },
  balanced: { timeoutMs: 8000, maxTokens: 128, temperature: 0.15, contextSize: 3072 },
  quality: { timeoutMs: 12000, maxTokens: 192, temperature: 0.2, contextSize: 4096 },
}

/** Реестр допустимых intents (§40): ТОЛЬКО те, что реально есть в приложении (VoiceCommandType) */
const ALLOWED_COMMAND_TYPES = [
  'OpenHome', 'OpenCatalog', 'OpenTop100', 'OpenOngoing', 'OpenAnnouncements', 'OpenSchedule', 'OpenRandom',
  'SearchAnime', 'OpenAnime', 'SelectEpisode', 'NextEpisode', 'PreviousEpisode',
  'Play', 'Pause', 'TogglePlayPause', 'SeekForward', 'SeekBackward',
  'VolumeUp', 'VolumeDown', 'SetVolume', 'Fullscreen', 'ExitFullscreen', 'ToggleFullscreen',
  'Mute', 'Unmute',
  'OpenNewTab', 'CloseTab', 'NextTab', 'PreviousTab', 'SelectTab', 'Reload', 'Back', 'Forward',
  'ScrollUp', 'ScrollDown', 'SelectVoice', 'ShowEpisodes', 'ShowHelp', 'SelectOption',
  'SetWatchStatus', 'ToggleFavorite', 'RateAnime', 'RemoveRating',
  'ContinueWatching', 'WhatAmIWatching', 'ShowLibrary', 'OpenProfile', 'CheckAccount', 'AccountLogout',
  'Unknown',
]

/**
 * GBNF-грамматика ответа (§38–§39): LlamaJsonSchemaGrammar в node-llama-cpp 3.22.1
 * сломан на вложенных схемах ($ref-конвертер), поэтому грамматика задана явно.
 * Это СТРОЖЕ, чем JSON Schema: LLM физически не может выдумать поля вне списка (§37).
 */
const GBNF_COMMAND = String.raw`root ::= "{" ws "\"commands\": " ws cmd-list ws ", \"needsClarification\": " ws boolean ws (", \"clarifyQuestion\": " ws string)? ws "}"
cmd-list ::= "[" ws (cmd (", " ws cmd)*)? ws "]"
cmd ::= "{" ws "\"type\": \"" ctype "\"" ws ", \"params\": " params ws (", \"confidence\": " ws number ws)? ws "}"
ctype ::=`

const GBNF_PARAMS = String.raw`params ::= "{" ws (param (", " ws param)*)? ws "}"
param ::= p-string | p-number | p-boolean
p-string ::= "\"query\": " ws string | "\"dub\": " ws string | "\"target\": " ws string | "\"alias\": " ws string | "\"status\": " ws status
p-number ::= "\"episode\": " ws number | "\"seconds\": " ws number | "\"volume\": " ws number | "\"index\": " ws number | "\"rating\": " ws number
p-boolean ::= "\"open\": " ws boolean | "\"favorite\": " ws boolean
status ::= "\"watching\"" | "\"planned\"" | "\"completed\"" | "\"dropped\"" | "\"on_hold\""
number ::= [0-9] [0-9]*
boolean ::= "true" | "false"
string ::= "\"" (string-char)* "\""
string-char ::= [^"\\\x7F\x00-\x1F] | "\\" ["\\bfnrt]
ws ::= [ \t\n]*`

function buildGrammarSource() {
  return GBNF_COMMAND + ' "' + ALLOWED_COMMAND_TYPES.join('" | "') + '"\n' + GBNF_PARAMS
}

const SYSTEM_PROMPT = [
  'Ты локальный маршрутизатор голосовых команд AVC-Anime (управление аниме-сайтом YummyAnime).',
  'Понимай русскую разговорную речь с учётом переданного контекста.',
  'Верни только JSON по схеме: {"commands":[{"type":"...","params":{...},"confidence":0..1}],"needsClarification":bool,"clarifyQuestion":"..."}',
  'Не объясняй. Не придумывай ID и URL. Не выполняй действия.',
  'Используй ТОЛЬКО разрешённые type. Если данных недостаточно — needsClarification=true и короткий вопрос.',
  'Правила:',
  '- «пауза/стоп/поставь на паузу» → Pause (это ПРО ПЛЕЕР, не про список!). «продолжи/воспроизведи» → Play',
  '- «найди/поищи X» → SearchAnime {query:X}',
  '- «открой X» (X — название тайтла) → SearchAnime {query:X, open:true}',
  '- «включи N-ю серию/давай N-ю» → SelectEpisode {episode:N} (число из порядкового: шестую=6)',
  '- «то, на чём я остановился» → ContinueWatching {}',
  '- «добавь в смотрю» → SetWatchStatus {status:"watching"}; «в планы» → {"planned"}; «просмотрено» → {"completed"}; «брошено/забросил» → {"dropped"}; «отложено» → {"on_hold"}',
  '- «оцени на N» → RateAnime {rating:N}; «убери оценку» → RemoveRating {}',
  '- «добавь в избранное/любимые» → ToggleFavorite {favorite:true}; убрать → {favorite:false}',
  '- местоимения «это/он/его» → цель из контекста (animeTitle/animeSlug)',
  '- «громче/тише» → VolumeUp/VolumeDown; «вперед/назад N секунд» → SeekForward/SeekBackward {seconds:N}',
  '- «библиотека» → ShowLibrary; «что я смотрю» → WhatAmIWatching; «профиль» → OpenProfile',
  '- если понять нельзя → [{"type":"Unknown","params":{}}]',
  'Примеры:',
  '«вруби шестую» → {"commands":[{"type":"SelectEpisode","params":{"episode":6},"confidence":0.9}],"needsClarification":false}',
  '«пауза» → {"commands":[{"type":"Pause","params":{},"confidence":0.95}],"needsClarification":false}',
  '«поставь на паузу» → {"commands":[{"type":"Pause","params":{},"confidence":0.9}],"needsClarification":false}',
  '«добавь это в планы» (контекст animeSlug) → {"commands":[{"type":"SetWatchStatus","params":{"status":"planned"},"confidence":0.9}],"needsClarification":false}',
  '«оцени на восемь» → {"commands":[{"type":"RateAnime","params":{"rating":8},"confidence":0.9}],"needsClarification":false}',
  '«включи то, на чём остановился» → {"commands":[{"type":"ContinueWatching","params":{},"confidence":0.85}],"needsClarification":false}',
  '«зелёный фиолетовый» → {"commands":[{"type":"Unknown","params":{},"confidence":0.1}],"needsClarification":false}',
].join('\n')

async function lazyNodeLlamaCpp() {
  try {
    // node-llama-cpp v3 — ESM-only: динамический import() работает и из CJS (и в Electron main)
    return await import('node-llama-cpp')
  } catch {
    return null
  }
}

class LLMService extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.modelsDir = opts.modelsDir || path.join(__dirname, '..', 'models')
    this.profile = PROFILE_DEFAULTS[opts.profile] ? opts.profile : 'max_responsiveness'
    this.state = 'uninitialized'
    this.error = null
    this.metrics = { modelLoadMs: null, warmupMs: null, lastRouteMs: null, routes: 0, tokenSpeedTps: null, promptTokens: null, outputTokens: null }
    this._inFlight = null // { controller } текущей генерации (§47)
  }

  get modelPath() {
    const dir = path.join(this.modelsDir, 'llm', 'qwen3-0.6b')
    try {
      const ggufs = fs.readdirSync(dir).filter((f) => f.endsWith('.gguf'))
      return ggufs.length ? path.join(dir, ggufs[0]) : null
    } catch {
      return null
    }
  }

  isReady() {
    return this.state === 'ready'
  }

  static modelPresent(modelsDir) {
    const dir = path.join(modelsDir || path.join(__dirname, '..', 'models'), 'llm', 'qwen3-0.6b')
    try {
      return fs.readdirSync(dir).some((f) => f.endsWith('.gguf'))
    } catch {
      return false
    }
  }

  /** Загрузка модели (один раз) + warm-up. Ошибки не бросаем (§0/§129: без LLM всё работает). */
  async initialize() {
    if (this.state === 'ready' || this.state === 'loading') return this.state
    this.state = 'loading'
    const t0 = Date.now()
    try {
    const mod = await lazyNodeLlamaCpp()
      if (!mod) throw new Error('Пакет node-llama-cpp не установлен (нативный llama.cpp отсутствует)')
      const modelPath = this.modelPath
      if (!modelPath) throw new Error('GGUF-модель не установлена — запустите AI Setup')

      const llama = await mod.getLlama({ logger: () => {} })
      this._llama = llama
      this._model = await llama.loadModel({ modelPath, gpuLayers: 0 }) // CPU: мелкая модель быстрее без переноса на GPU (§20)
      const prof = PROFILE_DEFAULTS[this.profile]
      this._context = await this._model.createContext({
        contextSize: prof.contextSize,
        sequences: 1,
        threads: Math.max(1, Math.min(os.cpus().length, 4)),
      })
      this.metrics.modelLoadMs = Date.now() - t0

      // warm-up + постоянная сессия (§48): переиспользуем контекст (кэш системного промпта)
      const tWarm = Date.now()
      this._session = new mod.LlamaChatSession({ contextSequence: this._context.getSequence(), systemPrompt: SYSTEM_PROMPT })
      await this._session.prompt('Проверка связи. Верни JSON.', { maxTokens: 8, temperature: 0 })
      this.metrics.warmupMs = Date.now() - tWarm

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
   * Роутинг фразы → команды. Возвращает null при сбое/таймауте (§46 — fallback на детерминированный парсер).
   * opts.context — минимальный контекст (§32): { page, anime, season, episode, episodeCount, playing, quality, dubbing, lastWatchedEpisode, accountLoggedIn }
   * opts.signal — внешний AbortSignal (отмена роутером приложения).
   */
  async route(text, opts = {}) {
    if (!this.isReady()) return null
    const prof = PROFILE_DEFAULTS[this.profile]
    const mod = await lazyNodeLlamaCpp()
    if (!mod) return null

    // отмена предыдущей генерации (§47): новая команда приоритетнее
    if (this._inFlight) {
      try { this._inFlight.controller.abort() } catch { /* ок */ }
      this._inFlight = null
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || prof.timeoutMs)
    if (opts.signal) opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
    this._inFlight = { controller }

    const contextJson = opts.context ? JSON.stringify(opts.context) : '{}'
    // /no_think — мягкий переключатель Qwen3: без режима рассуждений (§84 — fastest mode)
    const userPrompt = `Контекст: ${contextJson}\nФраза: «${String(text).trim()}» /no_think`

    const t0 = Date.now()
    try {
      const grammar = await this._llama.createGrammar({ grammar: buildGrammarSource() })
      const raw = await this._session.prompt(userPrompt, {
        grammar,
        maxTokens: prof.maxTokens,
        temperature: prof.temperature,
        signal: controller.signal,
        stopOnAbortSignal: true,
      })
      // защита §39: невалидный JSON не должен дойти до действий; повтор после отмены — reset
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        try { this._session.taskDone() } catch { /* ок */ }
        throw new Error(`Невалидный JSON от LLM: ${String(raw).slice(0, 80)}`)
      }
      // защита §37/§39: params только строка/число/булево; type в реестре
      const commands = (Array.isArray(parsed.commands) ? parsed.commands : [])
        .filter((c) => c && ALLOWED_COMMAND_TYPES.includes(String(c.type)))
        .map((c) => ({
          type: String(c.type),
          params: sanitizeParams(c.params),
          confidence: Number.isFinite(Number(c.confidence)) ? Math.min(1, Math.max(0, Number(c.confidence))) : 0.6,
        }))
      this.metrics.routes += 1
      this.metrics.lastRouteMs = Date.now() - t0
      return {
        commands,
        needsClarification: !!parsed.needsClarification,
        clarifyQuestion: typeof parsed.clarifyQuestion === 'string' ? parsed.clarifyQuestion : '',
        source: 'local-llm',
        ms: this.metrics.lastRouteMs,
      }
    } catch (e) {
      // таймаут/отмена/невалидный JSON → null → детерминированный fallback (§46)
      this.metrics.lastRouteMs = Date.now() - t0
      this.emit('route-error', { error: e.message, ms: this.metrics.lastRouteMs })
      return null
    } finally {
      clearTimeout(timer)
      if (this._inFlight && this._inFlight.controller === controller) this._inFlight = null
    }
  }

  getMetrics() {
    return { ...this.metrics, state: this.state, profile: this.profile, error: this.error }
  }

  shutdown() {
    try {
      if (this._inFlight) this._inFlight.controller.abort()
      this._session && this._session.dispose && this._session.dispose()
      this._context && this._context.dispose && this._context.dispose()
      this._model && this._model.dispose && this._model.dispose()
      this.state = 'uninitialized'
    } catch { /* ок */ }
  }
}

function sanitizeParams(p) {
  const out = {}
  if (!p || typeof p !== 'object') return out
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else if (typeof v === 'string') out[k] = v
  }
  return out
}

module.exports = { LLMService, ALLOWED_COMMAND_TYPES, GBNF_COMMAND, GBNF_PARAMS, buildGrammarSource, SYSTEM_PROMPT, PROFILE_DEFAULTS }
