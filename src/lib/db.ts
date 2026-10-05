import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * Самопроверка после `db:push`: долгоживущий dev-процесс может держать
 * PrismaClient, сгенерированный ДО появления новых моделей (например User) —
 * у такого клиента `db.user` undefined и все новые маршруты падают с 500.
 * Если глобальный клиент устарел — гасим его и создаём свежий по текущей схеме.
 */
function isStaleClient(c: PrismaClient | undefined): boolean {
  if (!c) return false
  const rec = c as unknown as Record<string, unknown>
  // Клиент, сгенерированный до появления модели, не знает о ней (undefined) —
  // все маршруты с этой моделью упадут с 500. Проверяем несколько моделей.
  return rec.user === undefined || rec.watchProgressEntry === undefined
}

if (isStaleClient(globalForPrisma.prisma)) {
  void globalForPrisma.prisma!.$disconnect().catch(() => undefined)
  globalForPrisma.prisma = undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['query'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
