# STT-архитектура (локальное офлайн-распознавание русской речи)

Статус: реализовано (релиз 1.0.12+). Голос — главная функция приложения: аудио
не покидает машину, инференс идёт в отдельном процессе, сеть нужна только для
скачивания моделей по явному действию пользователя.

## Диаграмма

```
Рендерер (Next.js UI)                          Electron main (main.cjs)
┌────────────────────────────┐   IPC          ┌─────────────────────────────┐
│ use-voice.ts               │                │ preload.cjs (avcElectron.ai)│
│  getUserMedia 16 кГц mono  │  stt-feed      │ setupAiIpc():               │
│  ScriptProcessor 4096      │───────────────▶│  avc:ai:stt-feed / flush    │
│  AudioContext → Int16      │                │  avc:ai:status / catalog    │
│        │                   │  stt-partial   │  avc:ai:set-stt-model       │
│  use-voice подписки        │◀───────────────│  avc:ai:benchmark           │
│  (partial/final → парсер)  │                │  avc:ai:models:* (путь)     │
└────────────────────────────┘                └──────────────┬──────────────┘
                                                             │ fork (ЧИСТЫЙ Node)
                                                             ▼
                                             ┌───────────────────────────────┐
                                             │ ai-worker.cjs (process env    │
                                             │ AVC_MODELS_DIR / AVC_STT_MODEL│
                                             │                               │
                                             │ VoicePipeline (voice-pipeline)│
                                             │  ├ AIModelManager (модели)    │
                                             │  ├ EarlyCommandDetector (§12) │
                                             │  └ SttEngine (по выбору)      │
                                             │     ├ t-one-streaming         │
                                             │     │  (STTService: Online    │
                                             │     │   Recognizer 8 кГц +    │
                                             │     │   Silero VAD 16 кГц +   │
                                             │     │   кольцо предыстории)   │
                                             │     └ gigaam-offline          │
                                             │        (OfflineRecognizer     │
                                             │         16 кГц int8 + VAD,    │
                                             │         декод фразы целиком)  │
                                             └───────────────────────────────┘
```

## Hexagonal: интерфейсы и реестр (stt-engines.cjs)

Ядро (voice-pipeline) зависит только от интерфейса движка:

```
SttEngine {
  capabilities { streaming, hotwords, nbest, punctuation }
  initialize()            → 'ready' | 'failed'   // не бросает
  feed(int16Samples)      // 16 кГц mono; события 'partial' { utteranceId, text, ms }
  flush()                 // push-to-talk отпустили → final
  resetUtterance() ; isReady() ; getMetrics() ; shutdown()
  on('final')             // { utteranceId, text, reason, ms } — ровно один на фразу
}
SttEngineRegistry: ENGINES + createSttEngine({ modelId }) + engineForModel(modelId)
```

**Новый движок = один adapter в `stt-engines.cjs` + запись в каталоге моделей
(`models-manifest.json → models[]`). Код пайплайна/воркера не меняется.**

Движки:
| Движок | Модели (профиль) | Частота | Partial'ы | Когда использовать |
|---|---|---|---|---|
| `t-one-streaming` | `t-one-russian` (ru-fast) | 8 кГц | да (120 мс троттл) | слабые ПК, минимум задержки |
| `gigaam-offline` | `gigaam-v3-russian`, `gigaam-v2-russian` (ru-accurate) | 16 кГц | нет (декод после VAD) | точность, ПК с 6+ ГБ RAM |

**Модель по умолчанию (релиз 1.0.15): `gigaam-v3-russian`** — точное распознавание
названий/чисел («Наруто двадцать серия» вместо «уратуту нараратутто» на T-One
8 кГц). Если файлов модели по умолчанию нет, `resolveSttModelId()` честно
падает на установленную (T-One), а UI показывает, что запрошенная модель не
установлена. Явный выбор пользователя (кнопка «Сделать активной») сохраняется
в `models-dir.json` с флагом `sttModelChosen` и уважается всегда.

Задержка финала после конца речи (релиз 1.0.15): Silero `minSilenceDuration`
0.25 с (max_responsiveness) + хвост 200 мс в пайплайне + кулдаун 250 мс + чанки
микрофона 128 мс → финал ≈ 0.5 с после последнего звука.

## Каталог моделей (models-manifest.json, версия 4)

Модель = запись JSON (`models[]`): `id, name, profile, engine, lang, version,
dir, url, mirrors[], archive, expectedFiles[], sizeBytes, sha256, acceptRanges,
license, minRamBytes, recommendedFor`. **Добавить модель = добавить запись,
не трогая код** (если движок уже поддержан).

- `sha256: null` = контрольная сумма фиксируется при первой установке
  (записывается в маркер) и сверяется при последующих. Так честно для моделей,
  чей архив не скачан при сборке приложения.
- Лицензии указаны в манифесте и показываются в UI: T-One — MIT; GigaAM v2/v3 —
  MIT (salute-developers/GigaAM); sherpa-onnx — Apache-2.0.
- Перед сборкой CI гоняет `scripts/validate-ai-assets.mjs`: HEAD + докачка 1 МБ
  каждой модели/зеркала; FAIL требуемого ассета останавливает сборку.

## Менеджер моделей (model-manager.cjs)

- Хранилище: `%LOCALAPPDATA%\AVC-Anime\models` (config `userData/models-dir.json`,
  ключи `modelsDir` + `sttModel`), пользователь выбирает папку в Настройках →
  системный диалог; смена пути = копирование → сверка → атомарное переключение
  конфига → рестарт воркера; старый каталог не удаляется.
- Скачивание: HTTP Range докачка (`.part` в той же папке), SHA-256, размер,
  зеркала из манифеста (перебор на 404/5xx/сети), диск-спейс до скачивания,
  честные ошибки (HTTP_404/TLS/CHECKSUM/DISK_FULL/…), пауза = отмена с
  сохранением `.part` + повтор `install` продолжает с места остановки.
- Установка в `models/<id>/`, маркер `.avc-installed.json` пишется последним.
- Операции: install / verify / remove; сделать активной — через
  `set-stt-model` (движок заменяется целиком, hexagonal-граница).

## Аудиопайплайн и задержки

- Захват: WASAPI через WebAudio (рендерер), 16 кГц mono Int16, окна 4096.
- VAD: Silero (окно 512 = 32 мс), кольцевой буфер ~1.2 с предыстории → начало
  слова не теряется; хвост тишины 250 мс → endpoint; кулдаун 350 мс.
- Потоки инференса: `min(threads профиля)` — max_responsiveness 1 / balanced 2 /
  quality 3; сессия распознавателя живёт постоянно; warm-up после загрузки.
- Бюджет (замер на целевом классе ПК, streaming selftest): VAD endpoint
  ~0.25–0.5 с + декод фразы 1–2 с ~0.3 с + парсер < 5 мс → **< 1 с**.
- Бенчмарк «Проверить скорость на этом ПК»: декод тестового WAV (0.wav) →
  RTF = decodeMs/audioMs; RTF > 0.5 → рекомендация ru-fast + max_responsiveness.
  Результат показывается в Настройки → AI.

## Интеграция с командным пайплайном

- `stt-final` → `use-voice.handleRecognizedText` → `executeText(raw, 'voice',
  { correlationId })`. correlationId (UUID) генерируется на фразу и пишется в
  историю команд (`CommandHistoryEntry.correlationId`) — сквозная трассировка.
- Раннее исполнение (§12): безопасные частичные фразы (пауза/громкость/серия)
  исполняются по partial, опасные (UNSAFE_PATTERN) — никогда.
- Ошибка/нет модели: голос просто не стартует локально → падение на браузерный
  движок; текстовые команды продолжают работать. Приложение не падает.

## Как добавить новую модель (без кода)

1. Добавить запись в `electron-app/ai/models-manifest.json → models[]`
   (`engine` — существующий: `t-one-streaming` или `gigaam-offline`).
2. Прогнать `node scripts/validate-ai-assets.mjs` — URL/размер должны PASS.
3. Готово: модель появится в Настройки → AI с лицензией и рекомендацией.

## Как добавить новый движок

1. Adapter с интерфейсом `SttEngine` в `electron-app/ai/stt-engines.cjs` +
   запись в `ENGINES` (id, capabilities, modelIds, create).
2. Запись в каталоге с `"engine": "<id>"`.
3. Профиль/threads — через PROFILES; интерфейс событий не меняется.
