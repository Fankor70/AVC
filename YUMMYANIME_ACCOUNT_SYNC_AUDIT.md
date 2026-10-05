# YUMMYANIME_ACCOUNT_SYNC_AUDIT — AVC-Anime

Принцип (§4.1): локального аккаунта НЕТ. Пользователь входит на реальном сайте;
сессия живёт в постоянном Electron-профиле `persist:yummyanime` (EXE) или в
серверной cookie-сессии Next.js (web-превью). Сервер всегда авторитетен.

## 1. Найденный корень («Библиотека/Смотрю/В планах не показываются»)

Две параллельные сессии, и библиотека была привязана не к той:

| Функция | EXE-сессия (main, IPC) | Web-сессия (Next, cookie-файл) |
|---|---|---|
| Состояние аккаунта | avc:auth:getState | /api/yummy/account |
| Избранное | avc:auth:favorites | /api/yummy/favorites |
| Действия (список/оценка/сердце) | avc:anime:action | /api/yummy/action |
| Своё состояние тайтла | avc:anime:own-state | /api/yummy/anime-state |
| **Библиотека (списки статусов)** | **НЕ БЫЛО** → /api/yummy/library | /api/yummy/library |

`avcApi.yummyLibrary()` ходил ТОЛЬКО в web-маршрут, читающий
`db/yummy-session.json`. В EXE этого файла нет (вход через окно сайта в main) →
панель «Библиотека» всегда показывала «Войдите в аккаунт» при активной сессии.

**Fix (v1.0.17):** `AuthenticationService.getLibrary()` — same-origin fetch
`/api/profile` (числовой id) + `/api/users/{id}/lists/{N}` (listId 0..5) внутри
сессии main-процесса; IPC `avc:anime:library`; preload `readLibrary()`;
`avcApi.yummyLibrary()` — bridge-first, web-fallback сохранён. Кеш 2 мин,
инвалидация при любом успешном действии/выходе/сбросе сессии.

## 2. Матрица функций аккаунта (сервер = источник истины)

| Функция | Механика (сайт) | Чтение в приложении | Запись + сервер-верификация |
|---|---|---|---|
| Смотрю (list_id 0) | GET /api/users/{id}/lists/0; PUT /api/anime/{id}/list {list} | PASS (web, живые данные: 16 тайтлов) + PASS (EXE-путь, тот же формат через IPC) | PUT через executeAnimeAction/animeAction: HTTP → reload HTML → сверка ('pass'/'mismatch'/'unconfirmed') |
| В Планах (1) | аналогично | PASS (web: 11) | аналогично |
| Просмотрено (2) | аналогично | PASS (web: 65) | аналогично |
| Брошено (3) | аналогично | PASS (web: 1) | аналогично |
| Любимые (4, is_fav) | /list/fav PUT/DELETE | PASS (web: 1) | аналогично |
| Отложено (5) | аналогично | PASS (web: 0) | аналогично |
| Оценки 1..10 | PUT/DELETE /api/anime/{id}/rate; user.rating в списках | PASS («моя: N» на карточках) | PASS (тот же verify-конвейер) |
| Прогресс серий | сайт наружу НЕ отдаёт (PUT /video/{id} внутри плеера) | локальный трекинг SQLite (честно помечено как локальный) | NOT APPLICABLE (сайт не предоставляет чтение) |
| История просмотра | /video/watch-history только у token-API (api.yani.tv) | NOT IMPLEMENTED (нужен отдельный аудит token-API) | — |

Живые значения сняты из работающего web-режима (аккаунт HellShaftSama):
Смотрю 16, В Планах 11, Просмотрено 65, Брошено 1, Отложено 0, Любимые 1, всего 93.

## 3. Что НЕ сделано и почему (честно)

- Запись действий аккаунта через EXE-сессию: код есть и верифицируется reload-ом
  страницы, но автоматический прогон «изменить → verify → вернуть» требует
  живой сессии пользователя → BLOCKED по протоколу §34 (не тестируем на
  реальном аккаунте без владельца).
- api.yani.tv (token-API из YummyTV) — не используется; отдельное решение владельца.
