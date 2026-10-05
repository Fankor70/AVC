import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureSqliteSchema } from '@/lib/db-ensure-schema'

export const runtime = 'nodejs'

const TARGET_TYPES = ['voice', 'anime', 'section', 'command'] as const
type TargetType = (typeof TARGET_TYPES)[number]

function isTargetType(v: unknown): v is TargetType {
  return typeof v === 'string' && (TARGET_TYPES as readonly string[]).includes(v)
}

/**
 * Алиасы озвучек/аниме/секций/команд — глобальные (thin client: локального
 * аккаунта больше нет, приложение одно-пользовательское настольное).
 */

/** GET /api/aliases → {aliases} */
export async function GET() {
  await ensureSqliteSchema()
  const aliases = await db.voiceAlias.findMany({
    orderBy: { createdAt: 'desc' },
    select: { id: true, targetType: true, targetName: true, alias: true },
  })
  return NextResponse.json({ aliases })
}

/** POST /api/aliases {targetType?, targetName, alias} → {alias}; дубликат → существующий (200) */
export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 })
  }

  const { targetType, targetName, alias } = (body ?? {}) as {
    targetType?: unknown
    targetName?: unknown
    alias?: unknown
  }

  if (!isTargetType(targetType ?? 'voice')) {
    return NextResponse.json(
      { error: 'targetType: voice|anime|section|command' },
      { status: 400 },
    )
  }
  const type: TargetType = isTargetType(targetType) ? targetType : 'voice'

  if (typeof alias !== 'string' || alias.trim().length === 0 || alias.trim().length > 48) {
    return NextResponse.json({ error: 'alias: 1–48 символов' }, { status: 400 })
  }
  if (
    typeof targetName !== 'string' ||
    targetName.trim().length === 0 ||
    targetName.trim().length > 64
  ) {
    return NextResponse.json({ error: 'targetName: 1–64 символа' }, { status: 400 })
  }

  const aliasNorm = alias.trim()
  const targetNorm = targetName.trim()

  // Уже есть — просто возвращаем существующую (не ошибка)
  await ensureSqliteSchema()
  const existing = await db.voiceAlias.findUnique({
    where: {
      targetType_targetName_alias: {
        targetType: type,
        targetName: targetNorm,
        alias: aliasNorm,
      },
    },
    select: { id: true, targetType: true, targetName: true, alias: true },
  })
  if (existing) return NextResponse.json({ alias: existing })

  const created = await db.voiceAlias.create({
    data: {
      targetType: type,
      targetName: targetNorm,
      alias: aliasNorm,
    },
    select: { id: true, targetType: true, targetName: true, alias: true },
  })
  return NextResponse.json({ alias: created })
}

/** DELETE /api/aliases?id=xxx → {ok:true} */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id обязателен' }, { status: 400 })

  await ensureSqliteSchema()
  await db.voiceAlias.deleteMany({ where: { id } })
  return NextResponse.json({ ok: true })
}
