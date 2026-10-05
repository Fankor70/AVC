# AUTO_UPDATE_ARCHITECTURE — AVC-Anime (v1.0.17+)

## 1. Как работает текущий (новый) обновлятор

Портативный EXE обновляет сам себя через GitHub Releases, без electron-updater
(портативная сборка без установщика — NSIS-метаданные недоступны).

```
Кнопка «Обновление» (header-bar)
   ↓ открывает UpdateDialog
checkUpdate() → main: GET api.github.com/repos/HellShaftSam/AVC-AnimeVoiceCommand/releases/latest
   ↓ (только опубликованный релиз: не draft, не prerelease — семантика /releases/latest)
Парс версий: v?MAJOR.MINOR.PATCH → [num, num, num], ЧИСЛОВОЕ сравнение (1.10.0 > 1.9.0)
   ↓
relation = newer | older | up-to-date | unknown
   ├─ up-to-date / older → «У вас последняя версия» / «установлена более новая» — НИКАКОГО скачивания
   └─ newer → UI: версия/имя/дата/размер/заметки → кнопка «Скачать и установить»
        ↓ installUpdate()
main ПОВТОРНО запрашивает releases/latest и сверяет latest > current (§3.3, защита от рендерера)
   ↓
Скачивание EXE в %TEMP%\avc-update (потоковое, без блокировки event loop;
   прогресс-события каждые 250 мс: %, байты, скорость (окно 2 с))
   ↓
Скачивание SHA256SUMS.txt из того же релиза → сверка SHA-256 EXE (§3.9).
   Не совпало → файл удалён, установленный EXE НЕ тронут, честная ошибка.
   Релиз без SHA256SUMS.txt → предупреждение в UI (не блокирует).
   ↓
Маркер userData/update-pending.json {expectedVersion, previousVersion, exePath, startedAt}
   ↓
cmd-скрипт (detached, %TEMP%): цикл «wait-exit» (tasklist по PID, до 120 с)
   → move /y new → EXE; fallback: ren старого → move нового → del старого
   → start EXE → self-delete. НИКАКИХ taskkill изнутри дерева (старый скрипт
   убивал сам себя: cmd.exe был потомком mainPid при taskkill /T).
   ↓
app.quit() — штатный выход; before-quit снимает дерево своих детей
   (aiWorker, nextServer) — установщик НЕ в списке и выживает.
   ↓
Новый EXE стартует → main при старте читает маркер: running == expectedVersion
   → «Обновлено успешно 1.0.15 → 1.0.16» (тост + баннер в диалоге, §3.12);
   иначе — «обновление НЕ завершилось» (честно).
```

## 2. Почему старая версия скачивала даже без обновления (root cause)

Методы `checkUpdate/installUpdate` находились в preload **внутри** объекта `ai`,
а UI вызывал их на верхнем уровне моста → `bridge.checkUpdate === undefined` →
кнопка всегда проваливалась в web-ветку (безусловное скачивание последнего EXE
со страницы релизов). Исправлено: методы перенесены на ВЕРХНИЙ уровень preload
и типа `AvcElectronBridge`; UI открывает диалог state-машины.

## 3. Как это делают профессиональные приложения

| Подход | electron-updater (NSIS) | AVC-Anime (portable) |
|---|---|---|
| Метаданные | latest.yml (version/sha512) | GitHub API releases/latest + SHA256SUMS.txt |
| Сравнение версий | semver | числовое [maj,min,patch] (схема 1.0.N CI) |
| Скачивание | провайдер GitHub, прогресс | потоковое https + прогресс/скорость |
| Целостность | sha512 из latest.yml | sha256 из SHA256SUMS.txt релиза |
| Установка | NSIS-инсталлятор (ждёт выход) | cmd: wait-exit → ren/move swap → start |
| Откат | reinstall | старый EXE восстанавливается при сбое move; маркер честно сообщает |

## 4. Гарантии целостности/безопасности

- Скачивается только asset с `https://github.com/HellShaftSam/AVC-AnimeVoiceCommand` (URL из releases/latest, не из рендерера).
- Установка запрещена при `relation !== 'newer'` — на уровне main, дважды.
- SHA-256 сверяется до подмены; частичный/битый файл не доходит до EXE.
- Подмена атомарна на уровне тома (`move`); при неудаче старый EXE восстанавливается.
- Модели/БД/сессия не затрагиваются (объединяются в userData, путь не меняется — §11).

## 5. Известные ограничения

- «После перезапуска» верификация опирается на маркер: если пользователь не дал
  приложению закрыться (120 с), установщик удаляет маркер и завершается —
  обновление не применяется (приложение продолжает работать, честная тишина).
- Прогресс скорости — скользящее окно 2 с (усреднение, не мгновенное).
- Релизы старее v1.0.17 не содержат SHA256SUMS.txt → для них верификация
  деградирует до предупреждения (в UI честно).
