/**
 * CommandNormalizer — нормализация текста перед парсингом (мастер-промпт #76).
 * lowercase, trim, удаление пунктуации, нормализация пробелов, ё -> е.
 */
export function normalizeCommandText(input: string): string {
  return input
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.,!?;:«»"“”'’()\[\]{}\-–—_+/\\|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Убрать вежливые слова-паразиты, не влияющие на смысл */
const FILLERS = [
  'пожалуйста',
  'будьте добры',
  'будь добр',
  'мне бы',
  'хотел бы',
  'хочу',
  'давай',
  'давайте',
  'займись',
  'сделай',
]

export function stripFillers(normalized: string): string {
  let text = ` ${normalized} `
  for (const f of FILLERS) {
    text = text.split(` ${f} `).join(' ')
  }
  return text.trim().replace(/\s+/g, ' ')
}
