/**
 * Fuzzy matching для нечёткого поиска аниме и озвучек (мастер-промпт #15).
 * Levenshtein distance + нормализация + сравнение по токенам.
 * Task 8-b: добавлено сравнение фонетических ключей (транслит) —
 * «ани либрия» и «AniLibria» дают близкие ключи 'anilibriya'/'anilibria'.
 */
import { phoneticKey } from './phonetics'

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  const prev = new Array<number>(b.length + 1)
  const curr = new Array<number>(b.length + 1)

  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]
  }
  return prev[b.length]
}

/** Похожесть 0..1 */
export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - levenshtein(a, b) / maxLen
}

/** Нормализация строки для сопоставления: нижний регистр, без пунктуации, ё=е */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Сравнение запроса с названием. Учитывает вхождение токенов:
 * "стальной алхимик" vs "Стальной алхимик: Братство" -> высокая похожесть.
 */
export function titleSimilarity(query: string, title: string): number {
  const q = normalizeForMatch(query)
  const t = normalizeForMatch(title)
  if (!q || !t) return 0
  if (q === t) return 1

  // прямая похожесть строк
  const direct = similarity(q, t)

  // вхождение подстроки
  const contains = t.includes(q) || q.includes(t) ? 0.85 : 0

  // пересечение токенов (Jaccard с весом)
  const qTokens = new Set(q.split(' '))
  const tTokens = new Set(t.split(' '))
  let inter = 0
  for (const tok of qTokens) {
    if (tTokens.has(tok)) inter++
    else {
      // частичное совпадение длинных токенов (опечатки)
      for (const tt of tTokens) {
        if (tok.length >= 5 && tt.length >= 5 && similarity(tok, tt) >= 0.8) {
          inter += 0.7
          break
        }
      }
    }
  }
  const jaccard = inter / Math.max(qTokens.size, tTokens.size)

  // фонетическое сравнение (транслит): «анилибрия» ~ «AniLibria»
  let phonetic = 0
  const qPh = phoneticKey(q)
  const tPh = phoneticKey(t)
  if (qPh && tPh) {
    if (qPh === tPh) phonetic = 0.92
    else phonetic = similarity(qPh, tPh)
  }

  return Math.max(direct, contains, jaccard, phonetic)
}

export interface FuzzyMatch<T> {
  item: T
  score: number
}

/** Лучшие совпадения из списка, отсортированные по убыванию похожести */
export function rankMatches<T>(
  query: string,
  items: T[],
  getTitle: (item: T) => string,
  minScore = 0.35,
): FuzzyMatch<T>[] {
  return items
    .map((item) => ({ item, score: titleSimilarity(query, getTitle(item)) }))
    .filter((m) => m.score >= minScore)
    .sort((a, b) => b.score - a.score)
}
