/**
 * Voice Provider Resolver (Task 8-b) — сопоставление ПРОИЗНЕСЁННОГО названия
 * озвучки с тем, как оно хранится на сайте.
 *
 * Проблема: Whisper распознаёт русское произношение («переключи на анилибрию»,
 * «включи ани либрию»), а на сайте озвучка хранится как «AniLibria» (латиницей).
 *
 * Алгоритм resolveVoiceProvider (берётся МАКСИМАЛЬНАЯ уверенность):
 *   1) exact    — нормализованное spoken == нормализованное name/shortName → 1.00
 *   2) alias    — совпадение с алиасом (DEFAULT_VOICE_ALIASES + userAliases) → 0.97
 *   3) translit — фонетические ключи совпали (анилибрия ~ AniLibria) → 0.92
 *   4) fuzzy    — нечётное сравнение (similarity/titleSimilarity по нормализованным
 *                 строкам и фонетическим ключам); если ни один токен не начинается
 *                 с той же буквы — cap 0.5
 *
 * Пороги из types.ts: >= VOICE_CONFIDENCE_AUTO (0.85) — переключать молча,
 * >= VOICE_CONFIDENCE_ASK (0.55) — спросить подтверждение, ниже — отказ.
 */
import { VOICE_CONFIDENCE_ASK, VoiceAliasMap, VoiceProviderMatch } from '@/lib/avc/types'
import { normalizeForMatch, similarity, titleSimilarity } from './fuzzy'
import { phoneticKey, stripCaseEndings } from './phonetics'

// Реэкспорт фонетических утилит (удобство для потребителей резолвера).
// Сами функции живут в phonetics.ts — чтобы избежать циклического импорта
// между fuzzy.ts и provider-resolver.ts.
export { phoneticKey, stripCaseEndings }

/** Полная нормализация произнесённого имени: normalizeForMatch + stripCaseEndings */
export function normalizeVoiceName(s: string): string {
  return stripCaseEndings(normalizeForMatch(s))
}

export interface DubCandidate {
  /** Название озвучки на сайте (dubs[].name), напр. «Озвучка AniLibria» */
  name: string
  /** Короткое имя (dubs[].shortName), напр. «AniLibria» */
  shortName: string
}

/**
 * Встроенные алиасы известных озвучек.
 * Ключ — lower(shortName) как на сайте; сопоставление с кандидатом —
 * регистронезависимо по вхождению ключа в name/shortName.
 */
export const DEFAULT_VOICE_ALIASES: Record<string, string[]> = {
  anilibria: ['анилибрия', 'анилибриа', 'ани либрия', 'ани либриа', 'анилибре', 'anilibria', 'ani libria'],
  studioband: ['студиобенд', 'студио бенд', 'студия бэнд', 'студиобэнд', 'studio band'],
  'dream cast': ['дрим каст', 'дримкаст', 'dream cast'],
  animevost: ['анимевост', 'аниме вост', 'анимэ вост', 'anime vost'],
  anidub: ['анидаб', 'ани дуб', 'анидаб', 'ani dub'],
  anistar: ['анистар', 'ани стар', 'ani star'],
  jam: ['джем', 'jam'],
  animego: ['анимего', 'аниме го', 'anime go'],
  'shiza project': ['шиза', 'шиза проект', 'shiza'],
}

/** Уверенности по способам сопоставления */
const CONF_EXACT = 1.0
const CONF_ALIAS = 0.97
const CONF_TRANSLIT = 0.92
/** Если ни один токен не начинается с той же буквы — cap для fuzzy */
const FUZZY_FIRST_LETTER_CAP = 0.5

/**
 * Собрать карту пользовательских алиасов озвучек из записей БД.
 * Ключ — нормализованное имя озвучки (normalizeVoiceName), значения — сырые алиасы.
 */
export function buildUserAliasMap(aliases: Array<{ targetName: string; alias: string }>): VoiceAliasMap {
  const map: VoiceAliasMap = {}
  for (const { targetName, alias } of aliases) {
    const key = normalizeVoiceName(targetName)
    if (!key) continue
    const a = alias.trim()
    if (!a) continue
    if (!map[key]) map[key] = []
    if (!map[key].includes(a)) map[key].push(a)
  }
  return map
}

/** Алиасы кандидата: встроенные (по вхождению ключа в name/shortName) + пользовательские */
function collectAliases(
  dub: DubCandidate,
  userAliases?: VoiceAliasMap,
): string[] {
  const nameLower = dub.name.toLowerCase()
  const shortLower = dub.shortName.toLowerCase()
  const out: string[] = []

  for (const [key, list] of Object.entries(DEFAULT_VOICE_ALIASES)) {
    // ключ — нижний регистр shortName; сопоставление регистронезависимо по вхождению
    if (nameLower.includes(key) || shortLower.includes(key)) {
      out.push(...list)
    }
  }

  if (userAliases) {
    for (const [target, list] of Object.entries(userAliases)) {
      const targetNorm = normalizeVoiceName(target)
      const keyMatch =
        (targetNorm && (targetNorm === normalizeVoiceName(dub.name) || targetNorm === normalizeVoiceName(dub.shortName))) ||
        nameLower.includes(target.toLowerCase()) ||
        shortLower.includes(target.toLowerCase())
      if (keyMatch) out.push(...list)
    }
  }

  return out
}

/** Множество первых букв токенов (и нормализованных, и фонетических) */
function firstLetters(...forms: string[]): Set<string> {
  const letters = new Set<string>()
  for (const form of forms) {
    for (const tok of form.split(' ').filter(Boolean)) {
      letters.add(tok[0])
      const ph = phoneticKey(tok)
      if (ph) letters.add(ph[0])
    }
  }
  return letters
}

/**
 * Главный резолвер озвучек.
 *
 * @param spoken        как распознал Whisper («ани либрию»)
 * @param dubs          доступные озвучки (name/shortName как на сайте)
 * @param userAliases   пользовательские алиасы: targetName(lower) -> aliases[]
 * @param minConfidence минимальная уверенность (по умолчанию VOICE_CONFIDENCE_ASK)
 * @returns лучший кандидат с confidence >= minConfidence, иначе null
 */
export function resolveVoiceProvider(
  spoken: string,
  dubs: DubCandidate[],
  userAliases?: VoiceAliasMap,
  minConfidence: number = VOICE_CONFIDENCE_ASK,
): VoiceProviderMatch | null {
  if (!spoken || !spoken.trim() || dubs.length === 0) return null

  const spokenNorm = normalizeVoiceName(spoken)
  const spokenPh = phoneticKey(spokenNorm)
  if (!spokenNorm && !spokenPh) return null

  let best: VoiceProviderMatch | null = null

  for (const dub of dubs) {
    const targets = [dub.name, dub.shortName, ...collectAliases(dub, userAliases)]
      .map((t) => t.trim())
      .filter(Boolean)
    if (targets.length === 0) continue

    // предвычисленные формы целей
    const normTargets = targets.map((t) => ({ raw: t, norm: normalizeVoiceName(t), ph: phoneticKey(t) }))

    // 1) exact: spoken == name | shortName (нормализованные; алиасы — на шаге 2)
    let score = 0
    let via: VoiceProviderMatch['matchedVia'] = 'fuzzy'
    for (let i = 0; i < Math.min(2, normTargets.length); i++) {
      if (spokenNorm && spokenNorm === normTargets[i].norm) {
        score = CONF_EXACT
        via = 'exact'
        break
      }
    }

    // 2) alias: spoken совпал с алиасом (нормализованные + падежи срезаны)
    if (score === 0) {
      for (let i = 2; i < normTargets.length; i++) {
        const t = normTargets[i]
        if (spokenNorm && spokenNorm === t.norm) {
          score = CONF_ALIAS
          via = 'alias'
          break
        }
      }
    }

    // 3) translit: фонетические ключи совпали (name | shortName | алиас)
    if (score === 0 && spokenPh) {
      for (const t of normTargets) {
        if (t.ph && spokenPh === t.ph) {
          score = CONF_TRANSLIT
          via = 'translit'
          break
        }
      }
    }

    // 4) fuzzy: max по similarity/titleSimilarity нормализованных строк и фонетических ключей
    let fuzzyScore = 0
    if (score === 0) {
      const spokenLetters = firstLetters(spokenNorm, spokenPh)
      for (const t of normTargets) {
        const cand = Math.max(
          titleSimilarity(spokenNorm, t.norm),
          similarity(spokenNorm, t.norm),
          spokenPh && t.ph ? titleSimilarity(spokenPh, t.ph) : 0,
          spokenPh && t.ph ? similarity(spokenPh, t.ph) : 0,
        )
        if (cand <= fuzzyScore) continue
        // cap: ни один токен spoken не начинается с той же буквы, что и токен цели
        const targetLetters = firstLetters(t.norm, t.ph)
        let letterOk = false
        for (const l of spokenLetters) {
          if (targetLetters.has(l)) {
            letterOk = true
            break
          }
        }
        fuzzyScore = letterOk ? cand : Math.min(cand, FUZZY_FIRST_LETTER_CAP)
      }
      if (fuzzyScore > 0) {
        score = fuzzyScore
        via = 'fuzzy'
      }
    }

    if (score > 0 && (!best || score > best.confidence)) {
      best = {
        name: dub.name,
        shortName: dub.shortName,
        confidence: Math.min(1, score),
        matchedVia: via,
      }
    }
  }

  if (!best || best.confidence < minConfidence) return null
  return best
}
