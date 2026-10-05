/**
 * GET /api/yummy/anime-state?slug=... — своё состояние тайтла (режим превью).
 *
 * Читает серверный HTML страницы аниме В КОНТЕКСТЕ сессии сайта
 * (cookie из db/yummy-session.json) и парсит маркеры самого сайта:
 * .fav-type[data-id].selected / .fav-type-fav.selected / .user-rating.
 * Ответ: { state: YummyAnimeOwnState | null }, cookie наружу не отдаются.
 */
import { NextRequest, NextResponse } from 'next/server'
import { readOwnState } from '@/lib/sites/yummy/web-auth'
import { loadWebSession } from '@/lib/sites/yummy/web-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('slug') ?? ''
  // slug страницы тайтла на сайте — ASCII-слаг; защите от инъекций в URL не помешает
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(slug)) {
    return NextResponse.json({ state: null, message: 'Некорректный slug' }, { status: 400 })
  }
  const session = await loadWebSession()
  if (!session) {
    return NextResponse.json({ state: null }, { status: 401 })
  }
  const state = await readOwnState(session.cookie, slug)
  return NextResponse.json({ state })
}
