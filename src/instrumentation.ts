/**
 * Next.js instrumentation — вызывается один раз при старте сервера ДО обработки
 * запросов. Здесь синхронизируем схему SQLite с текущей Prisma-схемой:
 * portable EXE хранит БД пользователя в userData между обновлениями, и без этой
 * синхронизации новая колонка (например CommandHistoryEntry.correlationId в 1.0.13)
 * давала HTTP 500 на /api/history (GitHub issue #1).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureSqliteSchema } = await import('@/lib/db-ensure-schema')
    const res = await ensureSqliteSchema()
    if (!res.ok) {
      console.error('[db-ensure-schema] sync failed:', res.error)
    } else if (res.createdTables.length || res.addedColumns.length || res.createdIndexes.length) {
      console.log(
        `[db-ensure-schema] synced: +tables ${res.createdTables.join(',') || '—'}; +columns ${res.addedColumns.join(',') || '—'}; +indexes ${res.createdIndexes.join(',') || '—'}`,
      )
    }
  }
}
