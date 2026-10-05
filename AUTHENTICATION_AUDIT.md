# AUTHENTICATION_AUDIT — AVC-Anime × YummyAnime

Дата: 2026-10-02 · Аудит выполнен ПЕРЕД изменением кода (требование спеки, секция 1)

---

## 1. Current browser architecture

**Продукт** = Windows EXE: Electron-оболочка + встроенное Next.js-приложение (App Router,
порт 3000 в dev, программный сервер в пакете). В текущей среде разработки доступна
**только веб-часть** (`src/`): папка `electron-app/` (main/preload/сервисы) была утеряна
при переносе среды — подтверждено в worklog (`github-save-1`). Git-история и GitHub
(https://github.com/HellShaftSam/AVC-AnimeVoiceCommand) оболочку тоже не содержат.

Следствие: архитектура аутентификации, живущая в Electron, должна быть создана заново.

## 2. Current YummyAnime integration

- `src/lib/sites/yummy/adapter.ts` — серверный адаптер: поиск/каталог/детали/видео по
  публичным JSON/HTML эндпоинтам `old.yummyani.me` (работает, не трогаем).
  Аутентифицированная часть: `getAccountState()` (GET /api/profile, 401/200 — подтверждено
  живым сайтом), `siteLogout()` (POST /api/profile/logout), `getFavorites()`
  (GET /actions/export-favorites.php?format=json&vote=0) + защитные нормализаторы
  `normalizeProfile` / `normalizeFavorites` (ничего не выдумывают).
- Селекторы/URL в одном месте (`SELECTORS`), UA-строка фиксированная.

## 3. Current session persistence

- **Реализована схема cookie-моста** (отвергается новой спекой, секции 15/16):
  `session-store.ts` хранит сырую cookie-строку в `db/yummy-session.json` (0600),
  cookie попадают в Next.js API (`POST /api/yummy/session`) и в заголовки серверного
  fetch адаптера. На диск/в git файл cookie не попадал (проверено: `git ls-files` чист,
  `db/` содержит только SQLite) — утечки нет, но сам паттерн запрещён.
- Постоянного браузерного профиля сайта в текущем коде НЕТ (оболочка утеряна).

## 4. Current authentication code (клиент)

- `store.ts`: `yummyAccount: YummyAccountSnapshot` (+ `authOpen`, `favoritesOpen`).
- `api.ts`: `yummyAccount()`, `syncYummySession(cookie)` ← удалить, `yummyLogout()` ←
  удалить, `yummyFavorites()`.
- `executor.ts`: `refreshAccount()`, `openSiteProfile()`, `checkAccount()`,
  `accountLogout()` (голосовые команды), локальная метка `avc:lastWatched` (глобальная —
  нет изоляции по аккаунту, секция 14 требует `localAccountId`).
- UI: `auth-dialog.tsx` (инструкции + ручная вставка cookie ← удалить), `header-bar.tsx`
  (чип аккаунта/гостя — оставить, источник состояния сменится), `library-panel.tsx`
  (избранное с сайта), `debug-panel.tsx`, `settings-dialog.tsx`.
- Типы (`types.ts`) уже описывают безопасную модель `YummyAccountSnapshot`
  (без секретов) — **переиспользуем как IPC-контракт 1:1**.

## 5. Existing problems

1. Cookie-мост: cookie пересекают границу рендерера/API (прямо запрещено секцией 15).
2. Ручная вставка cookie через DevTools — нерабочий UX (отвергнут пользователем).
3. Нет постоянной браузерной сессии сайта → нет переживания перезапусков.
4. Нет AuthenticationService с машиной состояний и event-driven детекцией.
5. `avc:lastWatched` глобальный — данные разных аккаунтов смешиваются (секция 14).
6. `openSiteProfile`/`header-bar` fallback на несуществующий `/profile` (частично
   исправлено в `site-urls.ts` — сохранить).
7. Проверки состояния строятся на одном сигнале (HTTP 401/200) — нужна
   multi-signal/confidence стратегия (секция 5).

## 6. Recommended integration point

**Electron main = владелец сессии.** Одноразовый источник правды:

```
AVC-Anime (Next UI)
  ↕ IPC (contextBridge avcElectron — только НЕ-секретные снимки)
Electron main: AuthenticationService
  ↕ постоянная сессия session.fromPartition('persist:yummyanime')  ← переживает перезапуски
old.yummyani.me (реальный вход, капча/2FA — на сайте)
```

- Детекция состояния — код, исполняемый В контексте страницы сайта
  (`webContents.executeJavaScript`): same-origin `fetch('/api/profile')` (сами куки
  браузера, значения не читаем) + DOM-сигналы (форма «Вход», `/users/id`-ссылки, аватар
  `static.yani.tv/users/`, «Выход») → confidence-голосование.
- Снапшот аккаунта (не-секретный) персистится в `userData/yummy-account.json`.
- Next-API для аутентифицированных данных → честные «доступно в EXE» ответы
  (web-режим), либо снимок из IPC. Cookies в API не ходят вообще.

## 7. Files that must change

| Файл | Действие |
|---|---|
| `electron-app/main.cjs` | создать: окно, persistent partition, сервис, IPC, selftest-режим |
| `electron-app/preload.cjs` | создать: contextBridge `avcElectron` |
| `electron-app/auth/yummy-auth-adapter.cjs` | создать: ВСЯ сайт-специфичная детекция (секция 23) |
| `electron-app/auth/authentication-service.cjs` | создать: машина состояний, verify, logout |
| `electron-app/auth/account-store.cjs` | создать: персист не-секретного снапшота + recovery |
| `electron-app/tools/auth-selftest.cjs` | создать: диагностический прогон (секция 9/20/24) |
| `electron-app/package.json` | создать: electron + electron-builder (portable EXE) |
| `src/lib/avc/api.ts` | удалить cookie-мост; Electron-first хелперы |
| `src/lib/avc/executor.ts` | Electron-first account; изоляция `lastWatched` по аккаунту |
| `src/components/avc/auth-dialog.tsx` | UX: «Войти через окно сайта» (без cookie-вставки) |
| `src/app/api/yummy/session/route.ts` | **удалить** |
| `src/lib/sites/yummy/session-store.ts` | **удалить** |
| `src/lib/sites/yummy/adapter.ts` | отпилить аутентифицированные методы (остаются публичные) |
| `src/app/api/yummy/account|favorites/route.ts` | честный web-режим (EXE required) |
| `src/lib/avc/types.ts` | + тип selftest-отчёта (безопасный) |
| `src/components/avc/diagnostics-dialog.tsx` | создать: секция 20 |

## 8. Files that should NOT be changed

- `src/lib/sites/yummy/adapter.ts` — публичные методы поиска/каталога/деталей/видео,
  `fallback.ts` (demo), парсеры селекторов.
- Плеер: `player.tsx`, `player-bridge.ts` (перемотка/громкость/озвучки — рабочие).
- Голос: `parser.ts`, `provider-resolver.ts`, `use-voice.ts` (кроме точек вызова
  аккаунт-команд в `executor.ts`).
- `session-restore-dialog.tsx`, вкладки, история команд (`/api/history`), Prisma-схема
  (пользовательских моделей уже нет — thin client), `site-urls.ts` (свежий фикс).
