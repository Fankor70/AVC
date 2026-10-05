/**
 * GET /api/yummy/favorites — избранное пользователя YummyAnime.
 *
 * EXE-сборка: UI берёт избранное напрямую через IPC (window.avcElectron).
 * Веб-режим (превью): GET /actions/export-favorites.php?format=json&vote=0
 * в контексте серверной сессии сайта (db/yummy-session.json, 0600).
 * Нет сессии — честная причина недоступности, ничего не выдумываем.
 */
import { NextResponse } from 'next/server'
import { fetchFavoritesText, parseFavorites } from '@/lib/sites/yummy/web-auth'
import { clearWebSession, loadWebSession } from '@/lib/sites/yummy/web-session'
import type { YummyFavoritesResult } from '@/lib/avc/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await loadWebSession()
  if (!session) {
    const res: YummyFavoritesResult = {
      available: false,
      items: [],
      reason: 'Войдите в аккаунт YummyAnime — избранное хранится в вашем аккаунте на сайте',
      lastSync: null,
    }
    return NextResponse.json(res)
  }

  const { status, text } = await fetchFavoritesText(session.cookie)
  if (status === 200) {
    const res: YummyFavoritesResult = {
      available: true,
      items: parseFavorites(text),
      reason: null,
      lastSync: new Date().toISOString(),
    }
    return NextResponse.json(res)
  }

  if (status === 401 || status === 403) {
    await clearWebSession()
    const res: YummyFavoritesResult = {
      available: false,
      items: [],
      reason: 'Сессия YummyAnime истекла — войдите заново',
      lastSync: null,
    }
    return NextResponse.json(res)
  }

  const res: YummyFavoritesResult = {
    available: false,
    items: [],
    reason:
      status === 0
        ? 'Сайт YummyAnime недоступен — попробуйте позже'
        : `Сайт ответил ошибкой (HTTP ${status}) — попробуйте позже`,
    lastSync: null,
  }
  return NextResponse.json(res)
}
