# PRODUCTION_AUDIT — AVC-Anime (после релиза v1.0.16)

Дата аудита: 2026-10-04. Основа: чтение фактического кода (не предположения), история релизов 1.0.9–1.0.16, живые проверки сайта из предыдущих задач (LIBRARY_STATUS_MATRIX.md, research/yummytv-endpoints.md).

## 1. Архитектура (как есть)

```
AVC-Anime.exe (portable, electron-builder, NSIS-free)
├── main.cjs (Electron main)
│   ├── AuthenticationService (persist:yummyanime — cookie на диске, вход на реальном сайте)
│   │   ├── sessionWindow (скрытое, same-origin fetch/скрипты детекции)
│   │   └── loginWindow (видимое окно сайта)
│   ├── AI-воркер: child_process.fork(ai-worker.cjs, execPath=runtime-node/node.exe)
│   │   ├── VoicePipeline → STT-движки (t-one-streaming | gigaam-offline, sherpa-onnx)
│   │   └── AIModelManager (загрузка моделей: mirrors, Range-resume, SHA-256, retry)
│   ├── Next.js standalone-сервер (spawn ELECTRON_RUN_AS_NODE, порт 3010+)
│   ├── IPC: avc:auth:*, avc:anime:*, avc:ai:*, avc:update:*, avc:debug:*
│   └── updater: GitHub releases/latest → скачивание EXE → cmd-скрипт подмены
├── renderer: Next.js UI (zustand, parser.ts детерминированный, executor.ts)
└── данные: userData (БД custom.db, логи, модели, Partition yummyanime)
```

Сессии аккаунта — ДВА механизма, честно разделённых:
- **EXE**: постоянная Electron-сессия `persist:yummyanime` в main-процессе (IPC `avc:auth:*`, `avc:anime:*`);
- **Web-превью (браузер без EXE)**: серверная cookie-сессия Next.js (`db/yummy-session.json`, 0600), маршруты `/api/yummy/*`.

## 2. Подтверждённые проблемы (по коду)

### P1. Библиотека/Смотрю/В планах/оценки не показываются в EXE — ПОДТВЕРЖДЕНО
- `avcApi.yummyLibrary()` (src/lib/avc/api.ts:450) ходит в `GET /api/yummy/library`, который читает **только** web-сессию (`loadWebSession()` → db/yummy-session.json).
- В EXE пользователь входит через окно сайта (Electron-сессия в main) — cookie-файла нет → маршрут всегда отвечает «Войдите в аккаунт».
- Остальное (состояние аккаунта, избранное, действия списка/оценки/сердца, своё состояние тайтла) в EXE работает через IPC.
- **Fix**: `getLibrary()` в AuthenticationService (same-origin fetch `/api/profile` + `/api/users/{id}/lists/{N}` — эндпоинт подтверждён живой сессией 2026-10-03), IPC `avc:anime:library`, preload `readLibrary`, в api.ts — bridge-first, web-fallback сохраняется. Инвалидация кеша после действий/выхода.

### P2. Обновление приложения — 5 подтверждённых дефектов
1. **Скрипт-убийца самого себя**: `update-avc.cmd` делает `taskkill /f /pid <mainPid> /T`, а сам cmd.exe — потомок mainPid → дерево-килл гонится за собственным интерпретатором; гонка → подмена/перезапуск ненадёжны. **Fix**: двухфазная схема — приложение завершается штатно (before-quit уже снимает своих детей), скрипт только ЖДЁТ исчезновения PID (tasklist), подменяет файл (move; fallback: ren старого → move нового), пишет маркер, стартует новый EXE. Никаких taskkill изнутри дерева.
2. **Нет проверки целостности EXE** (§3.9): скачивание → сразу подмена. **Fix**: CI публикует SHA256SUMS.txt; установщик сверяет SHA-256 до установки.
3. **Main доверяет assetUrl рендерера**: повторной сверки версий при установке нет. **Fix**: install повторно запрашивает releases/latest и проверяет latest > current; assetUrl из рендерера игнорируется.
4. **UI-машина состояний отсутствует**: только toast + % в title (§3.5). **Fix**: UpdateDialog (navy theme): checking → current/latest → available (имя/дата/размер) → downloading (%, МБ, скорость, ETA) → verifying → preparing → restarting → error (retry) + итог после перезапуска.
5. **Прогресс без троттлинга/скорости** и блокирующая запись fs.writeSync на каждый чанк в main-процессе. **Fix**: троттлинг 250 мс, скользящее окно скорости.

### P3. Завершение процессов (§6) — в основном закрыто в 1.0.13, один остаточный риск
- `before-quit`+`will-quit`: killProcessTree (taskkill /T /F) для nextProcess и aiWorker; authService.shutdown() уничтожает login/session окна; splash/fatal окна уничтожаются.
- Остаточный риск — именно updater-скрипт (см. P2.1): старый `taskkill /T` из скрипта был единственным местом, где дерево могло остаться/уметь неправильно. Новая схема устраняет.
- Процессный реестр оформлен в PROCESS_LIFECYCLE_AUDIT.md.

### P4. История команд HTTP 500 — ИСПРАВЛЕНО в v1.0.16 (проверено)
- Причина (issue #1): EXE хранит БД между обновлениями; новая колонка `CommandHistoryEntry.correlationId` ломала старую БД → Prisma 500.
- Fix в коде: `src/instrumentation.ts` → `ensureSqliteSchema()` (CREATE TABLE IF NOT EXISTS + ALTER ADD COLUMN + UNIQUE INDEX) на старте сервера; маршрут возвращает честную ошибку вместо generic. Подтверждено чтением кода; runtime-проверка в dev-режиме — в отчёте.

### P5. Голос (точность/задержка) — ИСПРАВЛЕНО в v1.0.16 (проверено)
- GigaAM v3 — модель по умолчанию (манифест v4, `default: true`, sha256 снят с реального архива), цепочка fallback `preferred → gigaam-v3 → t-one → gigaam-v2`.
- Задержка финала: endpoint VAD 200 мс (tailMs >= 200) + cooldown 250 мс; PTT-режим рации.
- Установка моделей: 3 попытки на URL, зеркала, Range-resume .part, SHA-256, честные фазы прогресса.

### P6. Команды (§8) — регрессии НЕТ (проверено)
- В parser.ts композит «тайтл + серия» (`extractTitleEpisode`) выполняется ШАГОМ 5.5, ДО контекстного выбора серии (шаг 6) → «Наруто 1 серия» при активном Блич не откроет Блич-1. Голый тайтл — шаг 10 (SearchAnime).

### P7. Сессия/cookie (§5) — работает, подтверждено самотестом сервиса
- `persist:yummyanime` на диске (userData/Partitions/yummyanime), cookie не читаются/не логируются, selftest проверяет наличие cookie+каталога, сброс сессии требует подтверждения и делает бэкап.

## 3. Риски / ограничения тестов
- Сборка/запуск Windows EXE в этой среде невозможны (Linux-песочница) → все EXE-тесты честно BLOCKED, выполняются CI (windows-latest) и владельцем.
- Серверные действия с аккаунтом (оценка/списки) требуют живой сессии пользователя → BLOCKED по протоколу §34, чтение библиотеки подтверждено ранее живой сессией.

## 4. Порядок ремонта (выполнение)
1. Updater: main.cjs (check/install/marker/скорость) → CI SHA256SUMS → preload/api → UpdateDialog → header-bar.
2. Библиотека EXE: адаптер → сервис → IPC/preload → api.ts bridge-first.
3. Документы: AUTO_UPDATE_ARCHITECTURE / AUTO_UPDATE_TEST_MATRIX / YUMMYANIME_ACCOUNT_SYNC_AUDIT / YUMMYANIME_NETWORK_BEHAVIOR / PROCESS_LIFECYCLE_AUDIT / PROCESS_SHUTDOWN_TESTS / COMMAND_PIPELINE_AUDIT / VOICE_PIPELINE_AUDIT.
4. Проверки: lint, dev-сервер, браузерные проверки UI, схемы БД.
5. Commit → CI (windows-latest) → проверка артефакта EXE → Release → финальный отчёт.
