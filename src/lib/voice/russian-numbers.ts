/**
 * RussianNumberParser — преобразование русских числительных в числа
 * (мастер-промпт #19). Поддержка 1..999, количественные и порядковые,
 * все роды ("первый/первая/первое/первую").
 */

const UNITS: Record<string, number> = {
  'один': 1, 'одна': 1, 'одну': 1, 'первый': 1, 'первая': 1, 'первое': 1, 'первую': 1,
  'два': 2, 'две': 2, 'второй': 2, 'вторая': 2, 'второе': 2, 'вторую': 2,
  'три': 3, 'третий': 3, 'третья': 3, 'третье': 3, 'третью': 3,
  'четыре': 4, 'четвертый': 4, 'четвёртый': 4, 'четвертая': 4, 'четвертую': 4,
  'пять': 5, 'пятый': 5, 'пятая': 5, 'пятое': 5, 'пятую': 5,
  'шесть': 6, 'шестой': 6, 'шестая': 6, 'шестую': 6,
  'семь': 7, 'седьмой': 7, 'седьмая': 7, 'седьмую': 7,
  'восемь': 8, 'восьмой': 8, 'восьмая': 8, 'восьмую': 8,
  'девять': 9, 'девятый': 9, 'девятая': 9, 'девятую': 9,
}

const TEENS: Record<string, number> = {
  'десять': 10, 'десятый': 10, 'десятая': 10, 'десятую': 10,
  'одиннадцать': 11, 'одиннадцатый': 11, 'одиннадцатая': 11, 'одиннадцатую': 11,
  'двенадцать': 12, 'двенадцатый': 12, 'двенадцатая': 12, 'двенадцатую': 12,
  'тринадцать': 13, 'тринадцатый': 13, 'тринадцатая': 13, 'тринадцатую': 13,
  'четырнадцать': 14, 'четырнадцатый': 14, 'четырнадцатая': 14, 'четырнадцатую': 14,
  'пятнадцать': 15, 'пятнадцатый': 15, 'пятнадцатая': 15, 'пятнадцатую': 15,
  'шестнадцать': 16, 'шестнадцатый': 16, 'шестнадцатая': 16, 'шестнадцатую': 16,
  'семнадцать': 17, 'семнадцатый': 17, 'семнадцатая': 17, 'семнадцатую': 17,
  'восемнадцать': 18, 'восемнадцатый': 18, 'восемнадцатая': 18, 'восемнадцатую': 18,
  'девятнадцать': 19, 'девятнадцатый': 19, 'девятнадцатая': 19, 'девятнадцатую': 19,
}

const TENS: Record<string, number> = {
  'двадцать': 20, 'тридцать': 30, 'сорок': 40,
  'пятьдесят': 50, 'шестьдесят': 60, 'семьдесят': 70,
  'восемьдесят': 80, 'девяносто': 90,
}

const HUNDREDS: Record<string, number> = {
  'сто': 100, 'двести': 200, 'триста': 300, 'четыреста': 400,
  'пятьсот': 500, 'шестьсот': 600, 'семьсот': 700, 'восемьсот': 800, 'девятьсот': 900,
}

const ALL_WORDS: Record<string, number> = { ...UNITS, ...TEENS, ...TENS, ...HUNDREDS }

/**
 * Распарсить строку как русское числительное.
 * Возвращает число или null.
 *
 *   "пять" -> 5
 *   "пятую" -> 5
 *   "21" -> 21
 *   "двадцать" -> 20
 *   "двадцать первая" -> 21
 *   "двадцать первую" -> 21
 *   "сто двадцать три" -> 123
 */
export function parseRussianNumber(text: string): number | null {
  const clean = text.trim().replace(/\s+/g, ' ')
  if (!clean) return null

  // чисто цифровой вариант
  if (/^\d{1,3}$/.test(clean)) return parseInt(clean, 10)

  const words = clean.split(' ').filter(Boolean)
  let total = 0
  let matched = 0

  for (const w of words) {
    const value = ALL_WORDS[w]
    if (value === undefined) return null // неизвестное слово — не число
    if (value >= 100) {
      total = (total === 0 ? 0 : total - (total % 100)) + value
      if (total < value) total = value
    } else if (value >= 10) {
      total = (Math.floor(total / 100) * 100) + value
    } else {
      total = (Math.floor(total / 100) * 100) + (Math.floor((total % 100) / 10) * 10) + value
    }
    matched++
  }

  if (matched === 0) return null
  return total
}

/**
 * Найти числительное в начале фразы.
 * Возвращает { value, restWords } или null.
 * Жадно собирает составные числительные ("двадцать первую серию" -> 21, rest=["серию"]).
 */
export function consumeLeadingNumber(words: string[]): { value: number; rest: string[] } | null {
  if (words.length === 0) return null

  // цифра в начале
  const digit = words[0].match(/^(\d{1,3})(-?[а-яе]+)?$/)
  if (digit) {
    return { value: parseInt(digit[1], 10), rest: words.slice(1) }
  }

  // собираем цепочку слов-числительных (максимум 4 слова: "девятьсот девяносто девять")
  const parts: string[] = []
  for (let i = 0; i < Math.min(4, words.length); i++) {
    if (ALL_WORDS[words[i]] === undefined) break
    parts.push(words[i])
  }
  if (parts.length === 0) return null

  const value = parseRussianNumber(parts.join(' '))
  if (value === null) return null
  return { value, rest: words.slice(parts.length) }
}

/** Все известные слова-числительные (для тестов/диагностики) */
export function knownNumberWords(): string[] {
  return Object.keys(ALL_WORDS)
}
