/**
 * GET /api/yummy/account — состояние аккаунта YummyAnime.
 *
 * РЕЖИМЫ:
 *   - EXE-сборка: UI получает снимок через IPC (window.avcElectron) — этот
 *     роут для аутентифицированных данных не используется.
 *   - Веб-режим (превью): серверная сессия сайта (db/yummy-session.json,
 *     0600) проверяется ЖИВЫМ запросом GET /api/profile на сайте — сайт
 *     единственный источник истины (спека, секция 6). Cookie клиенту
 *     не отдаются; наружу только НЕ-секретный снимок.
 */
import { NextResponse } from 'next/server'
import { fetchProfile, parseProfile, touchSessionUsername } from '@/lib/sites/yummy/web-auth'
import { clearWebSession, loadWebSession, saveWebSession } from '@/lib/sites/yummy/web-session'
import type { YummyAccountSnapshot } from '@/lib/avc/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await loadWebSession()
  if (!session) {
    const snap: YummyAccountSnapshot = {
      state: 'loggedOut',
      user: null,
      lastSync: null,
      source: 'no-session',
      message: 'Войдите в аккаунт YummyAnime — списки, оценки и избранное хранятся на сайте',
    }
    return NextResponse.json(snap)
  }

  // Живая проверка сессии на сайте (сайт = источник истины)
  const prof = await fetchProfile(session.cookie)
  if (prof.status === 200) {
    const user = parseProfile(prof.body)
    await touchSessionUsername(session, user?.username ?? null, saveWebSession).catch(() => {})
    const snap: YummyAccountSnapshot = {
      state: 'loggedIn',
      user,
      lastSync: new Date().toISOString(),
      source: 'live',
      message: null,
    }
    return NextResponse.json(snap)
  }

  if (prof.status === 401 || prof.status === 403) {
    // Cookie мертвы — удалить бесполезный файл, честно сообщить
    await clearWebSession()
    const snap: YummyAccountSnapshot = {
      state: 'sessionExpired',
      user: null,
      lastSync: null,
      source: 'error',
      message: 'Сессия YummyAnime истекла — войдите заново',
    }
    return NextResponse.json(snap)
  }

  // Сайт недоступен — состояние не выдумываем
  const snap: YummyAccountSnapshot = {
    state: 'unavailable',
    user: session.username ? { userId: null, username: session.username, displayName: session.username, avatarUrl: null } : null,
    lastSync: session.savedAt ? new Date(session.savedAt).toISOString() : null,
    source: 'error',
    message: 'Сайт YummyAnime недоступен — состояние сессии не проверить',
  }
  return NextResponse.json(snap)
}
