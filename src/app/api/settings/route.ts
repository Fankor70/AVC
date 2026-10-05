/**
 * Настройки приложения (мастер-промпт #48).
 * GET /api/settings -> { settings }
 * PUT /api/settings { ...partial } -> { settings }
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSqliteSchema } from '@/lib/db-ensure-schema'
import { AppSettings, DEFAULT_SETTINGS } from '@/lib/avc/types'

export const dynamic = 'force-dynamic'

export async function GET() {
  // Синхронизация схемы БД (single-flight) — защита от рассинхрона в EXE (issue #2)
  await ensureSqliteSchema()
  const rows = await db.appSetting.findMany()
  const settings: AppSettings = { ...DEFAULT_SETTINGS }
  const mutable = settings as unknown as Record<string, unknown>
  for (const row of rows) {
    if (!(row.key in DEFAULT_SETTINGS)) continue
    try {
      mutable[row.key] = JSON.parse(row.value) as unknown
    } catch {
      // пропускаем повреждённые значения
    }
  }
  return NextResponse.json({ settings })
}

export async function PUT(req: NextRequest) {
  try {
    await ensureSqliteSchema()
    const patch = (await req.json()) as Partial<AppSettings>
    const updates = Object.entries(patch).filter(([key]) => key in DEFAULT_SETTINGS)
    for (const [key, value] of updates) {
      await db.appSetting.upsert({
        where: { key },
        create: { key, value: JSON.stringify(value) },
        update: { value: JSON.stringify(value) },
      })
    }
    return GET()
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Ошибка сохранения настроек' },
      { status: 500 },
    )
  }
}
