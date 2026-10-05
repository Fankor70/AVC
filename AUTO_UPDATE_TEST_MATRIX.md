# AUTO_UPDATE_TEST_MATRIX — AVC-Anime

Классификация: PASS / FAIL / BLOCKED / NOT TESTED / NOT APPLICABLE.
Среда проверки: Linux-песочница (dev-режим, браузер, node-проверки логики).
Сборка Windows EXE — GitHub Actions (windows-latest); запуск EXE — только у владельца → BLOCKED.

| # | Сценарий | Проверка | Результат | Основание |
|---|---|---|---|---|
| A1 | current == latest → НЕТ скачивания | Логика main + UI | PASS (логика) / BLOCKED (EXE) | `relation='up-to-date'` → install отклоняется в main; браузерный прогон: кнопки «Скачать» нет, текст «Скачивать нечего» |
| A2 | latest > current → доступно | Логика main + UI | PASS (логика) / BLOCKED (EXE) | числовое сравнение, UI «Доступна версия …» |
| A3 | current > latest → НЕТ отката | Логика main | PASS (логика) / BLOCKED (EXE) | `relation='older'` → отказ «установленная версия новее» |
| A4 | malformed version | node-прогон compareVersions | PASS | 9/9 кейсов: v1.0.17>1.0.16; =; <; 1.0.10>1.0.9; v1.1.0>1.0.99; v2.0.0>1.9.9; garbage→null; ''→null; v1.0.16-beta→0 |
| A5 | release отсутствует (404) | Логика main | PASS (логика) | честная ошибка «На GitHub нет опубликованного релиза» |
| A6 | GitHub недоступен | Логика main | PASS (логика) | try/catch → `{error}` → UI «Обновление не удалось» + «Проверить снова» |
| A7 | asset EXE отсутствует | Логика main | PASS (логика) | `available = newer && !!asset` → not available |
| A8 | сбой скачивания | Дизайн | PASS (логика) / NOT TESTED (реальный сбой) | try/catch → phase 'error', частичный файл удаляется при следующей попытке; установленный EXE не тронут |
| A9 | прерванная загрузка | Дизайн | PASS (логика) / BLOCKED (EXE) | WriteStream закрывается; `rmSync(newPath)` перед повтором; маркер пишется только ПОСЛЕ верификации |
| A10 | SHA-256 не совпал | Логика main | PASS (логика) / BLOCKED (EXE) | файл удаляется, ошибка, EXE не тронут |
| A11 | SHA256SUMS.txt отсутствует | Логика main | PASS (логика) | предупреждение, установка продолжается (старые релизы) |
| A12 | успешная установка + рестарт | Design + EXE | BLOCKED | двухфазный cmd (wait-exit → swap → start); маркер сверяется при старте; проверяется владельцем на Windows |
| A13 | верификация новой версии после рестарта | Логика main | PASS (логика) / BLOCKED (EXE) | checkPendingUpdate: `running == expectedVersion` → тост успеха; иначе честный отказ |
| A14 | UI state-машина (все фазы) | agent-browser + mock-мост | PASS | проверено: checking → available (версия/112 МБ/дата) → downloading (67%, 75.0/112.0 МБ, 8.0 МБ/с, ~5 с) → verifying → preparing → restarting (Отмена disabled); up-to-date (+баннер успеха 1.0.15→1.0.16, Current/Latest); error (GitHub 502 + retry) |
| A15 | main отклоняет установку без обновления | Логика main | PASS (логика) | install повторно запрашивает releases/latest и сверяет версии сам |
| A16 | прогресс не блокирует UI | Дизайн | PASS (логика) | WriteStream + троттлинг 250 мс (было: fs.writeSync на каждый чанк) |

Итог: логические проверки — PASS; реальные EXE-прогоны (A8/A9/A10/A12 частично) — BLOCKED в этой среде, выполняются CI-сборкой и владельцем.
