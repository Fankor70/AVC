# Task 9-a — Agent ZAI (voice-controller-integrator)

Task ID: 9-a
Agent: ZAI (main)
Дата: интеграционный слой аккаунта/библиотеки/алиасов + хоткеи + дебаунсер

## Скоуп (только эти файлы)
- src/lib/avc/store.ts (расширен)
- src/lib/avc/executor.ts (основной файл задачи)
- src/lib/avc/api.ts (НОВЫЙ)
- src/components/avc/hotkeys.tsx (НОВЫЙ)
- src/app/page.tsx (профиль + монтирование)
- worklog.md (append)

Файлы 9-b НЕ трогал (auth-dialog / library-panel / voice-confirm-dialog / install-pwa созданы параллельно; импорты в page.tsx сверены с фактическими экспортами).

## store.ts — добавлено
- Поля: `user: UserInfoDto | null`, `library: LibraryEntryDto[]`, `voiceAliases: VoiceAliasRow[]`, `libraryOpen`, `authOpen`, `voiceConfirm: { spoken; match: VoiceProviderMatch } | null`, `prevVolume: number` (init 70)
- Действия: setUser / setLibrary / setVoiceAliases / setLibraryOpen / setAuthOpen / setVoiceConfirm + дополнительный `setPrevVolume` (нужен executor'у для Mute; контракта 9-b не ломает)
- Экспортирован тип `VoiceConfirmState`

## api.ts — контракт
- `avcApi`: me / login (401 → throw «Неверный логин или пароль») / register / logout / library / putLibrary (**401 → null, НЕ throw**; 400 → throw от {error}) / deleteLibraryEntry / aliases (без сессии → []) / addAlias (401 → null) / deleteAlias
- credentials same-origin, JSON; ошибки → `throw Error(сообщение из {error})`; чистый транспорт — store обновляет вызывающая сторона

## executor.ts — изменения
1. **Дебаунсер (баг #12)**: module-level `{hash, ts}`; в executeText после парсинга: тот же normalized-текст < 2500 мс → RESULT «Дубликат команды пропущен» + setLastExecuted + return. ts обновляют и успешные, и проваленные выполнения → «пауза пауза» подряд глушится, с интервалом > 2.5 с работает
2. **Confirm-gate ДО парсинга**: если store.voiceConfirm: «да/да переключай/подтверждаю/точно/давай/первый/1» → confirmVoiceMatch(); «нет/отмена/не/неа/неверно/второй/2» → cancelVoiceMatch(); ЛЮБОЙ другой текст → cancel + обычный парсинг (диалог не застревает). Нормализация фраз — simpleNormalize (пунктуация → пробелы)
3. **SelectVoice через резолвер 8-b**: {next:true} — циклический сдвиг по details.dubs; {index:N} — N-я в списке; {name|dub} → resolveVoiceProvider(spoken, dubs, buildUserAliasMap(voiceAliases), VOICE_CONFIDENCE_ASK): null → «Озвучка «X» не найдена. Доступны: …»; ≥ AUTO (0.85) → применить сразу + «Озвучка: X (N%)»; 0.55–0.85 → setVoiceConfirm({spoken, match}) + «Вы имеете в виду…? Скажите ДА или НЕТ»
4. **Экспорты**: `confirmVoiceMatch()` (pickVideo по match.name, чистит voiceConfirm, toast+сообщение), `cancelVoiceMatch()` (чистит, «Отменено»)
5. **Mute/Unmute**: prevVolume = volume>0 ? volume : prevVolume; Unmute → prevVolume>0 ? prevVolume : 70
6. **SetWatchStatus**: без user → setAuthOpen(true) + «Войдите в аккаунт…»; без playback.animeId → «Сначала откройте аниме»; иначе putLibrary (poster/totalEpisodes из getCachedDetails) → upsert в store.library → «{title}: {WATCH_STATUS_LABELS[status]}»
7. **ToggleFavorite**: как #6 по favorite; без параметра — честный toggle текущего состояния записи; статус НЕ перетирается (partial update)
8. **ContinueWatching**: максимальный updatedAt среди status==='watching' (fallback любые); пусто → «Библиотека пуста — скажи "найди …"…»; иначе **`export async function continueWatchingFromEntry(entry)`** — конструирует AnimeCard, переиспользует navigateToAnime, восстанавливает currentDub → playEpisode(entry.episode) → positionSec. Минимальное сообщение «Продолжаю: X, серия N»
9. **ShowLibrary**: setLibraryOpen(true) + «Библиотека открыта»
10. **AddVoiceAlias {alias, target}**: target резолвится по dubs текущего аниме, fallback — кандидаты из ключей DEFAULT_VOICE_ALIASES; < 0.55 → «Не знаю такую озвучку»; 401 → null → «Войдите, чтобы сохранять алиасы» + setAuthOpen(true); успех → voiceAliases upsert + «Запомнил: "X" → Y»
11. **Автосинк библиотеки**: в playEpisode (покрывает SelectEpisode/Next/Prev/Play-автостарт) — syncLibraryProgress(details) fire-and-forget, status:'watching' ТОЛЬКО при создании записи (completed/dropped не перетираются); executeSeek — positionSec только если запись уже есть; ошибки глушатся
12. Switch покрывает все новые типы; default → «Команда не поддерживается» (LABELS 8-b проверены)

## hotkeys.tsx (НОВЫЙ)
`<Hotkeys /> → null`; window keydown capture; игнор input/textarea/select/contenteditable и Ctrl/Meta (Ctrl+Space PTT в page.tsx не задет); Space=TogglePlayPause (preventDefault), ←/→ = Seek±(Shift?30:10), ↑/↓ = Volume±, N/P = Next/PrevEpisode, F = setPlayerFullscreen(!…) напрямую через getState(), M = Mute/Unmute по volume>0. Всё через executeCommand (pipeline/history/tosts как у голоса). e.repeat разрешён только стрелкам (hold-to-seek)

## page.tsx
- Импорты AuthDialog / LibraryPanel / VoiceConfirmDialog / Hotkeys + InstallPwa
- Эффект профиля: avcApi.me() → setUser; если user → Promise.all(library, aliases) → setLibrary/setVoiceAliases; отмена по unmount, ошибки глушатся
- Смонтированы <VoiceConfirmDialog /> <AuthDialog /> <LibraryPanel /> <InstallPwa /> <Hotkeys />
- Settings load / Ctrl+Space / автосейв сессии не тронуты

## Отклонение от ТЗ (1)
Контракт называл `InstallPwaHint`, но фактически созданный 9-b файл экспортирует `InstallPwa` — импорт выровнен по факту (иначе tsc TS2724).

## Проверки
- `bunx tsc --noEmit`: в src/ — 0 ошибок (в т.ч. совместно с файлами 9-b; остаются только предсуществующие examples/ и skills/)
- `bunx eslint` по 5 своим файлам — 0 ошибок/предупреждений
- dev.log: GET / → 200; /api/auth/me → {"user":null}; /api/library → {"user":null,"entries":[]}; /api/aliases → {"aliases":[]}
- Ментальные кейсы: разные команды дебаунсер не блокирует (hash по тексту); «переключи на анилибрию» → alias 0.97 ≥ AUTO → молча; misspell 0.55–0.85 → «да» применяет, «нет» отмена, посторонний текст — отмена+парсинг; SetWatchStatus без логина открывает auth-dialog
