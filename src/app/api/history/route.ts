/**
 * История команд (мастер-промпт #35, #105) — только текст, аудио не хранится.
 * GET /api/history?limit=50
 * POST { raw, normalized, command, params, confidence, success, message, source }
 * DELETE /api/history — очистить
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSqliteSchema } from '@/lib/db-ensure-schema'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const limit = Math.min(200, parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10) || 50)
  try {
    // Синхронизация схемы БД (single-flight): в упакованном EXE instrumentation
    // может не вызваться — тогда старая БД без новых колонок давала 500 (issue #2)
    await ensureSqliteSchema()
    const items = await db.commandHistoryEntry.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    return NextResponse.json({ items })
  } catch (e) {
    // Честная ошибка вместо generic 500: причина (например, рассинхрон схемы
    // после обновления EXE) сразу видна в панели истории и в отчётах диагностики
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Ошибка чтения истории', items: [] },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureSqliteSchema()
    const b = await req.json()
    const item = await db.commandHistoryEntry.create({
      data: {
        raw: String(b.raw ?? '').slice(0, 500),
        normalized: String(b.normalized ?? '').slice(0, 500),
        command: String(b.command ?? 'Unknown').slice(0, 100),
        params: JSON.stringify(b.params ?? {}),
        confidence: Number(b.confidence ?? 0),
        success: Boolean(b.success),
        message: b.message ? String(b.message).slice(0, 300) : null,
        source: String(b.source ?? 'voice').slice(0, 20),
        correlationId:
          typeof b.correlationId === 'string' && b.correlationId.length <= 64
            ? b.correlationId
            : null,
      },
    })
    return NextResponse.json({ item })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Ошибка записи истории' },
      { status: 500 },
    )
  }
}

export async function DELETE() {
  await ensureSqliteSchema()
  await db.commandHistoryEntry.deleteMany({})
  return NextResponse.json({ ok: true })
}
