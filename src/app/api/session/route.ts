/**
 * Сессия вкладок (мастер-промпт #30): URL, название, позиция, активная вкладка.
 * GET /api/session -> { tabs }
 * POST { tabs: BrowserTab[], activeId } -> сохранение
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSqliteSchema } from '@/lib/db-ensure-schema'
import { BrowserTab } from '@/lib/avc/types'

export const dynamic = 'force-dynamic'

export async function GET() {
  await ensureSqliteSchema()
  const rows = await db.tabSession.findMany({ orderBy: { position: 'asc' } })
  const tabs: BrowserTab[] = rows.map((r) => {
    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(r.payload)
    } catch {
      payload = {}
    }
    return {
      id: r.id,
      kind: r.kind as BrowserTab['kind'],
      title: r.title,
      payload,
      createdAt: r.updatedAt.getTime(),
    }
  })
  const activeId = rows.find((r) => r.active)?.id ?? null
  return NextResponse.json({ tabs, activeId, hasSession: rows.length > 0 })
}

export async function POST(req: NextRequest) {
  try {
    const { tabs, activeId } = (await req.json()) as {
      tabs: BrowserTab[]
      activeId: string | null
    }
    if (!Array.isArray(tabs)) {
      return NextResponse.json({ error: 'tabs обязателен' }, { status: 400 })
    }
    await ensureSqliteSchema()
    await db.tabSession.deleteMany({})
    if (tabs.length > 0) {
      await db.tabSession.createMany({
        data: tabs.slice(0, 20).map((t, i) => ({
          position: i,
          kind: t.kind,
          title: t.title.slice(0, 120),
          payload: JSON.stringify(t.payload ?? {}),
          active: t.id === activeId,
        })),
      })
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Ошибка сохранения сессии' },
      { status: 500 },
    )
  }
}

export async function DELETE() {
  await ensureSqliteSchema()
  await db.tabSession.deleteMany({})
  return NextResponse.json({ ok: true })
}
