/**
 * VoiceCommandParser — ЛОКАЛЬНЫЙ, ДЕТЕРМИНИРОВАННЫЙ парсер русских команд
 * (мастер-промпт #83, #109). Без AI API: быстрый, локальный, предсказуемый.
 *
 * Пайплайн: RAW → normalize → stripFillers → сегментация ("и") →
 *           alias matching / извлечение параметров → VoiceCommand[]
 */
import { BrowserContext, VoiceCommand, VoiceCommandType } from '@/lib/avc/types'
import { COMMAND_ALIASES, COMMAND_ALIAS_PARAMS, OPEN_TRIGGERS, SEARCH_TRIGGERS } from './aliases'
import { normalizeCommandText, stripFillers } from './normalizer'
import { consumeLeadingNumber, knownNumberWords, parseRussianNumber } from './russian-numbers'

interface ParseCtx {
  navigation: BrowserContext['navigation']
  playback: BrowserContext['playback']
}

// --- вспомогательные -------------------------------------------------------

const EPISODE_NOUNS = ['серию', 'серия', 'серии', 'серую', 'эпизод', 'эпизода', 'эпизоде']
/** Множество слов-числительных (для разбора «наруто двадцать первую серию») */
const NUMBER_WORD_SET: ReadonlySet<string> = new Set(knownNumberWords())
const SECTION_WORDS: Record<string, VoiceCommandType> = {
  'главн': VoiceCommandType.OpenHome,
  'каталог': VoiceCommandType.OpenCatalog,
  'топ': VoiceCommandType.OpenTop100,
  'онгоинг': VoiceCommandType.OpenOngoing,
  'анонс': VoiceCommandType.OpenAnnouncements,
  'расписан': VoiceCommandType.OpenSchedule,
  'случайн': VoiceCommandType.OpenRandom,
  'рандом': VoiceCommandType.OpenRandom,
}

function hasEpisodeNoun(words: string[]): boolean {
  return words.some((w) => EPISODE_NOUNS.some((n) => w.startsWith(n.slice(0, 5))))
}

function isSectionWord(word: string): boolean {
  return Object.keys(SECTION_WORDS).some((s) => word.startsWith(s))
}

function sectionCommandFor(word: string): VoiceCommandType | null {
  for (const [prefix, cmd] of Object.entries(SECTION_WORDS)) {
    if (word.startsWith(prefix)) return cmd
  }
  return null
}

/** Точное/частичное совпадение с алиасами команд (params мержатся из COMMAND_ALIAS_PARAMS) */
function matchAlias(full: string): VoiceCommand | null {
  let best: { cmd: VoiceCommandType; score: number; alias: string } | null = null
  for (const [typeKey, aliases] of Object.entries(COMMAND_ALIASES)) {
    for (const alias of aliases) {
      const aliasLen = alias.split(' ').length
      let score = 0
      if (full === alias) score = 1
      else if (aliasLen >= 2 && full.includes(alias)) score = 0.8
      // односложные алиасы-глаголы ("включи") — только точное совпадение,
      // иначе "включи берсерка" стало бы Play
      if (score > 0 && (!best || score > best.score)) {
        best = { cmd: typeKey as VoiceCommandType, score, alias }
      }
    }
  }
  if (!best) return null
  const type = best.cmd
  const params = { ...(COMMAND_ALIAS_PARAMS[best.alias] ?? {}) }
  return {
    type,
    params,
    confidence: Math.min(0.98, 0.72 + best.score * 0.26),
    label: LABELS[type] ?? type,
  }
}

export const LABELS: Record<VoiceCommandType, string> = {
  [VoiceCommandType.OpenHome]: 'Открыть главную',
  [VoiceCommandType.OpenCatalog]: 'Открыть каталог',
  [VoiceCommandType.OpenTop100]: 'Открыть ТОП-100',
  [VoiceCommandType.OpenOngoing]: 'Открыть онгоинги',
  [VoiceCommandType.OpenAnnouncements]: 'Открыть анонсы',
  [VoiceCommandType.OpenSchedule]: 'Открыть расписание',
  [VoiceCommandType.OpenRandom]: 'Случайное аниме',
  [VoiceCommandType.SearchAnime]: 'Поиск аниме',
  [VoiceCommandType.OpenAnime]: 'Открыть аниме',
  [VoiceCommandType.SelectEpisode]: 'Выбрать серию',
  [VoiceCommandType.NextEpisode]: 'Следующая серия',
  [VoiceCommandType.PreviousEpisode]: 'Предыдущая серия',
  [VoiceCommandType.Play]: 'Воспроизведение',
  [VoiceCommandType.Pause]: 'Пауза',
  [VoiceCommandType.TogglePlayPause]: 'Play/Pause',
  [VoiceCommandType.SeekForward]: 'Перемотка вперёд',
  [VoiceCommandType.SeekBackward]: 'Перемотка назад',
  [VoiceCommandType.VolumeUp]: 'Громче',
  [VoiceCommandType.VolumeDown]: 'Тише',
  [VoiceCommandType.SetVolume]: 'Установить громкость',
  [VoiceCommandType.Fullscreen]: 'Полный экран',
  [VoiceCommandType.ExitFullscreen]: 'Выйти из полного экрана',
  [VoiceCommandType.ToggleFullscreen]: 'Полный экран (переключить)',
  [VoiceCommandType.OpenNewTab]: 'Новая вкладка',
  [VoiceCommandType.CloseTab]: 'Закрыть вкладку',
  [VoiceCommandType.NextTab]: 'Следующая вкладка',
  [VoiceCommandType.PreviousTab]: 'Предыдущая вкладка',
  [VoiceCommandType.SelectTab]: 'Выбрать вкладку',
  [VoiceCommandType.Reload]: 'Обновить',
  [VoiceCommandType.Back]: 'Назад',
  [VoiceCommandType.Forward]: 'Вперёд',
  [VoiceCommandType.ScrollUp]: 'Прокрутить вверх',
  [VoiceCommandType.ScrollDown]: 'Прокрутить вниз',
  [VoiceCommandType.SelectVoice]: 'Выбрать озвучку',
  [VoiceCommandType.ShowEpisodes]: 'Показать серии',
  [VoiceCommandType.ShowHelp]: 'Помощь',
  [VoiceCommandType.SelectOption]: 'Выбор варианта',
  // --- Task 8-b: контракты v2 ---
  [VoiceCommandType.Mute]: 'Выключить звук',
  [VoiceCommandType.Unmute]: 'Включить звук',
  [VoiceCommandType.SetWatchStatus]: 'Статус просмотра',
  [VoiceCommandType.ToggleFavorite]: 'Избранное',
  [VoiceCommandType.RateAnime]: 'Поставить оценку',
  [VoiceCommandType.RemoveRating]: 'Убрать оценку',
  [VoiceCommandType.ContinueWatching]: 'Продолжить просмотр',
  [VoiceCommandType.WhatAmIWatching]: 'Что я смотрю',
  [VoiceCommandType.ShowLibrary]: 'Открыть библиотеку YummyAnime',
  [VoiceCommandType.OpenProfile]: 'Открыть мой профиль',
  [VoiceCommandType.CheckAccount]: 'Проверить аккаунт',
  [VoiceCommandType.AccountLogout]: 'Выйти из аккаунта',
  [VoiceCommandType.AddVoiceAlias]: 'Добавить алиас озвучки',
  [VoiceCommandType.RemoveWatchStatus]: 'Убрать из списка',
  [VoiceCommandType.SkipSegment]: 'Пропустить опенинг/эндинг',
  [VoiceCommandType.UndoSkip]: 'Вернуться до пропуска',
  [VoiceCommandType.SetAutoSkip]: 'Настроить автопропуск',
  [VoiceCommandType.MarkSegment]: 'Запомнить таймкод',
  [VoiceCommandType.Unknown]: 'Не распознано',
}

// --- извлечение отдельных команд -------------------------------------------

/** Слова-единицы времени: секунды и минуты (Task 8-b: «на 2 минуты назад») */
const SEEK_NOUN_RE = /^(секунд|сек|секунды|секунду|секундочку|секундку|минут|мин|минуты|минуту|минуточку)/
const SEEK_VERBS = ['перемотай', 'перемотать', 'перемотка', 'отмотай', 'отмотать', 'отмотка', 'мотай', 'мотни']
const SEEK_BACK_WORDS = ['назад', 'обратно', 'влево']
const SEEK_FWD_WORDS = ['вперед', 'вправо']

/** Число из слова: цифры или русское числительное («тридцать», «сто») */
function parseSeekNumber(word: string): number | null {
  if (/^\d{1,3}$/.test(word)) return parseInt(word, 10)
  return parseRussianNumber(word)
}

/**
 * Перемотка (Task 8-b, расширенная):
 *   «перемотай на 20 секунд» / «вперед на десять секунд» / «назад на тридцать секунд»
 *   «перемотай на 2 минуты назад» → 120 сек, «полминуты назад» → 30, «полторы минуты» → 90
 *   «секунд 30» и «30 секунд», «на тридцать секунд», «сто двадцать секунд», «перемотка на 20»
 * Направление: назад/обратно/влево = назад; вперед/вправо = вперед;
 * «перемотай N сек» без направления = вперед. Без числа — шаг из настроек.
 */
function extractSeek(words: string[]): VoiceCommand | null {
  const isBackward = words.some((w) => SEEK_BACK_WORDS.includes(w))
  const hasVerb = words.some((w) => SEEK_VERBS.includes(w))
  const hasNoun = words.some((w) => SEEK_NOUN_RE.test(w))
  const hasFraction = words.some((w) => w.startsWith('полминут') || w === 'пол' || w === 'полу' || w === 'полторы' || w === 'полтора')
  // «перемотай вперед/назад» без секунд — тоже валидно (шаг из настроек);
  // «назад»/«вперед» БЕЗ глагола и единицы — это навигация, не seek
  if (!hasVerb && !hasNoun && !hasFraction) return null

  let seconds: number | null = null

  // доли: «полминуты» → 30, «пол минуты» → 30, «полторы минуты» → 90
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const next = words[i + 1] ?? ''
    if (w.startsWith('полминут')) seconds = Math.max(seconds ?? 0, 30)
    else if ((w === 'пол' || w === 'полу') && next.startsWith('минут')) seconds = Math.max(seconds ?? 0, 30)
    else if ((w === 'полторы' || w === 'полтора') && next.startsWith('мин')) seconds = Math.max(seconds ?? 0, 90)
  }

  // число рядом со словом-единицей: «30 секунд», «десять секунд», «на 2 минуты»,
  // «секунд 30», «сто двадцать секунд» (составное числительное цепочкой)
  for (let i = 0; i < words.length; i++) {
    if (!SEEK_NOUN_RE.test(words[i])) continue
    const mult = words[i].startsWith('мин') ? 60 : 1
    const chain: string[] = []
    for (let j = i - 1; j >= 0 && chain.length < 4; j--) {
      if (parseSeekNumber(words[j]) === null) break
      chain.unshift(words[j])
    }
    if (chain.length > 0) {
      const v = parseSeekNumber(chain.join(' '))
      if (v !== null) seconds = Math.max(seconds ?? 0, v * mult)
    } else if (words[i + 1]) {
      const v = parseSeekNumber(words[i + 1])
      if (v !== null) seconds = Math.max(seconds ?? 0, v * mult)
    }
  }

  // «перемотка на 20» — число после «на» без слова-единицы
  if (seconds === null && hasVerb) {
    const naIdx = words.indexOf('на')
    if (naIdx >= 0 && words[naIdx + 1]) {
      const v = parseSeekNumber(words[naIdx + 1])
      if (v !== null) seconds = v
    }
  }

  // seconds === null -> будет использован шаг из настроек (executor)
  return {
    type: isBackward ? VoiceCommandType.SeekBackward : VoiceCommandType.SeekForward,
    params: seconds ? { seconds } : {},
    confidence: seconds ? 0.92 : 0.85,
    label: isBackward ? 'Перемотка назад' : 'Перемотка вперёд',
  }
}

function extractVolume(words: string[]): VoiceCommand | null {
  const text = words.join(' ')
  const m = text.match(/громкость\s+(\d{1,3})/)
  if (m) {
    const vol = Math.min(100, parseInt(m[1], 10))
    return { type: VoiceCommandType.SetVolume, params: { volume: vol }, confidence: 0.95, label: `Громкость ${vol}%` }
  }
  // «громкость сто», «громкость пятьдесят» — числительные словами (STT отдаёт
  // слова, а не цифры; без этого фраза проваливалась в поиск аниме)
  const idx = words.indexOf('громкость')
  if (idx >= 0) {
    const rest = words.slice(idx + 1, idx + 4)
    for (let len = Math.min(3, rest.length); len >= 1; len--) {
      const value = parseRussianNumber(rest.slice(0, len).join(' '))
      if (value !== null && value >= 0 && value <= 100) {
        return { type: VoiceCommandType.SetVolume, params: { volume: value }, confidence: 0.95, label: `Громкость ${value}%` }
      }
    }
  }
  return null
}

function extractTabNumber(words: string[]): VoiceCommand | null {
  const text = words.join(' ')
  const m = text.match(/(?:вкладку|вкладка)\s+(\d{1,2})\b/)
  if (m) {
    const n = parseInt(m[1], 10)
    return { type: VoiceCommandType.SelectTab, params: { index: n }, confidence: 0.92, label: `Вкладка ${n}` }
  }
  // "перейди на третью вкладку" (числительное перед словом вкладка)
  const idx = words.findIndex((w) => w.startsWith('вкладк'))
  if (idx > 0) {
    const c = consumeLeadingNumber([words[idx - 1]])
    if (c) {
      return { type: VoiceCommandType.SelectTab, params: { index: c.value }, confidence: 0.9, label: `Вкладка ${c.value}` }
    }
  }
  // «вкладка один», «вкладку вторая» — числительное-слово ПОСЛЕ слова вкладка
  // (раньше не распознавалось и проваливалось в поиск аниме)
  if (idx >= 0 && idx + 1 < words.length) {
    const c = consumeLeadingNumber([words[idx + 1]])
    if (c) {
      return { type: VoiceCommandType.SelectTab, params: { index: c.value }, confidence: 0.92, label: `Вкладка ${c.value}` }
    }
  }
  return null
}

// --- новые команды контрактов v2 (Task 8-b) ---------------------------------

/** Звук: «выключи звук» / «убери звук» / «без звука» / «включи звук» / «верни звук» */
function extractSound(text: string): VoiceCommand | null {
  if (/(?:выключи|убери|отключи)\s+звук|без\s+звука|звука\s+нет/.test(text)) {
    return { type: VoiceCommandType.Mute, params: { muted: true }, confidence: 0.92, label: 'Выключить звук' }
  }
  if (/(?:включи|верни)\s+звук|со\s+звуком|верни\s+аудио/.test(text)) {
    return { type: VoiceCommandType.Unmute, params: { muted: false }, confidence: 0.92, label: 'Включить звук' }
  }
  return null
}

/** Статусы просмотра: смотрю / планы / просмотрено / брошено / отложено */
const WATCH_STATUS_PATTERNS: Array<{ re: RegExp; status: string }> = [
  { re: /(?:добавь|поставь|перемести|закинь|перенеси)\s+в\s+смотрю|^я\s+смотрю\s+это$/, status: 'watching' },
  { re: /(?:^|\s)(?:в|во)\s+планы|запланирован/, status: 'planned' },
  { re: /уже\s+посмотрел|^просмотрен[оое]$|отмет(?:ить|ь)?\s+как\s+просмотрен/, status: 'completed' },
  { re: /брошено|забросил|забрось|бросил\s+смотреть/, status: 'dropped' },
  { re: /отложен[оы]|отложить|на\s+потом/, status: 'on_hold' },
]

/**
 * Оценка 1..10 (шкала сайта — schema.org bestRating=10 + модалка rating-list):
 *   «оцени на 8» / «поставь оценку 8» / «моя оценка восемь» / «оценка 10»
 *   «поставь восемь» — БЕЗ слова-единицы (при открытом аниме) не ловим, чтобы
 *   не конфликтовать с сериями/громкостью — только с явным словом «оценк/оцени/рейтинг».
 */
function extractRating(text: string): VoiceCommand | null {
  if (!/(оценк|оцени|оценивание|рейтинг|шедевр|ничтожно)/.test(text)) return null
  if (/(?:убери|сними|удали|снять|убрать)\s+(?:мою\s+)?(?:оценку|рейтинг)/.test(text)) {
    return { type: VoiceCommandType.RemoveRating, params: {}, confidence: 0.92, label: 'Убрать оценку' }
  }
  // «оцени на 8» / «поставь оценку 8» / «оцениваю на десять» / «оценка восемь» / «рейтинг 7»
  const m =
    text.match(/(?:оцени|оценить|поставь)(?:\s+оценку)?\s+(?:на\s+)?(\d{1,2})\b/) ??
    text.match(/(?:моя|мою)\s+оценка\s*(?:—|за|на)?\s*(\d{1,2})\b/) ??
    text.match(/(?:оценка|рейтинг)\s*[:—-]?\s*(\d{1,2})\b/)
  if (m) {
    const n = parseInt(m[1], 10)
    if (n >= 1 && n <= 10) {
      return {
        type: VoiceCommandType.RateAnime,
        params: { rating: n },
        confidence: 0.92,
        label: `Оценка ${n} из 10`,
      }
    }
    return {
      type: VoiceCommandType.RateAnime,
      params: { rating: Math.min(10, Math.max(1, n)) },
      confidence: 0.6,
      label: `Оценка ${Math.min(10, Math.max(1, n))} из 10`,
    }
  }
  // числительные словами: «оцени на восемь», «оценка десять»
  const m2 = text.match(/(?:оцени|оценить|поставь)(?:\s+оценку)?\s+(?:на\s+)?([а-яё]+)\s*$/)
  if (m2) {
    const n = parseRussianNumber(m2[1])
    if (n !== null && n >= 1 && n <= 10) {
      return { type: VoiceCommandType.RateAnime, params: { rating: n }, confidence: 0.85, label: `Оценка ${n} из 10` }
    }
  }
  const m3 = text.match(/(?:оценка|рейтинг)\s+([а-яё]+)\s*$/)
  if (m3) {
    const n = parseRussianNumber(m3[1])
    if (n !== null && n >= 1 && n <= 10) {
      return { type: VoiceCommandType.RateAnime, params: { rating: n }, confidence: 0.85, label: `Оценка ${n} из 10` }
    }
  }
  return null
}

function extractWatchStatus(text: string): VoiceCommand | null {
  if (/(?:убери|удали|убрать)\s+(?:это\s+)?из\s+(?:моего\s+)?списка|убери\s+из\s+смотрю/.test(text)) {
    return { type: VoiceCommandType.RemoveWatchStatus, params: {}, confidence: 0.9, label: 'Убрать из списка' }
  }
  for (const { re, status } of WATCH_STATUS_PATTERNS) {
    if (re.test(text)) {
      return {
        type: VoiceCommandType.SetWatchStatus,
        params: { status },
        confidence: 0.9,
        label: `Статус: ${status}`,
      }
    }
  }
  return null
}

/** Избранное: «добавь в избранное» / «убери из избранного» */
function extractFavorite(text: string): VoiceCommand | null {
  if (/(?:убери|удали|убрать)\s+из\s+избранного/.test(text)) {
    return { type: VoiceCommandType.ToggleFavorite, params: { favorite: false }, confidence: 0.9, label: 'Убрать из избранного' }
  }
  if (/избранн|в\s+любимые|фаворит|в\s+любимое/.test(text)) {
    return { type: VoiceCommandType.ToggleFavorite, params: { favorite: true }, confidence: 0.9, label: 'В избранное' }
  }
  return null
}

/** «продолжить просмотр» — продолжение с сохранённой позиции */
function extractContinueWatching(text: string): VoiceCommand | null {
  if (/продолжи(?:ть)?\s+просмотр|продолж\s+с\s+того\s+места|с\s+того\s+(?:самого\s+)?места|вернись\s+к\s+просмотру|где\s+я\s+остановился/.test(text)) {
    return { type: VoiceCommandType.ContinueWatching, params: {}, confidence: 0.9, label: 'Продолжить просмотр' }
  }
  return null
}

// --- Skip Segments: пропуск опенинга/эндинга/рекапы ---------------------------

const OP_RE = /опенинг|опенинге|заставк|вступлен|интро/
const ED_RE = /эндинг|эндинге|титр|концовк|аутро/
const RECAP_RE = /рекап|пересказ/

/**
 * «пропусти опенинг/заставку/эндинг/титры/рекап». Без объекта («пропусти чуть»)
 * остаётся зоной существующей перемотки — сюда не попадает.
 */
function extractSkipSegment(text: string): VoiceCommand | null {
  if (!/(пропуст|скипн|перескочи)/.test(text)) return null
  let type = ''
  let label = ''
  if (OP_RE.test(text)) {
    type = 'op'
    label = 'Пропустить опенинг'
  } else if (ED_RE.test(text)) {
    type = 'ed'
    label = 'Пропустить эндинг'
  } else if (RECAP_RE.test(text)) {
    type = 'recap'
    label = 'Пропустить рекап'
  } else {
    return null
  }
  return { type: VoiceCommandType.SkipSegment, params: { type }, confidence: 0.92, label }
}

/** «отмени пропуск», «вернись к опенингу/к титрам/обратно» */
function extractUndoSkip(text: string): VoiceCommand | null {
  if (/отмен(?:и|ить|ите)?\s+(?:последний\s+)?пропуск/.test(text)) {
    return { type: VoiceCommandType.UndoSkip, params: {}, confidence: 0.92, label: 'Отменить пропуск' }
  }
  if (/верн(?:ись|итесь)\s+(?:обратно\s+)?(?:к\s+|на\s+)?(?:опенинг|заставк|эндинг|титр|начал)/.test(text)) {
    return { type: VoiceCommandType.UndoSkip, params: {}, confidence: 0.9, label: 'Отменить пропуск' }
  }
  return null
}

/** «включи/выключи автопропуск [опенинга/эндинга]» (без объекта — оба типа) */
function extractSetAutoSkip(text: string): VoiceCommand | null {
  if (!/автопропуск/.test(text)) return null
  const on = !/(выключ|отключ|убер|стоп)/.test(text)
  let type = ''
  if (OP_RE.test(text)) type = 'op'
  else if (ED_RE.test(text)) type = 'ed'
  return {
    type: VoiceCommandType.SetAutoSkip,
    params: { on, type },
    confidence: 0.9,
    label: on ? 'Автопропуск включён' : 'Автопропуск выключен',
  }
}

/**
 * «запомни начало/конец опенинга/эндинга», «это начало опенинга» — отметка
 * таймкода на месте (с дивана, во время просмотра).
 */
function extractMarkSegment(text: string): VoiceCommand | null {
  if (!/(запомн|отмет|сохран|^это\s)/.test(text)) return null
  const kind = /начал/.test(text) ? 'start' : /конец|кончи/.test(text) ? 'end' : null
  if (!kind) return null
  let type = ''
  if (OP_RE.test(text)) type = 'op'
  else if (ED_RE.test(text)) type = 'ed'
  else if (RECAP_RE.test(text)) type = 'recap'
  else return null
  const label = kind === 'start'
    ? `Отметка: начало ${type === 'op' ? 'опенинга' : type === 'ed' ? 'эндинга' : 'рекапы'}`
    : `Отметка: конец ${type === 'op' ? 'опенинга' : type === 'ed' ? 'эндинга' : 'рекапы'}`
  return { type: VoiceCommandType.MarkSegment, params: { markKind: kind, type }, confidence: 0.88, label }
}

/** «что я смотрю», «на какой серии я», «мой прогресс» — инфо по трекингу просмотра */
function extractWhatAmIWatching(text: string): VoiceCommand | null {
  if (/что\s+я\s+смотр|какое\s+аниме\s+я\s+смотр|на\s+какой\s+серии\s+я|мой\s+прогресс|прогресс\s+просмотра|какая\s+серия\s+была/.test(text)) {
    return { type: VoiceCommandType.WhatAmIWatching, params: {}, confidence: 0.9, label: 'Что я смотрю' }
  }
  return null
}

/** Библиотека: «открой библиотеку», «мои закладки», «мои списки», «мои аниме», «моя коллекция» */
function extractLibrary(text: string): VoiceCommand | null {
  if (/(?:открой|покажи|перейди\s+в)\s+библиотеку|^библиотека$|мои\s+списки|мои\s+аниме|моя\s+коллекция|мои\s+закладки|моё\s+избранное|мое\s+избранное/.test(text)) {
    return { type: VoiceCommandType.ShowLibrary, params: {}, confidence: 0.9, label: 'Библиотека YummyAnime' }
  }
  return null
}

/** «открой мой профиль» / «мой профиль» */
function extractOpenProfile(text: string): VoiceCommand | null {
  if (/(?:открой|покажи)?\s*(?:мой|мою)\s+профил|^мой\s+профил|перейди\s+в\s+профил/.test(text)) {
    return { type: VoiceCommandType.OpenProfile, params: {}, confidence: 0.9, label: 'Мой профиль на сайте' }
  }
  return null
}

/** «проверь аккаунт» / «я вошёл?» / «проверь вход» */
function extractCheckAccount(text: string): VoiceCommand | null {
  if (/проверь\s+(?:аккаунт|вход)|какой\s+аккаунт|я\s+вошёл|я\s+вошел|состояние\s+аккаунта/.test(text)) {
    return { type: VoiceCommandType.CheckAccount, params: {}, confidence: 0.9, label: 'Проверить аккаунт' }
  }
  return null
}

/** «выйди из аккаунта» / «разлогинься» */
function extractAccountLogout(text: string): VoiceCommand | null {
  if (/выйди\s+из\s+аккаунта|выйти\s+из\s+аккаунта|разлогинься/.test(text)) {
    return { type: VoiceCommandType.AccountLogout, params: {}, confidence: 0.85, label: 'Выйти из аккаунта' }
  }
  return null
}

/**
 * «добавь "X" как команду для Y» / «добавь X как алиас для Y» / «запомни X для Y».
 * Кавычки любые/отсутствуют (нормализатор их срезает).
 */
function extractAddVoiceAlias(text: string): VoiceCommand | null {
  const m =
    text.match(/(?:добавь|запомни)\s+(?:алиас\s+)?[«"']?(.+?)[»"']?\s+как\s+(?:команду|алиас|вариант)\s+для\s+(.+)/) ??
    text.match(/запомни\s+(?:алиас\s+)?[«"']?(.+?)[»"']?\s+для\s+(.+)/)
  if (!m) return null
  const alias = m[1].trim()
  const target = m[2].trim()
  if (!alias || !target) return null
  return {
    type: VoiceCommandType.AddVoiceAlias,
    params: { alias, target },
    confidence: 0.9,
    label: `Алиас «${alias}» → ${target}`,
  }
}

// --- озвучки -----------------------------------------------------------------

const DUB_WORD_RE = /^(озвуч|дубляж|перевод)/
/** Глаголы смены озвучки БЕЗ слова «озвучка» («переключи на анилибрию») */
const VOICE_SWITCH_VERBS = ['переключи', 'переключись', 'смени', 'поменяй', 'выбери']
/** Хвосты после «переключи на», которые НЕ являются названием озвучки */
const NOT_A_VOICE_TAIL = [
  'следующ', 'предыдущ', 'другую', 'другая', 'главн', 'вкладк', 'сери', 'эпизод',
  'первую', 'первый', 'вторую', 'второй', 'третью', 'третий', 'четверт',
  'пятую', 'шестую', 'седьмую', 'восьмую', 'девятую', 'десятую',
]

/**
 * SelectVoice — усиленное извлечение (Task 8-b; резолвинг имени делает executor):
 *   «озвучка anidub» / «включи озвучку дрим каст» / «смени озвучку на студиобенд» → {name}
 *   «переключи на анилибрию» / «переключись на дрим каст» → {name}
 *   «следующая озвучка» / «другая озвучка» → {next:true}
 *   «первая озвучка» / «вторая озвучка» / «включи третью озвучку» → {index:N}
 */
function extractSelectVoice(words: string[]): VoiceCommand | null {
  const text = words.join(' ')

  // 1) следующая / другая озвучка
  if (/(?:следующая|следующую|другая|другую|дальше)\s+озвуч/.test(text)) {
    return { type: VoiceCommandType.SelectVoice, params: { next: true }, confidence: 0.9, label: 'Следующая озвучка' }
  }

  const dubIdx = words.findIndex((w) => DUB_WORD_RE.test(w))

  // 2) порядковая озвучка: «вторая озвучка», «включи третью озвучку»
  if (dubIdx > 0) {
    const c = consumeLeadingNumber([words[dubIdx - 1]])
    if (c) {
      return { type: VoiceCommandType.SelectVoice, params: { index: c.value }, confidence: 0.9, label: `Озвучка №${c.value}` }
    }
  }

  // 3) название после слова «озвучка/дубляж/перевод»: «озвучка anidub»,
  //    «включи озвучку дрим каст», «смени озвучку на студиобенд»
  if (dubIdx >= 0 && dubIdx + 1 < words.length) {
    let tail = words.slice(dubIdx + 1)
    if (tail[0] === 'на' && tail.length > 1) tail = tail.slice(1)
    if (tail.length > 0 && tail.length <= 4) {
      const name = tail.join(' ')
      return { type: VoiceCommandType.SelectVoice, params: { name, dub: name }, confidence: 0.9, label: `Озвучка: ${name}` }
    }
  }

  // 4) «переключи на анилибрию» / «переключись на дрим каст» (без слова «озвучка»)
  for (const verb of VOICE_SWITCH_VERBS) {
    const idx = words.indexOf(verb)
    if (idx >= 0 && words[idx + 1] === 'на' && idx + 2 < words.length) {
      const tail = words.slice(idx + 2)
      if (tail.length > 4) continue
      if (tail.some((w) => NOT_A_VOICE_TAIL.some((b) => w.startsWith(b)))) return null
      if (tail.some((w) => isSectionWord(w))) continue
      const name = tail.join(' ')
      return { type: VoiceCommandType.SelectVoice, params: { name, dub: name }, confidence: 0.88, label: `Озвучка: ${name}` }
    }
  }

  return null
}

function extractSearch(words: string[]): VoiceCommand | null {
  const trigIdx = words.findIndex((w) => SEARCH_TRIGGERS.includes(w))
  if (trigIdx >= 0 && trigIdx + 1 < words.length) {
    const query = words.slice(trigIdx + 1).filter((w) => w !== 'аниме').join(' ').trim()
    if (query) {
      return { type: VoiceCommandType.SearchAnime, params: { query }, confidence: 0.95, label: `Найти «${query}»` }
    }
  }
  return null
}

/**
 * Открытие по названию: "открой берсерк" -> SearchAnime("берсерк", open=true).
 * Если после триггера идёт секция (топ/онгоинги...) — это навигация, не поиск.
 */
function extractOpen(words: string[]): VoiceCommand | null {
  const trigIdx = words.findIndex((w) => OPEN_TRIGGERS.includes(w))
  if (trigIdx < 0) return null

  const after = words.slice(trigIdx + 1)
  if (after.length === 0) return null

  // служебные секции уже обработаны алиасами; но на всякий случай:
  if (isSectionWord(after[0]) || after[0] === 'главную' || after[0] === 'вкладку' || after[0] === 'серию') {
    return null
  }

  // "открой берсерк и включи десятую серию" — сегментация выполнена выше,
  // здесь название — всё до конца сегмента
  // "открой берсерк в новой вкладке" -> SearchAnime(берсерк, newTab=true)
  let newTab = false
  let tail = [...after]
  if (tail.length >= 4 && tail.slice(-3).join(' ') === 'в новой вкладке') {
    newTab = true
    tail = tail.slice(0, -3)
  }
  const query = tail.filter((w) => w !== 'аниме').join(' ').trim()
  if (!query) return null
  return {
    type: VoiceCommandType.SearchAnime,
    params: { query, open: true, ...(newTab ? { newTab } : {}) },
    confidence: 0.85,
    label: `Открыть «${query}»`,
  }
}

/**
 * Число в КОНЦЕ цепочки слов + тайтл перед ним («наруто 1», «блич двадцать»).
 * Возвращает значение и слова тайтла; null — числа на конце нет (или тайтл пуст).
 */
function numberFromSuffix(
  words: string[],
): { value: number; titleWords: string[] } | null {
  if (words.length === 0) return null
  // чистая цифра на конце («наруто 1 …»; до 4 цифр — у длинных саг 1000+ серий)
  const last = words[words.length - 1]
  const digit = last.match(/^(\d{1,4})(-?[а-яе]+)?$/)
  if (digit) {
    const title = words.slice(0, -1)
    if (title.length === 0) return null
    return { value: parseInt(digit[1], 10), titleWords: title }
  }
  // цепочка слов-числительных на конце (до 4 слов: «двадцать первую»)
  for (let k = Math.min(4, words.length); k >= 1; k--) {
    const tail = words.slice(-k)
    if (tail.some((w) => !NUMBER_WORD_SET.has(w))) continue
    const v = parseRussianNumber(tail.join(' '))
    if (v !== null) {
      const title = words.slice(0, -k)
      if (title.length === 0) return null
      return { value: v, titleWords: title }
    }
  }
  return null
}

/**
 * Композит «<тайтл> <N> серия» — явный тайтл ПЕРЕД номером серии
 * («наруто 1 серия», «блич двадцать серию», «включи наруто шиппуден десятую»,
 * «наруто серия 1»).
 *
 * КРИТИЧНО (аудит, баг №2): слова перед числом — это тайтл, его НЕЛЬЗЯ
 * выбрасывать: SelectEpisode без тайтла играет серию ТЕКУЩЕГО аниме
 * (баг «Наруто 1 серия → продолжает Блич»). Исполнитель обязан сначала
 * резолвить тайтл и только затем выбирать серию внутри него (фаза 4.3).
 */
function extractTitleEpisode(words: string[]): VoiceCommand | null {
  // срезаем ведущий триггер, в т.ч. многословный («хочу посмотреть ван пис 1 серию»)
  // и хвостовые глаголы после filler-стрипа («посмотреть …»)
  let rest = [...words]
  for (let i = 0; i < 2 && rest.length > 0; i++) {
    if (OPEN_TRIGGERS.includes(rest.slice(0, 2).join(' '))) rest = rest.slice(2)
    else if (
      OPEN_TRIGGERS.includes(rest[0]) ||
      rest[0] === 'посмотреть' ||
      rest[0] === 'смотреть'
    ) {
      rest = rest.slice(1)
    } else {
      break
    }
  }
  if (rest.length < 2) return null

  const nounIdx = rest.findIndex((w) =>
    EPISODE_NOUNS.some((n) => w.startsWith(n.slice(0, 5))),
  )
  if (nounIdx < 0) return null

  let titleWords: string[] = []
  let episode: number | null = null

  if (nounIdx >= 1) {
    // Вариант A: число ПЕРЕД существительным («наруто 1 серия»)
    const fromSuffix = numberFromSuffix(rest.slice(0, nounIdx))
    if (fromSuffix) {
      episode = fromSuffix.value
      titleWords = fromSuffix.titleWords
    }
  }
  if (episode === null && nounIdx >= 1) {
    // Вариант B: число ПОСЛЕ существительного («наруто серия 1»)
    const after = rest.slice(nounIdx + 1)
    const leading = consumeLeadingNumber(after)
    if (leading && leading.rest.length === 0) {
      episode = leading.value
      titleWords = rest.slice(0, nounIdx)
    }
  }
  if (episode === null || titleWords.length === 0) return null

  // чистим тайтл от служебных слов
  const title = titleWords
    .filter((w) => !EPISODE_NOUNS.some((n) => w.startsWith(n.slice(0, 5))))
    .filter((w) => w !== 'аниме')
    .join(' ')
    .trim()
  if (!title) return null
  // секции («топ 5 серию»?) — не тайтлы; озвучки обрабатываются раньше парсера тайтла
  if (isSectionWord(titleWords[0])) return null

  return {
    type: VoiceCommandType.SearchAnime,
    params: { query: title, open: true, episode },
    confidence: 0.9,
    label: `«${title}» — серия ${episode}`,
  }
}

function extractEpisodeSelect(words: string[], ctx: ParseCtx): VoiceCommand | null {
  // паттерн 1: "серию 5", "серия 12", "открой серию 15"
  const joined = words.join(' ')
  const m = joined.match(/(?:сери[ауюя]|эпизод[ау]?)\s+(\d{1,3})\b/)
  if (m) {
    const n = parseInt(m[1], 10)
    return { type: VoiceCommandType.SelectEpisode, params: { episode: n }, confidence: 0.96, label: `Серия ${n}` }
  }
  const m2 = joined.match(/^(\d{1,3})\s+(?:сери[ауюя]|эпизод[ау]?)/)
  if (m2) {
    const n = parseInt(m2[1], 10)
    return { type: VoiceCommandType.SelectEpisode, params: { episode: n }, confidence: 0.95, label: `Серия ${n}` }
  }

  // паттерн 2: глагол + числительное + "серию" ("включи пятую серию")
  const trigIdx = words.findIndex((w) => OPEN_TRIGGERS.includes(w))
  const after = trigIdx >= 0 ? words.slice(trigIdx + 1) : words
  if (hasEpisodeNoun(after)) {
    // первое числительное в after
    for (let i = 0; i < after.length; i++) {
      const c = consumeLeadingNumber(after.slice(i))
      if (c) {
        return { type: VoiceCommandType.SelectEpisode, params: { episode: c.value }, confidence: 0.93, label: `Серия ${c.value}` }
      }
    }
  }

  // паттерн 3 (контекст): bare числительное при просмотре ("двадцать", "пятая",
  // "открой двадцать первую" при открытом аниме)
  const watching = ctx.playback.animeTitle !== null
  const picking = ctx.navigation.pickingFromList
  if (watching || picking) {
    let bare = [...words]
    const trigIdx = bare.findIndex((w) => OPEN_TRIGGERS.includes(w))
    if (trigIdx === 0) bare = bare.slice(1)
    if (bare.length >= 1 && bare.length <= 3) {
      const c = consumeLeadingNumber(bare)
      if (c && c.rest.length === 0) {
        return {
          type: picking ? VoiceCommandType.SelectOption : VoiceCommandType.SelectEpisode,
          params: { [picking ? 'index' : 'episode']: c.value },
          confidence: 0.8,
          label: picking ? `Вариант ${c.value}` : `Серия ${c.value}`,
        }
      }
    }
  }
  return null
}

function extractContextual(words: string[], ctx: ParseCtx): VoiceCommand | null {
  const text = words.join(' ')
  const watchingVideo = ctx.playback.animeTitle !== null

  // "назад": в контексте видео -> предыдущая серия, иначе -> история назад
  if (text === 'назад') {
    if (watchingVideo) {
      return { type: VoiceCommandType.PreviousEpisode, params: {}, confidence: 0.75, label: 'Предыдущая серия (контекст)' }
    }
    return { type: VoiceCommandType.Back, params: {}, confidence: 0.85, label: 'Назад' }
  }
  return null
}

// --- основной парсер --------------------------------------------------------

/** Разбить фразу на сегменты по " и " (только когда обе части осмысленны) */
function splitCombined(normalized: string): string[] {
  const rough = normalized.split(/ и | и\b/).map((s) => s.trim()).filter(Boolean)
  if (rough.length <= 1) return [normalized]
  // принимаем разбиение, только если каждый сегмент начинается с триггера
  // или является известной командой
  return rough
}

function parseSegment(segment: string, ctx: ParseCtx): VoiceCommand | null {
  const words = segment.split(' ').filter(Boolean)
  if (words.length === 0) return null
  const text = words.join(' ')

  // 0. Новые команды контрактов v2 (Task 8-b) — специфичнее alias-matching
  const addAlias = extractAddVoiceAlias(text)
  if (addAlias) return addAlias

  const sound = extractSound(text)
  if (sound) return sound

  const cont = extractContinueWatching(text)
  if (cont) return cont

  // Skip Segments: «пропусти опенинг», «отмени пропуск», «включи автопропуск»,
  // «запомни начало опенинга» — ДО extractSeek («вернись» конфликтует с перемоткой)
  const skip = extractSkipSegment(text)
  if (skip) return skip

  const undo = extractUndoSkip(text)
  if (undo) return undo

  const autoskip = extractSetAutoSkip(text)
  if (autoskip) return autoskip

  const mark = extractMarkSegment(text)
  if (mark) return mark

  const watching = extractWhatAmIWatching(text)
  if (watching) return watching

  const status = extractWatchStatus(text)
  if (status) return status

  const rate = extractRating(text)
  if (rate) return rate

  const fav = extractFavorite(text)
  if (fav) return fav

  const lib = extractLibrary(text)
  if (lib) return lib

  const prof = extractOpenProfile(text)
  if (prof) return prof

  const chk = extractCheckAccount(text)
  if (chk) return chk

  const logout = extractAccountLogout(text)
  if (logout) return logout

  // 1. Озвучка: "озвучка anidub", "переключи на анилибрию", "следующая озвучка"
  const dub = extractSelectVoice(words)
  if (dub) return dub

  // 2. Громкость N
  const volume = extractVolume(words)
  if (volume) return volume

  // 3. Вкладка по номеру
  const tabNum = extractTabNumber(words)
  if (tabNum) return tabNum

  // 4. Поиск: "найди берсерк"
  const search = extractSearch(words)
  if (search) return search

  // 5. Перемотка: "вперед на десять секунд"
  const seek = extractSeek(words)
  if (seek) return seek

  // 5.5. КОМПОЗИТ «тайтл + серия» — ДО выбора серии в текущем контексте:
  //      явное название всегда сильнее текущего аниме (фаза 4.3)
  const titleEpisode = extractTitleEpisode(words)
  if (titleEpisode) return titleEpisode

  // 6. Выбор серии
  const episode = extractEpisodeSelect(words, ctx)
  if (episode) return episode

  // 7. Алиасы простых команд (после специализированных извлечений,
  //     чтобы "включи пятую серию" не стало Play)
  const alias = matchAlias(segment)
  if (alias) return alias

  // 8. Контекстные ("назад")
  const contextual = extractContextual(words, ctx)
  if (contextual) return contextual

  // 9. Открытие по названию: "открой берсерк"
  const open = extractOpen(words)
  if (open) return open

  // 10. ГОЛЫЙ ТАЙТЛ: «наруто» — валидный поисковый/навигационный интент,
  //     а не «неизвестная команда» (фаза 4.2). Последний шаг: без триггеров,
  //     без секций/серий/чистых чисел; иначе честный поиск → «не найдено».
  const hasTriggers = words.some(
    (w) => OPEN_TRIGGERS.includes(w) || SEARCH_TRIGGERS.includes(w),
  )
  if (
    !hasTriggers &&
    words.length >= 1 &&
    words.length <= 6 &&
    !isSectionWord(words[0]) &&
    !words.some((w) => EPISODE_NOUNS.some((n) => w.startsWith(n.slice(0, 5)))) &&
    words.every((w) => !/^\d+$/.test(w))
  ) {
    const query = words.join(' ').trim()
    // Мусорный запрос: голосовой движок на дальнем микрофоне выдаёт обрывки
    // («гу», «то», «на»), повторы слогов («на на на на») и наборы огрызков
    // («какая ка кака»). Голый поиск по ним только мусорит историю и открывает
    // случайные тайтлы — требуем осмысленный запрос.
    if (query.length >= 3 && !isJunkQuery(words)) {
      return {
        type: VoiceCommandType.SearchAnime,
        params: { query, open: true },
        confidence: 0.7,
        label: `Открыть «${query}»`,
      }
    }
  }

  return null
}

/** Похоже ли слово на обрывок/слог (1–2 буквы): «на», «то», «ка», «гу» */
function isShortFillerWord(w: string): boolean {
  return w.length <= 2
}

/**
 * Мусорная фраза = маловероятное название аниме: повторы одного слова,
 * преобладание слогов-обрывков, суммарно меньше 5 значимых букв.
 * «наруто», «блич», «ван пис» — проходят; «на на на», «какая ка кака», «стой» — нет.
 */
function isJunkQuery(words: string[]): boolean {
  if (words.length === 0) return true
  const distinct = new Set(words)
  // одно слово, повторённое несколько раз подряд — распознавательный мусор
  if (distinct.size === 1 && words.length >= 2) return true
  // 3+ слов из 1–2 различных — «на наруто наруто», «да да то»
  if (distinct.size <= 2 && words.length >= 3) return true
  const fillers = words.filter(isShortFillerWord).length
  // почти вся фраза из обрывков: «какая ка кака» (2 из 3 — по сути слоги)
  if (fillers >= Math.max(2, words.length - 1)) return true
  // суммарно значимых букв меньше 5: «стой», «как», «гу то»
  const meaningful = words.filter((w) => w.length >= 3).join('')
  if (meaningful.length < 5) return true
  return false
}

export interface ParseResult {
  normalized: string
  commands: VoiceCommand[]
  /** Средняя уверенность */
  confidence: number
  /** Не удалось распознать */
  failed: boolean
}

export function parseCommand(rawText: string, context: BrowserContext): ParseResult {
  const normalized = normalizeCommandText(rawText)
  const stripped = stripFillers(normalized)

  // wake word: "аниме, следующая серия" -> срезаем wake word
  let text = stripped
  const wake = 'аниме'
  if (text.startsWith(wake + ' ') && text !== wake) {
    text = text.slice(wake.length + 1).trim()
  }

  const ctx: ParseCtx = {
    navigation: context.navigation,
    playback: context.playback,
  }

  const segments = splitCombined(text)
  const commands: VoiceCommand[] = []

  for (const seg of segments) {
    const cmd = parseSegment(seg, ctx)
    if (cmd) commands.push(cmd)
  }

  // "пауза" — точный короткий случай, alias matching уже ловит.
  // Если ничего не распознано — Unknown
  if (commands.length === 0) {
    return { normalized, commands: [], confidence: 0, failed: true }
  }

  const avg = commands.reduce((s, c) => s + c.confidence, 0) / commands.length
  return { normalized, commands, confidence: avg, failed: false }
}

/** Тестовая таблица для debug-панели (#85, расширена в Task 8-b) */
export function parserSelfTest(): Array<{ input: string; expect: string }> {
  return [
    { input: 'следующая серия', expect: 'NextEpisode' },
    { input: 'включи следующую', expect: 'NextEpisode' },
    { input: 'предыдущая серия', expect: 'PreviousEpisode' },
    { input: 'включи пятую серию', expect: 'SelectEpisode(5)' },
    { input: 'двадцать первая', expect: 'SelectEpisode(21)' },
    { input: 'серия 5', expect: 'SelectEpisode(5)' },
    { input: 'открой топ сто', expect: 'OpenTop100' },
    { input: 'покажи онгоинги', expect: 'OpenOngoing' },
    { input: 'найди берсерк', expect: 'SearchAnime(берсерк)' },
    { input: 'открой берсерк', expect: 'SearchAnime(берсерк, open)' },
    { input: 'пауза', expect: 'Pause' },
    { input: 'поставь на паузу', expect: 'Pause' },
    { input: 'громче', expect: 'VolumeUp' },
    { input: 'громкость 50', expect: 'SetVolume(50)' },
    { input: 'вперед на десять секунд', expect: 'SeekForward(10)' },
    { input: 'назад на тридцать секунд', expect: 'SeekBackward(30)' },
    { input: 'полный экран', expect: 'Fullscreen' },
    { input: 'новая вкладка', expect: 'OpenNewTab' },
    { input: 'открой случайное', expect: 'OpenRandom' },
    { input: 'расписание', expect: 'OpenSchedule' },
    { input: 'анонсы', expect: 'OpenAnnouncements' },
    // --- Task 8-b ---
    { input: 'переключи на анилибрию', expect: 'SelectVoice(анилибрию)' },
    { input: 'включи озвучку дрим каст', expect: 'SelectVoice(дрим каст)' },
    { input: 'следующая озвучка', expect: 'SelectVoice(next)' },
    { input: 'вторая озвучка', expect: 'SelectVoice(index:2)' },
    { input: 'перемотай на 20 секунд', expect: 'SeekForward(20)' },
    { input: 'перемотай на 2 минуты назад', expect: 'SeekBackward(120)' },
    { input: 'полторы минуты назад', expect: 'SeekBackward(90)' },
    { input: 'перемотка на 20', expect: 'SeekForward(20)' },
    { input: 'выключи звук', expect: 'Mute' },
    { input: 'включи звук', expect: 'Unmute' },
    { input: 'добавь в смотрю', expect: 'SetWatchStatus(watching)' },
    { input: 'добавь в планы', expect: 'SetWatchStatus(planned)' },
    { input: 'просмотрено', expect: 'SetWatchStatus(completed)' },
    { input: 'отложено', expect: 'SetWatchStatus(on_hold)' },
    { input: 'добавь в избранное', expect: 'ToggleFavorite(true)' },
    { input: 'убери из избранного', expect: 'ToggleFavorite(false)' },
    { input: 'оцени на 8', expect: 'RateAnime(8)' },
    { input: 'поставь оценку десять', expect: 'RateAnime(10)' },
    { input: 'оценка 3', expect: 'RateAnime(3)' },
    { input: 'убери оценку', expect: 'RemoveRating' },
    { input: 'продолжить просмотр', expect: 'ContinueWatching' },
    { input: 'открой библиотеку', expect: 'ShowLibrary' },
    { input: 'добавь ани либрия как команду для anilibria', expect: 'AddVoiceAlias(ани либрия->anilibria)' },
  ]
}
