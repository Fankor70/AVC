/**
 * Web-сессия YummyAnime (режим превью в браузере, БЕЗ Electron-оболочки).
 *
 * Как это было в ранней версии приложения (cookie-мост) и что просил
 * пользователь вернуть: пользователь вводит логин/пароль, приложение
 * отправляет их НАПРЯМУЮ на сервер сайта (POST /api/profile/login),
 * получает cookie-сессию сайта и дальше выполняет все действия аккаунта
 * с этими cookie — как обычный браузер.
 *
 * Хранение: ТОЛЬКО на сервере Next.js (Node), файл db/yummy-session.json
 * с правами 0600. Файл в .gitignore — cookie никогда не попадают в git.
 * Пароль НЕ хранится нигде и нигде не логируется. Клиенту (браузеру)
 * отдаются только НЕ-секретные снимки аккаунта (спека, секция 15).
 */
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import path from 'path'

const DB_DIR = path.join(process.cwd(), 'db')
const SESSION_FILE = path.join(DB_DIR, 'yummy-session.json')

export interface WebSessionData {
  /** Сырая строка Cookie-заголовка (name=value; name2=value2) */
  cookie: string
  /** Epoch ms — когда сессия получена с сайта */
  savedAt: number
  /** НЕ-секретная подпись (ник с сайта) — для отладки, без секретов */
  username: string | null
}

/** Прочитать сессию из файла (null — если нет/битая/без cookie) */
export async function loadWebSession(): Promise<WebSessionData | null> {
  try {
    const raw = await readFile(SESSION_FILE, 'utf8')
    const data = JSON.parse(raw) as Partial<WebSessionData>
    if (typeof data.cookie !== 'string' || data.cookie.trim() === '') return null
    return {
      cookie: data.cookie.trim(),
      savedAt: typeof data.savedAt === 'number' ? data.savedAt : 0,
      username: typeof data.username === 'string' ? data.username : null,
    }
  } catch {
    return null
  }
}

/** Сохранить сессию (0600, каталог db/ создаётся при необходимости) */
export async function saveWebSession(data: WebSessionData): Promise<void> {
  await mkdir(DB_DIR, { recursive: true })
  const body = JSON.stringify(
    { cookie: data.cookie, savedAt: data.savedAt, username: data.username },
    null,
    2,
  )
  await writeFile(SESSION_FILE, body, { encoding: 'utf8', mode: 0o600 })
}

/** Удалить сохранённую сессию (logout/истечение) */
export async function clearWebSession(): Promise<void> {
  try {
    await unlink(SESSION_FILE)
  } catch {
    /* файла нет — уже хорошо */
  }
}
