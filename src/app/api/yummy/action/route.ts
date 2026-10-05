/**
 * POST /api/yummy/action — РЕАЛЬНОЕ действие аккаунта YummyAnime (режим превью).
 *
 * Тело: YummyAnimeActionRequest {kind, animeId, value?, slug?}.
 * Действие выполняется сервером В КОНТЕКСТЕ сессии сайта (cookie из
 * db/yummy-session.json, 0600) ТОЧНЫМИ запросами самого сайта:
 *   PUT/DELETE /api/anime/{id}/list | /list/fav | /rate
 * затем верифицируется перечитыванием серверного HTML страницы тайтла
 * (маркеры .fav-type[data-id].selected / .fav-type-fav.selected /
 * .user-rating — как у самого сайта). Ответ — YummyAnimeActionResponse,
 * cookie наружу не отдаются.
 */
import { NextRequest, NextResponse } from 'next/server'
import { executeAnimeAction } from '@/lib/sites/yummy/web-auth'
import { clearWebSession, loadWebSession } from '@/lib/sites/yummy/web-session'
import type { YummyAnimeActionRequest, YummyAnimeActionResponse } from '@/lib/avc/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const KINDS = new Set([
  'setList',
  'removeList',
  'setFavorite',
  'removeFavorite',
  'setRate',
  'removeRate',
])

export async function POST(req: NextRequest) {
  let body: YummyAnimeActionRequest
  try {
    body = (await req.json()) as YummyAnimeActionRequest
  } catch {
    return NextResponse.json({ ok: false, message: 'Некорректный запрос' }, { status: 400 })
  }

  const kind = body?.kind
  const animeId = Number(body?.animeId)
  if (typeof kind !== 'string' || !KINDS.has(kind) || !Number.isInteger(animeId) || animeId <= 0) {
    return NextResponse.json({ ok: false, message: 'Некорректное действие' }, { status: 400 })
  }

  const session = await loadWebSession()
  if (!session) {
    const res: YummyAnimeActionResponse = {
      ok: false,
      httpStatus: 0,
      verification: 'skipped',
      state: null,
      message: 'Войдите в аккаунт YummyAnime — действие выполняется в вашем аккаунте на сайте',
    }
    return NextResponse.json(res, { status: 401 })
  }

  const run = await executeAnimeAction(session.cookie, {
    kind: kind as YummyAnimeActionRequest['kind'],
    animeId,
    value: typeof body.value === 'number' ? body.value : undefined,
    slug: typeof body.slug === 'string' ? body.slug : undefined,
  })

  if (run.httpStatus === 401 || run.httpStatus === 403) {
    // Сессия мертва — сайт сам отклонил действие
    await clearWebSession()
    const res: YummyAnimeActionResponse = {
      ok: false,
      httpStatus: run.httpStatus,
      verification: 'unconfirmed',
      state: null,
      message: 'Сессия YummyAnime истекла — войдите заново',
    }
    return NextResponse.json(res, { status: 200 })
  }

  if (run.httpStatus === 0) {
    const res: YummyAnimeActionResponse = {
      ok: false,
      httpStatus: 0,
      verification: 'unconfirmed',
      state: null,
      message: 'Сайт YummyAnime недоступен — действие не выполнено',
    }
    return NextResponse.json(res, { status: 200 })
  }

  const pass = run.httpStatus >= 200 && run.httpStatus < 300
  const res: YummyAnimeActionResponse = {
    ok: pass,
    httpStatus: run.httpStatus,
    verification: pass ? run.verification : 'unconfirmed',
    state: run.state,
    message: pass
      ? run.verification === 'pass'
        ? 'Действие выполнено и подтверждено сайтом'
        : run.verification === 'mismatch'
          ? 'Сайт принял запрос, но состояние страницы не совпало — проверьте на сайте'
          : run.siteError ?? 'Сайт принял запрос, состояние подтвердить не удалось'
      : run.siteError ?? `Сайт отклонил действие (HTTP ${run.httpStatus})`,
  }
  return NextResponse.json(res, { status: 200 })
}
