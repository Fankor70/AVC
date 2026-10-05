# AI_ARCHITECTURE — архитектура локального AI-слоя AVC-Anime

Дата: 2026-10-03 · Статус: РЕАЛИЗОВАНО и ПРОВЕРЕНО (см. AI_TEST_REPORT.md)

## Принцип

Существующее приложение (детерминированный голосовой слой) не переписано — AI добавлен
как МОДУЛЬНОЕ расширение (спецификация §0). При отсутствии моделей/пакетов/интернета
приложение полностью работоспособно (§129).

## Схема

```
Рендерер (Next.js UI)
  use-voice.ts
    ├── движок 'browser'  — Web Speech API (как раньше)
    ├── движок 'server'   — MediaRecorder → /api/voice/asr (как раньше)
    └── движок 'local'    — НОВОЕ: getUserMedia → AudioContext(16 кГц) →
                            ScriptProcessor → Int16Array → IPC feedAudio
                            ↑ события: stt-partial / stt-final
  parser.ts (детерминированный парсер) — ЕДИНЫЙ путь разбора, не продублирован
  executor.ts — ЕДИНЫЙ путь исполнения (executeText / executeEarlyCommand)
      ↑ LLM fallback: сначала ЛОКАЛЬНЫЙ роутер (IPC llm-route), затем облачный
        /api/voice/interpret (веб-режим)

Electron main
  main.cjs — тонкий мост: IPC ⇔ AI-воркер (child_process.fork)
  preload.cjs — window.avcElectron.ai (только не-секретные данные)

AI-воркер (ЧИСТЫЙ Node, изолированный процесс — §130)
  ai/ai-worker.cjs — протокол {id,type,args} → {id,ok,result}; события наружу
  ai/voice-pipeline.cjs — оркестратор: EarlyCommandDetector + сервисы
  ai/stt-service.cjs  — Silero VAD (16 кГц) + T-One Streaming CTC (8 кГц, sherpa-onnx)
  ai/llm-service.cjs  — Qwen3-0.6B Q4_K_M (llama.cpp через node-llama-cpp, GBNF-грамматика)
  ai/tts-service.cjs  — VITS ru (sherpa-onnx OfflineTts) + дисковый кэш (§24)
  ai/model-manager.cjs — загрузка/SHA-256/атомарная установка/resume (§50–§60)
```

## Ключевое инженерное решение: отдельный Node-процесс

Electron запрещает N-API external arraybuffers В ЛЮБЫХ своих процессах
(main / renderer / utilityProcess / run-as-node) — проверено экспериментально:
`sherpa-onnx` TTS возвращает Float32Array именно через external buffer и падает с
«External buffers are not allowed». Поэтому:

- AI-воркер работает на чистом Node: в packaged-сборке — бандленный
  `resources/runtime-node/node.exe` (кладёт CI, §112 соблюдено — пользователю
  ставить ничего не нужно), в dev — системный node из PATH;
- изоляция сохраняется (§130): падение нативного кода не роняет приложение;
- транспорт: child_process.fork с serialization:'advanced' (Int16Array аудио
  доезжает структурной копией).

## Поток команды (полный пайплайн §4)

```
микрофон → 16 кГц Int16 → [IPC] → Silero VAD → кольцевой буфер 1.2 с предыстории
  → T-One стриминговое декодирование → partial-события
      → EarlyCommandDetector (§12: только безопасное, §13: опасное никогда)
          → renderer executeEarlyCommand → executeCommand (единый исполнитель)
  → endpoint (хвост тишины 250 мс / flush push-to-talk)
      → final-событие (§14: ровно один на utteranceId)
          → renderer parser.ts → executor
              → (не распознано) → локальный LLM-роутер (GBNF JSON) → executor
  → ответ приложения → локальный TTS (кэш) → Audio(dataUrl) → ducking (§27)
```

## Таймауты и отмена (§46–§47)

- LLM: профильные таймауты 5/8/12 с; отмена через AbortController при новой команде.
- STT: maxSpeechDuration VAD 15 с + кап maxUtteranceMs рендерера.
- Запросы к воркеру: таймаут на мосту main (по умолчанию 300 с; install 1 ч).

## Безопасность

- Пароли/cookie через AI-мост не проходят — только статусы/команды/WAV (§15).
- LLM не имеет ID/URL/сети: грамматика запрещает произвольные поля (§37);
  исполнение — только через реестр интентов → executor (§40–§41).
