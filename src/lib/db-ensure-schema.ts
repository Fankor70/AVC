import { db } from './db'

/**
 * Синхронизация схемы SQLite на старте сервера (instrumentation.register).
 *
 * ПРОБЛЕМА, КОТОРУЮ ЭТО ЗАКРЫВАЕТ: portable EXE хранит БД в userData и НЕ
 * пересоздаёт её при обновлении приложения. Любая новая колонка/таблица в
 * prisma/schema.prisma ломала старую БД: Prisma-клиент запрашивал
 * «main.CommandHistoryEntry.correlationId» → HTTP 500 на /api/history
 * (реальный отчёт пользователя v1.0.14, GitHub issue #1).
 *
 * РЕШЕНИЕ: лёгкая идемпотентная синхронизация (без prisma CLI в рантайме):
 *   1. CREATE TABLE IF NOT EXISTS — по снапшоту DDL текущей схемы;
 *   2. PRAGMA table_info → ALTER TABLE ADD COLUMN для недостающих колонок;
 *   3. CREATE UNIQUE INDEX IF NOT EXISTS для недостающих уникальных индексов.
 *
 * ПРАВИЛО СОПРОВОЖДЕНИЯ: при изменении prisma/schema.prisma обнови СРАЗУ три
 * места: (1) DDL_TABLES, (2) TABLE_COLUMNS, (3) UNIQUE_INDEXES. Проверка:
 * `bun run db:push` локально → сверь вывод sqlite_master.
 */

/** Снапшот DDL (получен из sqlite_master после prisma db push, 2026-10-04) */
const DDL_TABLES: Record<string, string> = {
  AppSetting: `CREATE TABLE IF NOT EXISTS "AppSetting" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "value" TEXT NOT NULL,
  "updatedAt" DATETIME NOT NULL
)`,
  CommandHistoryEntry: `CREATE TABLE IF NOT EXISTS "CommandHistoryEntry" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "raw" TEXT NOT NULL,
  "normalized" TEXT NOT NULL,
  "command" TEXT NOT NULL,
  "params" TEXT NOT NULL DEFAULT '{}',
  "confidence" REAL NOT NULL,
  "success" BOOLEAN NOT NULL,
  "message" TEXT,
  "source" TEXT NOT NULL DEFAULT 'voice',
  "correlationId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
  SkipMark: `CREATE TABLE IF NOT EXISTS "SkipMark" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountKey" TEXT NOT NULL DEFAULT 'anon',
  "animeId" INTEGER NOT NULL,
  "dubbing" TEXT NOT NULL DEFAULT '',
  "type" TEXT NOT NULL,
  "startSec" REAL,
  "endSec" REAL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
)`,
  TabSession: `CREATE TABLE IF NOT EXISTS "TabSession" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "position" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "url" TEXT NOT NULL DEFAULT '',
  "payload" TEXT NOT NULL DEFAULT '{}',
  "active" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" DATETIME NOT NULL
)`,
  VoiceAlias: `CREATE TABLE IF NOT EXISTS "VoiceAlias" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "targetType" TEXT NOT NULL DEFAULT 'voice',
  "targetName" TEXT NOT NULL,
  "alias" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`,
  WatchProgressEntry: `CREATE TABLE IF NOT EXISTS "WatchProgressEntry" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountKey" TEXT NOT NULL,
  "animeId" INTEGER NOT NULL,
  "slug" TEXT NOT NULL DEFAULT '',
  "title" TEXT NOT NULL,
  "poster" TEXT,
  "episode" INTEGER,
  "episodesTotal" INTEGER,
  "dubbing" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
)`,
}

/**
 * Колонки для ALTER TABLE (таблица → колонка → фрагмент DDL).
 * Только простые типы: SQLite ADD COLUMN не поддерживает PK/UNIQUE без таблицы.
 */
const TABLE_COLUMNS: Record<string, Record<string, string>> = {
  CommandHistoryEntry: {
    correlationId: '"correlationId" TEXT',
  },
}

/** Уникальные индексы Prisma (@@unique) */
const UNIQUE_INDEXES: Array<{ name: string; table: string; columns: string }> = [
  { name: 'SkipMark_accountKey_animeId_dubbing_type_key', table: 'SkipMark', columns: '"accountKey", "animeId", "dubbing", "type"' },
  { name: 'VoiceAlias_targetType_targetName_alias_key', table: 'VoiceAlias', columns: '"targetType", "targetName", "alias"' },
  { name: 'WatchProgressEntry_accountKey_animeId_key', table: 'WatchProgressEntry', columns: '"accountKey", "animeId"' },
]

let ensurePromise: Promise<{ ok: boolean; createdTables: string[]; addedColumns: string[]; createdIndexes: string[]; error?: string }> | null = null

async function runEnsure() {
  const createdTables: string[] = []
  const addedColumns: string[] = []
  const createdIndexes: string[] = []

  // 1) таблицы
  for (const [table, ddl] of Object.entries(DDL_TABLES)) {
    const exists = await db.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      table,
    )
    if (!exists || exists.length === 0) {
      await db.$executeRawUnsafe(ddl)
      createdTables.push(table)
    }
  }

  // 2) колонки (для старых БД, где таблица есть, а колонки нет)
  for (const [table, cols] of Object.entries(TABLE_COLUMNS)) {
    const info = await db.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("${table}")`)
    const present = new Set((info || []).map((r) => r.name))
    for (const [col, frag] of Object.entries(cols)) {
      if (!present.has(col)) {
        await db.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN ${frag}`)
        addedColumns.push(`${table}.${col}`)
      }
    }
  }

  // 3) уникальные индексы
  for (const idx of UNIQUE_INDEXES) {
    const exists = await db.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`,
      idx.name,
    )
    if (!exists || exists.length === 0) {
      await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "${idx.name}" ON "${idx.table}"(${idx.columns})`)
      createdIndexes.push(idx.name)
    }
  }

  return { ok: true, createdTables, addedColumns, createdIndexes }
}

/**
 * Гарантировать актуальность схемы БД перед первым запросом.
 * Повторный вызов дожидается уже запущенной синхронизации (single-flight).
 */
export function ensureSqliteSchema() {
  if (!ensurePromise) {
    ensurePromise = runEnsure().catch((e) => {
      ensurePromise = null // позволяем повторить при следующем запросе
      return { ok: false, createdTables: [], addedColumns: [], createdIndexes: [], error: e instanceof Error ? e.message : String(e) }
    })
  }
  return ensurePromise
}
