# PROCESS_LIFECYCLE_AUDIT — AVC-Anime (Windows)

## 1. Реестр процессов, создаваемых приложением

| Процесс | Кто создаёт | Тип | Lifetime | Очистка |
|---|---|---|---|---|
| AVC-Anime.exe (Electron main) | пользователь | корень | сеанс | штатный app.quit() |
| Renderer / GPU / utility процессы Electron | Chromium | внутренние | сеанс | умирают вместе с main |
| Next.js standalone-сервер (`nextProcess`) | spawn ELECTRON_RUN_AS_NODE | ребёнок main | сеанс | killProcessTree (taskkill /T /F) в before-quit + will-quit |
| AI-воркер node.exe (`aiWorker`) | child_process.fork (execPath=runtime-node/node.exe) | ребёнок main | сеанс | killProcessTree в before-quit + will-quit; app.isQuitting предотвращает автоперезапуск |
| Скрытое session-окно / окно логина | AuthenticationService | BrowserWindow | сеанс/вход | authService.shutdown() в before-quit (destroy) |
| Splash / fatal окна | main | BrowserWindow | старт/ошибка | destroy() по назначению |
| `taskkill` хелперы | killProcessTree | внучатые | секунды | stdio ignore + unref; завершаются сами |
| Установщик обновления `cmd.exe` (update-avc.cmd) | обновлятор | detached-ребёнок main | минуты (после выхода!) | self-delete; НЕ убивается деревом — см. §2 |

## 2. Ключевой риск устранён (v1.0.17)

Старый `update-avc.cmd` выполнял `taskkill /f /pid <mainPid> /T`, находясь САМ
в этом дереве (cmd.exe — потомок mainPid): дерево-килл гонялся за собственным
интерпретатором → гонка: подмена/перезапуск могли не выполниться, а приложение
гасло без возврата. Новая схема: приложение закрывается ШТАТНО (app.quit();
before-quit снимает только своих детей), установщик лишь ЖДЁТ исчезновения PID
(tasklist, до 120 с), затем подменяет EXE и стартует новый. Установщик не
входит ни в один kill-список.

## 3. Порядок штатного закрытия (before-quit)

```
window close / Alt+F4 / меню → window-all-closed → app.quit()
   ↓ before-quit
app.isQuitting = true            (AI-воркер не перезапускается сам)
authService.shutdown()           (destroy login/session окон)
killProcessTree(aiWorker)        (taskkill /T /F — дерево node-воркера)
killProcessTree(nextProcess)     (taskkill /T /F — дерево Next-сервера)
   ↓ will-quit (страховка)
повторный killProcessTree обоих, если что-то пережило before-quit
   ↓ выход Electron
GPU/utility/рендереры умирают вместе с main (гарантия Chromium)
```

Обновлятор идёт по той же цепочке: install → spawn cmd (detached) → app.quit()
→ эта же очистка → cmd дожидается исчезновения PID → swap → старт нового.

## 4. Известные границы

- Жёсткий kill процесса (например, из Диспетчера задач) не запускает before-quit:
  детей добивает только новый запуск через single-instance lock (второй экземпляр
  сообщает о первом) либо предыдущий taskkill уже выполнен. Гарантий на
  мгновенный kill процесса-корня нет ни у одного приложения — задокументировано.
- Если app.quit() зависает >120 с, установщик обновления удаляет маркер и
  выходит, НЕ трогая файлы (работающее приложение не повреждается).
