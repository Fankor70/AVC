/**
 * /api/skip-marks — пользовательские отметки таймкодов (Skip Segments P3).
 *
 * «Запомни начало опенинга» голосом или кнопкой кладёт границу сюда; отметка
 * живёт на (аккаунт, аниме, озвучка, тип) и применяется к другим сериям тем
 * же resolver'ом. Вторая граница может быть неизвестна (частичная отметка) —
 * upsert мержит границы, не затирая уже стоящую.
 *
 * GET    ?accountKey=…&animeId=?            → отметки (все или по тайтлу)
 * POST   {accountKey, animeId, dubbing?, type, startSec?, endSec?} → upsert
 * DELETE ?accountKey=…[&animeId=…&type=…]   → снять одну отметку / очистить всё
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSqliteSchema } from '@/lib/db-ensure-schema'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TYPES = new Set(['op', 'ed', 'recap'])

function safeAccountKey(v: string | null | undefined): string {
  return v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : 'anon'
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const accountKey = safeAccountKey(url.searchParams.get('accountKey'))
  const animeIdRaw = url.searchParams.get('animeId')
  const animeId = animeIdRaw !== null && /^\d+$/.test(animeIdRaw) ? parseInt(animeIdRaw, 10) : null
  try {
    await ensureSqliteSchema()
    const rows = await db.skipMark.findMany({
      where: { accountKey, ...(animeId !== null ? { animeId } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    })
    return NextResponse.json({
      marks: rows.map((r) => ({
        animeId: r.animeId,
        dubbing: r.dubbing || null,
        type: r.type,
        startSec: r.startSec,
        endSec: r.endSec,
        updatedAt: r.updatedAt.toISOString(),
      })),
    })
  } catch {
    return NextResponse.json({ marks: [], error: 'База недоступна' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  let body: {
    accountKey?: string
    animeId?: number
    dubbing?: string | null
    type?: string
    startSec?: number | null
    endSec?: number | null
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Некорректный запрос' }, { status: 400 })
  }
  const accountKey = safeAccountKey(body.accountKey)
  const animeId = Number(body.animeId)
  const type = String(body.type ?? '')
  if (!Number.isInteger(animeId) || animeId <= 0 || !TYPES.has(type)) {
    return NextResponse.json({ ok: false, message: 'Некорректная отметка' }, { status: 400 })
  }
  const dubbing = typeof body.dubbing === 'string' ? body.dubbing.slice(0, 120) : ''
  const startSec =
    typeof body.startSec === 'number' && Number.isFinite(body.startSec) && body.startSec >= 0
      ? body.startSec
      : null
  const endSec =
    typeof body.endSec === 'number' && Number.isFinite(body.endSec) && body.endSec > 0
      ? body.endSec
      : null
  if (startSec === null && endSec === null) {
    return NextResponse.json({ ok: false, message: 'Нет ни одной границы' }, { status: 400 })
  }

  try {
    await ensureSqliteSchema()
    const existing = await db.skipMark.findUnique({
      where: {
        accountKey_animeId_dubbing_type: { accountKey, animeId, dubbing, type },
      },
    })
    const row = await db.skipMark.upsert({
      where: { accountKey_animeId_dubbing_type: { accountKey, animeId, dubbing, type } },
      create: { accountKey, animeId, dubbing, type, startSec, endSec },
      update: {
        // Частичная отметка мержится: старая граница не затирается null'ом
        startSec: startSec ?? existing?.startSec ?? null,
        endSec: endSec ?? existing?.endSec ?? null,
      },
    })
    return NextResponse.json({
      ok: true,
      mark: {
        animeId: row.animeId,
        dubbing: row.dubbing || null,
        type: row.type,
        startSec: row.startSec,
        endSec: row.endSec,
      },
    })
  } catch {
    return NextResponse.json({ ok: false, message: 'Не удалось сохранить отметку' }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  const url = new URL(request.url)
  const accountKey = safeAccountKey(url.searchParams.get('accountKey'))
  const animeIdRaw = url.searchParams.get('animeId')
  const type = url.searchParams.get('type')
  const dubbing = url.searchParams.get('dubbing') ?? ''
  try {
    await ensureSqliteSchema()
    if (animeIdRaw !== null && /^\d+$/.test(animeIdRaw) && type && TYPES.has(type)) {
      await db.skipMark.deleteMany({
        where: { accountKey, animeId: parseInt(animeIdRaw, 10), type, dubbing },
      })
    } else {
      await db.skipMark.deleteMany({ where: { accountKey } })
    }
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
