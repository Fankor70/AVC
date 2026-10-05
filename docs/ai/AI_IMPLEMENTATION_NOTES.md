# AI_IMPLEMENTATION_NOTES — STT / TTS / LLM / Model Manager / Voice Pipeline

Дата: 2026-10-03 · Компактная реализационная документация (детали в коде, все факты проверены)

## STT_IMPLEMENTATION

Файл: `electron-app/ai/stt-service.cjs`

- Модель: **T-One Russian Streaming CTC** (`sherpa-onnx-streaming-t-one-russian-2025-09-08`),
  8 кГц; в sherpa-onnx 1.13.8 конфиг-ключ — `modelConfig.toneCtc` (установлено
  экспериментально: `ctc`/`tOneCtc` не мапятся нативным биндингом).
- VAD: **Silero VAD v4**, 16 кГц; конфиг — ПЛОСКИЙ (`sileroVad` наверху, без
  featConfig/model-обёрток) + второй аргумент конструктора `bufferSizeInSeconds`.
- Поток: рендерер шлёт Int16Array 16 кГц окнами; сервис режет на окна 512 (32 мс).
- VAD-задержка ~0.35 с компенсируется **кольцевым буфером 1.2 с**: при старте речи в
  распознаватель сначала уходит предыстория (§10–§11 — первое слово не теряется).
- Endpointing (§16): хвост тишины 250 мс → final; профильные пороги VAD
  (max_responsiveness 0.35 с / balanced 0.55 / quality 0.8).
- Дедупликация (§14): final один раз на utteranceId; кулдаун 350 мс + очистка кольца
  (VAD мигает на реверб-хвосте).
- Прогрев (§7): 1 с тишины через модель при старте; модель живёт в процессе (§48).
- Отказоустойчивость: любые сбои VAD/декодера не роняют сервис (§0).

## TTS_IMPLEMENTATION

Файл: `electron-app/ai/tts-service.cjs`

- Рантайм: sherpa-onnx OfflineTts (VITS). Голоса: ru_RU-irina/ruslan/dmitri-medium
  (официальные k2-fsa, манифест с реальными SHA-256).
- Silero v5_5_ru.pt — PyTorch-модель: в Node/Electron неисполнима без Python/libtorch
  (§112 запрещает). Зафиксировано в манифесте честной пометкой.
- Кэш (§24): SHA1(text+voice+speed) → WAV в `models/tts-cache/`; попадание — 0 мс.
- Прогрев (§25): синтез «Готова.» при инициализации.
- Отмена (§26): cancelCurrentSpeech() — новая речь пользователя важнее.
- Рендерер получает WAV как data URL (файл:// из http-происхождения недоступен).
- Ducking (§27): выполняется рендерером через громкость плеера (план: player.tsx).

## LLM_IMPLEMENTATION

Файл: `electron-app/ai/llm-service.cjs`

- Модель: **Qwen3-0.6B Q4_K_M GGUF** через **node-llama-cpp v3** (нативный llama.cpp).
  Официальный репозиторий Qwen УДАЛИЛ Q4_K_M (остался Q8_0) — манифест использует
  поддерживаемый bartowski-зеркал (тот же base_model, Apache-2.0), причина зафиксирована.
- ESM-only пакет: динамический `import()` из CJS (работает в Electron main тоже).
- Режим: `/no_think` (мягкое отключение reasoning Qwen3, §84).
- Строгий JSON (§38–§39): явная **GBNF-грамматика** — `LlamaJsonSchemaGrammar` 3.22.1
  сломан на вложенных схемах; грамматика задаёт белый список интентов и полей params
  (§37: LLM физически не может выдумать поле/ID).
- Реестр интентов (§40): ровно те type, что есть в VoiceCommandType рендерера —
  единая точка исполнения (§41).
- Таймаут (§46): профильный 5/8/12 с → null → детерминированный fallback.
- Отмена (§47): AbortController; новая команда прерывает старую генерацию.
- Сессия: постоянная LlamaChatSession (системный промпт с few-shot кэшируется).
- Промпт (§82): правила русских команд + 7 few-shot примеров; контекст (§32, §85) —
  маленький JSON от рендерера (страница/аниме/серия/плеер/аккаунт).

## AI_MODEL_MANAGER

Файл: `electron-app/ai/model-manager.cjs`

- Жизненный цикл (§56): temp `.part` → (Range resume) → проверка размера → SHA-256 →
  атомарный rename → распаковка tar.bz2 (`--strip-components=1`) → проверка структуры →
  маркер `.avc-installed.json`.
- Ошибки (§58): типизированные DownloadError (HTTP_404/5xx, TLS, TIMEOUT, SIZE,
  CHECKSUM, DISK_FULL, ACCESS_DENIED, EXTRACT, NETWORK, ABORTED) — с человеческим
  текстом; никакого «Unknown error».
- Манифест: `ai/models-manifest.json` — URL/размеры/SHA-256/acceptRanges; SHA-256
  сняты с реальных загрузок инструментом `tools/ai-sha-update.cjs`.
- Восстановление (§128): recoverPending() находит .part — install() продолжит.

## VOICE_PIPELINE

Файл: `electron-app/ai/voice-pipeline.cjs` (+ `ai-worker.cjs`, мост в main.cjs/preload.cjs)

- EarlyCommandDetector (§12): только безопасные частичные фразы (пауза/дальше/громче…),
  частичные формы слов допускаются для безвредных команд; §13 — опасные намерения
  (удали/оценка/аккаунт…) никогда не исполняются рано.
- Дедуп (§14): main помечает utteranceId; рендерер дополнительно хранит
  executedEarly/executedFinal — двойного исполнения нет.
- Роутер (§30): детерминированный парсер → (не распознано) → локальный LLM →
  (не доступен) → облачный interpret → Unknown.
- Ответы (§88): только шаблоны приложения → TTS; LLM произвольные тексты не озвучивает.
- Метрики (§89, §97): модельLoad/warmup/partial/final/route/synth latency + utterances
  + cacheHits — отдаются в Настройки → AI.
