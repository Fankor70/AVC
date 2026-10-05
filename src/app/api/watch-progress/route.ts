/**
 * /api/watch-progress — локальный трекинг просмотра (БД приложения, SQLite).
 *
 * Зачем: сайт пишет прогресс серий ВНУТРИ своей сессии (PUT /api/video/{id})
 * и наружу его не отдаёт — проверено живым сайтом (в /api/anime/{id}/videos
 * поля watched/time отсутствуют). Приложение поэтому ведёт собственную
 * честную запись: какое аниме, какая серия, когда — и показывает её
 * в библиотеке («Продолжить просмотр») и на странице тайтла.
 *
 * accountKey — изоляция аккаунтов: userId сайта для залогиненных, 'anon' для
 * гостя. Это НЕ-секретный слот (спецификация, секция 14): пароли/cookie
 * идентификаторами не используются.
 *
 * GET    ?accountKey=…  → список записей (свежие сверху)
 * POST   {accountKey, animeId, slug?, title, poster?, episode?,
 *         episodesTotal?, dubbing?}           → upsert (fire-and-forget с клиента)
 * DELETE ?accountKey=…&animeId=…              → забыть одно аниме
 * DELETE ?accountKey=…                        → очистить всё
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSqliteSchema } from '@/lib/db-ensure-schema'
import type { WatchProgressItem, WatchProgressResult } from '@/lib/avc/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function safeAccountKey(v: string | null): string | null {
  return v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null
}

function toItems(rows: Array<{
  animeId: number
  slug: string
  title: string
  poster: string | null
  episode: number | null
  episodesTotal: number | null
  dubbing: string | null
  updatedAt: Date
}>): WatchProgressItem[] {
  return rows.map((r) => ({
    animeId: r.animeId,
    slug: r.slug,
    title: r.title,
    poster: r.poster,
    episode: r.episode,
    episodesTotal: r.episodesTotal,
    dubbing: r.dubbing,
    updatedAt: r.updatedAt.toISOString(),
  }))
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const accountKey = safeAccountKey(url.searchParams.get('accountKey'))
  if (!accountKey) {
    const res: WatchProgressResult = {
      available: false,
      items: [],
      reason: 'Некорректный accountKey',
    }
    return NextResponse.json(res, { status: 400 })
  }
  try {
    await ensureSqliteSchema()
    const rows = await db.watchProgressEntry.findMany({
      where: { accountKey },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    })
    const res: WatchProgressResult = { available: true, items: toItems(rows), reason: null }
    return NextResponse.json(res)
  } catch {
    const res: WatchProgressResult = {
      available: false,
      items: [],
      reason: 'База недоступна — прогресс не прочитан',
    }
    return NextResponse.json(res, { status: 500 })
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, message: 'Ожидался JSON' }, { status: 400 })
  }

  const accountKey = typeof body.accountKey === 'string' ? safeAccountKey(body.accountKey) : null
  const animeId = typeof body.animeId === 'number' && Number.isFinite(body.animeId) ? body.animeId : null
  const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim() : null
  if (!accountKey || animeId === null || !title) {
    return NextResponse.json(
      { ok: false, message: 'Нужны accountKey, animeId и title' },
      { status: 400 },
    )
  }

  const slug = typeof body.slug === 'string' ? body.slug : ''
  const poster = typeof body.poster === 'string' && body.poster.trim() !== '' ? body.poster : null
  const episode =
    typeof body.episode === 'number' && Number.isFinite(body.episode) && body.episode > 0
      ? Math.floor(body.episode)
      : null
  const episodesTotal =
    typeof body.episodesTotal === 'number' &&
    Number.isFinite(body.episodesTotal) &&
    body.episodesTotal > 0
      ? Math.floor(body.episodesTotal)
      : null
  const dubbing =
    typeof body.dubbing === 'string' && body.dubbing.trim() !== '' ? body.dubbing.trim() : null

  try {
    await ensureSqliteSchema()
    const row = await db.watchProgressEntry.upsert({
      where: { accountKey_animeId: { accountKey, animeId } },
      create: { accountKey, animeId, slug, title, poster, episode, episodesTotal, dubbing },
      update: {
        slug,
        title,
        ...(poster !== null ? { poster } : {}),
        ...(episode !== null ? { episode } : {}),
        ...(episodesTotal !== null ? { episodesTotal } : {}),
        ...(dubbing !== null ? { dubbing } : {}),
      },
    })
    return NextResponse.json({ ok: true, updatedAt: row.updatedAt.toISOString() })
  } catch {
    return NextResponse.json({ ok: false, message: 'База недоступна' }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  const url = new URL(request.url)
  const accountKey = safeAccountKey(url.searchParams.get('accountKey'))
  if (!accountKey) {
    return NextResponse.json({ ok: false, message: 'Некорректный accountKey' }, { status: 400 })
  }
  const animeIdRaw = url.searchParams.get('animeId')
  try {
    await ensureSqliteSchema()
    if (animeIdRaw !== null) {
      const animeId = parseInt(animeIdRaw, 10)
      if (!Number.isFinite(animeId)) {
        return NextResponse.json({ ok: false, message: 'Некорректный animeId' }, { status: 400 })
      }
      await db.watchProgressEntry.deleteMany({ where: { accountKey, animeId } })
    } else {
      await db.watchProgressEntry.deleteMany({ where: { accountKey } })
    }
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false, message: 'База недоступна' }, { status: 500 })
  }
}
