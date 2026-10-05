# YUMMYANIME_NETWORK_BEHAVIOR — сетевое поведение сайта vs приложение

Все эндпоинты сняты с бандла сайта (build.min.js v3.0.308) и проверены живыми
запросами (см. LIBRARY_STATUS_MATRIX.md, research/yummytv-endpoints.md). Ничего
не выдумано; всё, что требует сессии, помечено.

## 1. Карта запросов сайта (old.yummyani.me)

| Назначение | Запрос | Авторизация | Статус проверки |
|---|---|---|---|
| Состояние входа | GET /api/profile | cookie | PASS (401 гость / 200 профиль) |
| Вход | форма на главной (POST /login/) или VK/Shiki/TG | — | PASS (детекция формы/капчи/ошибки) |
| Выход | POST /api/profile/logout | cookie | PASS |
| Списки статусов | GET /api/users/{numericId}/lists/{0..5} | cookie | PASS (живая сессия 2026-10-03) |
| Смена списка | PUT /api/anime/{id}/list {list:N} | cookie + X-Application | PASS (запрос снят с бандла; прогон — BLOCKED §34) |
| Удаление из списка | DELETE /api/anime/{id}/list | то же | PASS/ BLOCKED прогон |
| Оценка | PUT/DELETE /api/anime/{id}/rate {rate:1..10} | то же | PASS/BLOCKED прогон |
| Избранное | PUT/DELETE /api/anime/{id}/list/fav | то же | PASS/BLOCKED прогон |
| Экспорт избранного | GET /actions/export-favorites.php?format=json&vote=0 | cookie | PASS (используется приложением) |
| Поиск/каталог | GET /api/search?q=… , /api/anime/{id}, /api/anime/{id}/videos | публично | PASS |
| Прогресс просмотра | PUT /api/video/{videoId} {time,times[]} | cookie (плеер) | Сайт наружу НЕ отдаёт — приложение ведёт локальный трекинг |

Заголовки API сайта: `X-Application: wawegr8j13it4rdw`, `Lang: ru`,
`X-Requested-With: XMLHttpRequest`, `Accept: application/json`.

## 2. Как приложение воспроизводит поведение сайта

- EXE: все запросы выполняются КАК САМ САЙТ — same-origin `fetch` внутри
  скрытого окна постоянной сессии (cookie подставляет браузер, значения cookie
  не читаются и не покидают профиль). Действие → HTTP-ответ → reload страницы
  тайтла → чтение серверных маркеров (.fav-type.selected / .fav-type-fav /
  .user-rating) → сверка ожидаемого состояния → 'pass'/'mismatch'/'unconfirmed'.
- Web: те же запросы серверным fetch с cookie-сессией (0600 на диске), верификация
  тем же разбором серверного HTML.
- UI обновляется только после подтверждения сервера (§4.4/§4.5): локальных
  «притворных» переключений списков/оценок нет.

## 3. Сессия/cookie (§5)

- `persist:yummyanime` — cookie на диске (userData/Partitions/yummyanime),
  переживают перезапуск приложения и ПК; самотест сервиса проверяет наличие
  cookie + каталога; сброс — только с явным подтверждением и с бэкапом профиля.
- Секреты никогда не crosses IPC/рендерер/логи (redact на этапе записи).
