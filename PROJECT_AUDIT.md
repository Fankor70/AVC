# PROJECT_AUDIT — AVC-Anime (Task ID: audit-main-1)

Дата: 2026-10-03. Источники: полный аудит кода (Task 1-a), живое исследование old.yummyani.me (Task 1-b, GET-only), публичный клиент YummyTV (Task 1-c). Правило: ни один факт не выдуман — только проверенное.

---

## 1. Текущая архитектура (фактическая)

```
┌─ EXE (Electron 33.2.0, electron-app/) ──────────────────────────────┐
│ main.cjs                                                            │
│  • поднимает Next standalone сервер (127.0.0.1:3010+,               │
│    ELECTRON_RUN_AS_NODE), БД → <userData>/db/custom.db              │
│  • AuthenticationService: partition 'persist:yummyanime'            │
│    (cookie сайта живут на диске, переживают рестарты), IPC          │
│    avc:auth:getState|open-login|verify|logout|favorites|            │
│    reset-session|selftest; пуши avc:account-changed/auth-status     │
│  • ad-shield (adfinity.pro), single-instance, лог без секретов      │
│ preload.cjs — contextBridge avcElectron (только не-секретные        │
│    снимки; cookie/токены не пересекают границу — спека §15)         │
│ auth/authentication-service.cjs — машина состояний                   │
│    UNKNOWN/CHECKING/LOGGED_OUT/LOGIN_REQUIRED/LOGGING_IN/           │
│    LOGGED_IN/SESSION_EXPIRED/ERROR; event-driven детекция входа;    │
│    выход ТОЛЬКО через сайт; selftest PASS/FAIL/SKIP/BLOCKED         │
│ auth/yummy-auth-adapter.cjs — ВСЕ селекторы/сценарии сайта          │
│    (GET /api/profile 401/200, DOM-маркеры #current_user_id и др.)   │
│ auth/account-store.cjs — не-секретный снимок аккаунта (0600)        │
└──────────────────────────────────────────────────────────────────────┘
                    ↓ loadURL
┌─ Next.js 16 UI (renderer, src/) ─────────────────────────────────────┐
│ page.tsx — оболочка: HeaderBar/QuickSections/TabsBar/#avc-content/  │
│   HistoryPanel/VoicePanel/MiniPlayer + 10 диалогов                  │
│ lib/sites/yummy/adapter.ts — YummyAnimeAdapter:                      │
│   GET /api/search?q= · /api/anime/{id} · /api/anime/{id}/videos ·   │
│   HTML /catalog[…]?page=N · /catalog/random (302)                    │
│   кэш in-memory 5 мин, таймаут 12с, fallback на demo-данные         │
│ lib/avc/executor.ts (1172 строк) — ВСЕ голосовые команды →          │
│   действия (38 интентов); lastWatched изоляция по userId;           │
│   дебаунс повторов 2.5с; LLM-fallback /api/voice/interpret          │
│ lib/voice/* — детерминированный RU-парсер (нормализация, числа,     │
│   фуззи, фонетика, алиасы аниме/озвучек)                            │
│ lib/avc/use-voice.ts — push-to-talk (Ctrl+Space) / always-listening;│
│   движки: browser (Web Speech ru) / server (WAV 16k → /api/voice/   │
│   asr → z-ai SDK) / auto; VAD; жёсткий кап 12с на фразу             │
│ player.tsx — iframe плеера сайта (alloha.yani.tv / kodikplayer /    │
│   sibnet), ДВУСТОРОННИЙ мост postMessage (player-bridge.ts,         │
│   протоколы aksor+kodik), автозапуск, get_time-поллинг 1с           │
│ Prisma/SQLite: AppSetting, CommandHistoryEntry, TabSession,         │
│   VoiceAlias (БЕЗ User — thin client, аккаунт только на сайте)      │
└──────────────────────────────────────────────────────────────────────┘
```

## 2. Текущая интеграция с YummyAnime

| Область | Механизм | Статус |
|---|---|---|
| Вход | окно сайта в persist-сессии, event-driven детекция, капча/ошибка — честные тосты | ✅ работает, live-протестировано |
| Профиль | `GET /api/profile` внутри сессии + DOM-маркеры, мульти-сигнальная детекция | ✅ |
| Выход | `POST /api/profile/logout` внутри сессии + verify | ✅ |
| Избранное (список) | `GET /actions/export-favorites.php?format=json` внутри сессии | ✅ (валидация формата защитная) |
| Каталог/поиск/детали/эпизоды | adapter → JSON API сайта (гость, без cookie) | ✅ но: см. §3 п.4 |
| Плеер | iframe сайта + postMessage мост | ✅ |
| Статусы списков/оценка | НЕТ — кнопки делегируют открытию страницы сайта (executeSetWatchStatus/ToggleFavorite) | ⚠️ к реализации через site-API |
| Прогресс просмотра | только локальный lastWatched; серверный `PUT /api/video/{id}` шлёт сам сайт (React-плеер) | ⚠️ чтение/синхронизация не реализованы |

## 3. Существующие проблемы (ранжировано)

1. **Краш EXE**: `src/app/page.tsx:89` вызывает `toast(...)` без импорта → ReferenceError при `avc:auth-status` (капча/неверный пароль/таймаут входа). Замаскирован `ignoreBuildErrors`.
2. **«57–58 серий у Наруто» / счётчики**: данные сервера ПОЛНЫЕ (проверено живьём: `/api/anime/111/videos` → 1793 записи, 220 уникальных эпизодов; One Piece → 8714/1180). Причины в UI: (а) сетка эпизодов `max-h-64` (~4–5 строк × 12 колонок ≈ 48–60 видимых кнопок), внутренний скролл недоступен голосу (`executeScroll` скроллит только `#avc-content`); (б) чипы озвучек показывают per-dub счётчик — у One Piece есть озвучка ровно на 58 эпизодов (LE-Production, Макс Летов & ShiYori) — выглядит как «всего 58»; (в) таймаут 12с на 5-МБ `/videos` → пустые списки эпизодов на медленной сети → «серия не найдена»; (г) клиентский `detailsCache` без TTL не инвалидируется даже «Обновляю страницу».
3. **Нет автоперехода/автопропуска**: `settings.autoplayNext` нигде не читается; `kodik_player_video_ended` только гасит кнопку play; `skips` (opening/ending) из `/videos` не используются.
4. **LLM-fallback отстал**: промпт `interpret/route.ts` не знает 10 новых интентов (Mute/SetWatchStatus/OpenProfile/…).
5. **Playback глобальный, не per-tab** — две вкладки с аниме дерутся за один плеер.
6. **Микрофон обрезает фразу на 12с** (`MAX_UTTERANCE_MS`) — жалоба «15 секунд».
7. **Тихий demo-fallback**: при сетевой ошибке adapter возвращает demo-данные; в search/details/random нет индикатора «demo» → пользователь думает, что это реальные карточки.
8. Кэш adapter не ограничен по размеру; история команд без ретеншена; `/api/favorites` НЕ существует (404 — прежнее предположение исправлено; список избранного — `export-favorites.php`).

## 4. Переиспользуемые компоненты (не трогать)

- `electron-app/auth/*` + `main.cjs` IPC-поверхность (add-only) — только что перестроены и live-протестированы.
- `src/lib/avc/{api,types,store}.ts` — контракты UI/EXE 1:1.
- `src/lib/avc/player-bridge.ts` — реверс-инжиниринг протоколов плеера, эмпирически проверен.
- `src/lib/voice/*` (кроме точечных расширений) — детерминированный слой.
- `src/lib/avc/site-urls.ts`, `src/lib/sites/yummy/fallback.ts` (demo-id не пересекаются с реальными).
- Схема Prisma (thin client — требование спеки), честные web-стабы `api/yummy/*`.

## 5. Файлы к изменению (реализация)

| Файл | Что |
|---|---|
| `src/app/page.tsx` | +импорт toast (краш) |
| `src/lib/sites/yummy/adapter.ts` | таймаут/ретраи для `/videos` (5 МБ), лимит кэша, флаг `source: live|demo` |
| `src/lib/avc/executor.ts` | TTL/инвалидация detailsCache, голос-скролл внутренних контейнеров, единый ActionService для UI/клавы/голоса (спека II §65) |
| `src/components/avc/anime-view.tsx` | сетка эпизодов: убрать max-h-64 → пагинация/окно, честные счётчики |
| `src/components/avc/player.tsx` | auto-next (по `kodik_player_video_ended` + autoplayNext), auto-skip по `skips` |
| `electron-app/auth/yummy-auth-adapter.cjs` | +сценарии site-API действий (список/оценка/фав/подписка/прогресс) ВНУТРИ сессии |
| `electron-app/auth/authentication-service.cjs` | +IPC-мост действий `avc:anime:action` (add-only) |
| `electron-app/preload.cjs` | +expose действия (не-секретные результаты) |
| `src/app/api/voice/interpret/route.ts` | синк списка интентов |
| `src/lib/avc/use-voice.ts` | `MAX_UTTERANCE_MS` из настроек |

## 6. Система сборки / генерация EXE

- Цепочка: `bun run build` (standalone + static) → `electron-app: npm run dist` (electron-builder, **portable**, `AVC-Anime-Portable-${version}.exe`, иконка `build/icon.png`).
- extraResources: `.next/standalone → next-app`, `.next/static`, `public`, **`../db`** (стартовая БД → `userData/db/custom.db`), **`../node_modules/.prisma`** (движок Prisma).
- main.cjs: свободный порт от 3010, `DATABASE_URL` с прямыми слэшами (фикс Windows), ожидание сервера 30с, лог `userData/logs/avc.log` с ротацией и редактированием секретов.
- CI (подготовлен, ждёт разрешения на пуш): `docs/ci/build-exe.yml` — windows-latest, npm, prisma generate+db push, next build, electron-builder `--config.extraMetadata.version=1.0.<run_number>`, GitHub Release `/releases/latest`.
- Гэпы: нет NSIS-инсталлятора, подписи, автообновления; голос в EXE идёт через серверный ASR (z-ai, интернет нужен) — офлайн-STT (sherpa-onnx) был утерян, не восстановлен.

## 7. Соответствие спеке I (реальный клиент)

- §5/§6/§27: архитектура «тонкий клиент + реальная сессия сайта» уже соответствует; оригинальный UI сайта остаётся источником аутентификации и выхода.
- §9: верификация server-backed действий — паттерн уже есть в AuthenticationService (verify после logout); распространяется на новые действия.
- §8: изоляция аккаунтов — lastWatched уже по userId; снимок аккаунта не-секретный; кэш избранного в памяти процесса (не на диск).
- §29: никаких обходов капчи/2FA — вход только в окне сайта (hCaptcha sitekey `b1847961-…` используется самим сайтом).
- §31: одна persist-сессия на все вкладки — соответствует.
- §33: секреты не логируются (redact в main.cjs), не хранятся (0600 снимок без секретов), cookie не покидают main-процесс.
