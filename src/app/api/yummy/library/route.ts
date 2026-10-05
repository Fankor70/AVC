/**
 * GET /api/yummy/library — полная библиотека пользователя YummyAnime:
 * списки статусов Смотрю/В Планах/Просмотрено/Брошено/Отложено/Любимые.
 *
 * Источник данных: реальный сайт. Эндпоинт снят с бандла сайта и проверен
 * живой сессией: GET /api/users/{numericId}/lists/{listId} (listId 0..5).
 * numericUserId — ТОЛЬКО число (id470161 → 400 Arguments error, 470161 → 200).
 *
 * Web-режим (превью): серверная сессия сайта (db/yummy-session.json, 0600).
 * EXE-сборка: EXE грузит это же приложение по URL — маршрут работает так же.
 * Нет сессии/истекла — честная причина, ничего не выдумываем.
 */
import { NextResponse } from 'next/server'
import {
  fetchProfile,
  fetchUserList,
  parseLibraryItems,
  parseProfile,
} from '@/lib/sites/yummy/web-auth'
import { clearWebSession, loadWebSession } from '@/lib/sites/yummy/web-session'
import {
  YUMMY_LIST_NAMES,
  type YummyLibraryList,
  type YummyLibraryResult,
  type YummyListId,
} from '@/lib/avc/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SITE_ERROR_REASONS: Record<number, string> = {
  400: 'Сайт не принял запрос списка (Arguments error) — структура API изменилась',
  404: 'Список не найден на сайте',
}

export async function GET() {
  const session = await loadWebSession()
  if (!session) {
    const res: YummyLibraryResult = {
      available: false,
      lists: [],
      reason:
        'Войдите в аккаунт YummyAnime — библиотека (Смотрю, В Планах, Брошено…) хранится в вашем аккаунте на сайте',
      lastSync: null,
    }
    return NextResponse.json(res)
  }

  // Числовой id пользователя — из профиля (GET /api/profile). Без него списки не получить.
  const profile = await fetchProfile(session.cookie)
  if (profile.status === 401 || profile.status === 403) {
    await clearWebSession()
    const res: YummyLibraryResult = {
      available: false,
      lists: [],
      reason: 'Сессия YummyAnime истекла — войдите заново',
      lastSync: null,
    }
    return NextResponse.json(res)
  }
  if (profile.status !== 200) {
    const res: YummyLibraryResult = {
      available: false,
      lists: [],
      reason:
        profile.status === 0
          ? 'Сайт YummyAnime недоступен — попробуйте позже'
          : `Сайт ответил ошибкой (HTTP ${profile.status}) — попробуйте позже`,
      lastSync: null,
    }
    return NextResponse.json(res)
  }
  const user = parseProfile(profile.body)
  const numericId = user?.userId?.match(/^(\d+)$/)?.[1] ?? null
  if (!numericId) {
    const res: YummyLibraryResult = {
      available: false,
      lists: [],
      reason: 'Не удалось определить id пользователя для чтения библиотеки',
      lastSync: null,
    }
    return NextResponse.json(res)
  }

  // Все 6 списков параллельно; порядок фиксированный: 0,1,2,3,5,4 (Любимые последними).
  const order: YummyListId[] = [0, 1, 2, 3, 5, 4]
  const settled = await Promise.all(
    order.map(async (listId) => ({
      listId,
      ...(await fetchUserList(session.cookie, numericId, listId)),
    })),
  )

  // 401 на списках = сессия умерла между профилем и списками — честно сообщаем.
  if (settled.some((s) => s.status === 401 || s.status === 403)) {
    await clearWebSession()
    const res: YummyLibraryResult = {
      available: false,
      lists: [],
      reason: 'Сессия YummyAnime истекла — войдите заново',
      lastSync: null,
    }
    return NextResponse.json(res)
  }

  const lists: YummyLibraryList[] = []
  const failed: string[] = []
  for (const s of settled) {
    if (s.status === 200) {
      const items = parseLibraryItems(s.body)
      lists.push({
        listId: s.listId,
        name: YUMMY_LIST_NAMES[s.listId],
        count: items.length,
        items,
      })
    } else {
      failed.push(
        `${YUMMY_LIST_NAMES[s.listId]}: ${
          s.status === 0
            ? 'сайт недоступен'
            : (SITE_ERROR_REASONS[s.status] ?? `HTTP ${s.status}`)
        }`,
      )
    }
  }

  const res: YummyLibraryResult = {
    available: lists.length > 0,
    lists,
    reason:
      lists.length === 0
        ? 'Ни один список не прочитан'
        : failed.length > 0
          ? `Часть списков не прочитана: ${failed.join('; ')}`
          : null,
    lastSync: lists.length > 0 ? new Date().toISOString() : null,
  }
  return NextResponse.json(res)
}
