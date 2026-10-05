# VOICE_PIPELINE_AUDIT — AVC-Anime

## 1. Конвейер (v1.0.16/v1.0.17)

```
Микрофон (16 кГц mono, Int16)
  → avc:ai:stt-feed → AI-воркер (чистый Node, runtime-node) → VoicePipeline
  → VAD Silero (окно 512; предыстория из кольца 38 окон — начало слова не теряется)
  → endpoint: 200 мс тишины → финал (cooldown 250 мс) | PTT-режим: финал по отпусканию
  → движок по модели:
      t-one-streaming (T-One, 8 кГц)  — стриминговые partials
      gigaam-offline   (GigaAM v2/v3) — декод фразы целиком на endpoint
  → stt-partial/stt-final → рендерер → parser.ts → executor.ts
  → EarlyCommandDetector: безопасные partials (пауза/громче/следующая…) — §12/§13
```

## 2. Состояние каталога моделей (манифест v4)

| Модель | Движок | Размер | Роль |
|---|---|---|---|
| GigaAM v3 RNNT int8 | gigaam-offline | 167 МБ | **по умолчанию** (`default: true`, sha256 проверен загрузкой) |
| GigaAM v2 CTC int8 | gigaam-offline | 167 МБ | запасная точная |
| T-One Streaming | t-one-streaming | 128 МБ | быстрая для слабых ПК |

Fallback-цепочка при отсутствии файлов: preferred → gigaam-v3 → t-one → gigaam-v2.
Выбор модели — явный (sttModelChosen), сохраняется в models-dir.json.

## 3. Задержки (настройки фактические)

- финал после конца речи: 200 мс (tailMs >= 200) + декод фразы (~0.3–0.8 c на GigaAM int8);
- «мусор» короче 300 мс отбрасывается;
- cooldown VAD 250 мс против повторных срабатываний;
- PTT (рация): аудио без VAD-гейта, финал мгновенно по отпусканию кнопки.

## 4. Проверки этой сессии (статические)

| Проверка | Результат |
|---|---|
| Манифест v4: GigaAM v3 default, sha256, expectedFiles полные | PASS |
| resolveSttModelId цепочка fallback | PASS (чтение stt-engines.cjs) |
| Endpoint 200 мс / cooldown 250 мс / PTT flush | PASS (чтение stt-engines.cjs) |
| Установка: 3 попытки/URL + зеркала + Range-resume .part + SHA-256 + честные фазы | PASS (чтение model-manager.cjs) |
| Установка неактивной модели переключает на неё (stt:<id>) | PASS (чтение voice-pipeline.cjs) |
| Рантайм-прогон на Windows EXE (микрофон/точность/задержка) | BLOCKED (среда; проверяет владелец) |

## 5. Известные ограничения

- Точность STT зависит от микрофона/шумов; GigaAM v3 существенно точнее T-One
  на числах и названиях («Наруто 20 серия» — мотив выбора дефолта в v1.0.15).
- Бенчмарк (RTF) требует тестового WAV из каталога T-One (0.wav); при его
  отсутствии — честный отказ «Тестовый WAV не найден».
