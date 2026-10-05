# ACCOUNT_MODEL — реальная модель аккаунта YummyAnime (Task ID: audit-main-1)

Источник: живой сайт old.yummyani.me (гостевые GET-запросы + бандлы сайта, октябрь 2026) + публичный клиент YummyTV (эндпоинты помечены [LIVE-VERIFY] до проверки в сессии). Ничего не выдумано.

## 0. Как сайт представляет аккаунт

- **Аутентификация**: cookie-сессия (`PHPSESSID` и пр.) внутри домена. Логин: `POST /api/profile/login {login, password, recaptcha_response}` (hCaptcha; sitekey `b1847961-208e-4a90-9671-1e6bba9e0b36`), либо Telegram-бот / VK / Shikimori OAuth. Соц-входы = редиректы, токен приходит в сессию сайта.
- **Заголовки API**: сайт шлёт `X-Application: wawegr8j13it4rdw` и `Lang: ru` на все `/api/*` вызовы (из build.min.js — точная строка).
- **Текущий пользователь**: `GET /api/profile` → 200 + профиль | 401 `{"error":"Для совершения данного действия необходимо авторизоваться","error_code":1}`.
- **AVC-Anime**: держит cookie в persist-сессии Electron; действия выполняются same-origin fetch ВНУТРИ сессии (как это делает сам сайт). Cookie не читаются и не покидают main-процесс.

## 1. Реестр эндпоинтов (все под `https://old.yummyani.me/api`, из бандлов сайта; GET-части проверены гостем)

| Функция | Метод и путь | Тело / параметры | Проверка успеха | Проверка провала |
|---|---|---|---|---|
| Профиль | GET `/profile` | — | 200, JSON профиля | 401 (гость/истёк) |
| Логин | POST `/profile/login` | `{login, password, recaptcha_response}` | 200 + сессия | 420/капча, «Неправильный логин!» |
| Выход | POST `/profile/logout` | — | следующий GET /profile → 401 | 401 уже был |
| **Списки (библиотека)** | PUT `/anime/{id}/list` | `{list: N}` (реестр ниже) | 200; повторный GET своего состояния | 401; статус не изменился |
| Убрать из списка | DELETE `/anime/{id}/list` | — | счётчик списка −1 | 401 |
| **Избранное** | PUT `/anime/{id}/list/fav` | `{date}` | 200 | 401 |
| Убрать из избранного | DELETE `/anime/{id}/list/fav` | — | — | 401 |
| Счётчики списков (публично) | GET `/anime/{id}/lists` | — | 200 `[{list_id,count}]` | — |
| **Оценка** | PUT `/anime/{id}/rate` | `{rate: 1..10}` | 200; histogram/my-rating | 401; вне 1..10 |
| Убрать оценку | DELETE `/anime/{id}/rate` | — | my-rating → 0/скрыт | 401 |
| Гистограмма (публично) | GET `/anime/{id}/rates` | — | 200 `{10:2702,…}` | — |
| **Прогресс просмотра** | PUT `/video/{videoId}` | `{time, times[]}` (сек; times — массив отметок) | 200; после reload состояние эпизода watched/продолжить | 401/404 |
| Подписка на новые серии | PUT `/video/{id}/subscribe` · DELETE | — | 200 | 401 |
| Уведомления | GET `/profile/notifications` · DELETE `/{id}` | — | 200 | 401 |
| Комментарии | GET/POST `/comments/{owner}/{id}` | `{skip,sort}` / текст | 200; после reload комментарий есть | 401/ошибка валидации |
| Лайк комментария | PUT `/comments/{id}/vote` | `{action:1|-1}` | 200 | 401 |
| Редактирование/удаление | PATCH/DELETE `/comments/{id}` | — | 200 | 401/чужой |
| Рецензии | GET `/anime/{id}/reviews` · POST `/reviews` · PATCH/DELETE `/reviews/{id}` | — | 200 | 401 |
| Друзья | GET/PUT/DELETE `/users/{id}/friends` | `{offset,limit}` | 200 | 401 |
| Профиль пользователя | GET `/users/{id}` (id формат `id503741`) | — | 200 (гость видит публичное) | 404 |
| Личные сообщения | GET/POST `/dialogs[/{id}/messages]` | — | 200 | 401 |
| Поиск | GET `/search` | `{q, limit, offset}` | 200 | — |
| Каталог-фильтр | GET `/anime` | `{q, sort, limit, offset}` | 200 | — |
| Эпизоды×озвучки | GET `/anime/{id}/videos` | — (БЕЗ пагинации — всё сразу) | 200 | — |
| Трейлеры/похожие | GET `/anime/{id}/trailers|recommendations` | — | 200 | — |
| Порядок просмотра | поле `viewing_order` в `/anime/{id}` (YummyTV) | — | [LIVE-VERIFY] | — |
| Избранное (экспорт списком) | GET `/actions/export-favorites.php?format=json&vote=0` | вне /api | 200 JSON | — (используется уже) |

**Гостевые проверки, выполненные реально**: GET `/profile`→401 ✅; GET `/api/favorites`→**404 (не существует)** ✅; GET `/api/anime/111/lists`→200 ✅; GET `/api/anime/111/rates`→200 ✅; GET `/api/users/id503741`→200 ✅.

## 2. Реестр статусов библиотеки (из бандла сайта, массив `Rt` — ТОЧНЫЕ имена)

| list_id | Название на сайте | href/код | Иконка |
|---|---|---|---|
| 0 | Смотрю | watch_now | fa-eye |
| 1 | В Планах | will | fa-cloud |
| 2 | Просмотрено | watched | fa-flag-checkered |
| 3 | Брошено | lost | fa-eye-slash |
| 4 | Любимые | favourite | fa-heart |
| 5 | Отложено | postpone | fa-history |
| 6 | **неизвестный** (есть в публичных счётчиках `/lists`, отсутствует в UI-конфиге) | ? | ? — требует проверки в сессии [LIVE-VERIFY] |

Публичные счётчики списков приходят как `[{list_id:0,count},{…}]` — формат подтверждён.

## 3. Модель эпизодов и плеера

- `/api/anime/{id}` → `episodes {count, aired, next_date}` (у завершённых count=220 у Наруто; у онгоингов count=0, работает aired).
- `/api/anime/{id}/videos` → **весь** список записей: `{video_id, number:"N" (строка!), data:{player, dubbing, player_id}, iframe_url, skips:{opening,ending:{time,length}}, views, duration}`. Плееров на эпизод может быть несколько (Kodik/Alloha/Sibnet/CVH). Пагинации НЕТ.
- Свои URL на эпизод не существуют — плеер живёт на странице аниме, выбор через JS.
- Прогресс: сам сайт-плеер шлёт `kodik_player_time_update` → `PUT /api/video/{videoId} {time, times[]}`; продолжение — через параметр `start`/`start_from` в iframe-URL. Состояние watched для залогиненного приходит в записях `/videos` (поле `watched`) [LIVE-VERIFY].

## 4. UI сайта для действий (что «нажимает» пользователь на оригинале)

- Списки/оценка/избранное — блок на странице аниме; для гостя вместо кнопок маркер «Зарегистрируйтесь, чтобы добавить аниме в свои списки»; избранное (сердечко) отрисовывается, но требует сессии.
- Оценка: звезда → модалка `ul.rating-list li[data-rate]` с подписями 10 «шедевр» … 1 «ничтожно» (целые 1..10).
- Кнопка «Порядок просмотра» (`#view-list-button`, data-id франшизы) на странице аниме.

## 5. Как AVC-Anime выполняет и верифицирует действия (спека I §9)

Паттерн для КАЖДОГО действия (внутри AuthenticationService, same-origin, cookie не покидают main):

```
ДЕЙСТВИЕ: session.executeScript(fetch(PUT/DELETE …, X-Application+Lang, credentials:'include'))
   ↓ HTTP 200?
ВЕРИФИКАЦИЯ (server-backed read): GET состояния (свой список/оценка/подписка)
   ↓ совпало?
RELOAD-проверка: повторный GET через ≥1с (исключить кэш)
   ↓
UI: «Добавил в Смотрю.» / при провале: точный слой (сеть/сервер/верификация)
```

Тест-безопасность (спека §34/36): перед изменением читается текущее состояние, после теста — восстановление (например, было `list:1` → тест `list:0` → verify → назад `list:1` → verify).

## 6. Чего на сайте НЕТ (честно, NOT_SUPPORTED)

- `/api/favorites` и `/api/bookmarks` — не существуют (404).
- Отдельных URL эпизодов нет; «просмотренные серии» — атрибуты в `/videos` + серверный прогресс, не отдельная сущность.
- Кастомные пользовательские списки (вне 6 статусов) — на текущем сайте не обнаружены ни в UI, ни в API-бандле → NOT_SUPPORTED BY CURRENT WEBSITE.
- Публичное чтение чужих списков гостем — `GET /api/users/{id}/lists` → 400 (Arguments error) — требуется сессия/параметры [LIVE-VERIFY].
