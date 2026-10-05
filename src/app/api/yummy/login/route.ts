/**
 * POST /api/yummy/login — РЕАЛЬНЫЙ вход в аккаунт YummyAnime (режим превью).
 *
 * Пользователь вводит логин/пароль в приложении → сервер отправляет их
 * напрямую на сервер сайта (POST /api/profile/login, точный запрос самого
 * сайта), получает cookie-сессию, проверяет её через GET /api/profile и
 * сохраняет ТОЛЬКО на сервере (db/yummy-session.json, 0600, вне git).
 * Пароль нигде не хранится и не логируется.
 *
 * DELETE /api/yummy/login — выход: POST /api/profile/logout в контексте
 * сессии (сайт инвалидирует сам) + удаление локального файла сессии.
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  fetchProfile,
  parseProfile,
  siteLogin,
  siteLogout,
} from '@/lib/sites/yummy/web-auth'
import { clearWebSession, loadWebSession, saveWebSession } from '@/lib/sites/yummy/web-session'
import type { YummyAccountSnapshot } from '@/lib/avc/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Признаки требования капчи от сайта (420 / текст про капчу) */
function looksLikeCaptcha(status: number, body: unknown): boolean {
  if (status === 420) return true
  const rec = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const hay = `${String(rec.error ?? '')} ${String(rec.error_title ?? '')}`.toLowerCase()
  return hay.includes('капч') || hay.includes('captcha') || hay.includes('recaptcha')
}

function siteErrorText(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null) {
    const rec = body as Record<string, unknown>
    if (typeof rec.error === 'string' && rec.error.trim() !== '') return rec.error.trim()
  }
  return fallback
}

export async function POST(req: NextRequest) {
  let login = ''
  let password = ''
  try {
    const body = (await req.json()) as { login?: unknown; password?: unknown }
    login = typeof body.login === 'string' ? body.login.trim() : ''
    password = typeof body.password === 'string' ? body.password : ''
  } catch {
    return NextResponse.json({ ok: false, message: 'Некорректный запрос' }, { status: 400 })
  }

  if (login.length < 2 || login.length > 120 || password.length < 1 || password.length > 128) {
    return NextResponse.json(
      { ok: false, message: 'Введите логин (e-mail или ник) и пароль от сайта YummyAnime' },
      { status: 400 },
    )
  }

  // Реальный логин на сайт
  let result
  try {
    result = await siteLogin(login, password)
  } catch {
    return NextResponse.json(
      {
        ok: false,
        message: 'Сайт YummyAnime недоступен — проверьте интернет и попробуйте позже',
      },
      { status: 502 },
    )
  }

  if (result.status === 200) {
    // Сайт подтвердил логин — проверяем сессию чтением профиля (тот же сигнал,
    // которым сайт сам определяет «вход выполнен»)
    const prof = await fetchProfile(result.cookie)
    if (prof.status === 200) {
      const user = parseProfile(prof.body)
      await saveWebSession({
        cookie: result.cookie,
        savedAt: Date.now(),
        username: user?.username ?? null,
      })
      const snap: YummyAccountSnapshot = {
        state: 'loggedIn',
        user: user ?? { userId: null, username: null, displayName: null, avatarUrl: null },
        lastSync: new Date().toISOString(),
        source: 'live',
        message: null,
      }
      return NextResponse.json({ ok: true, snapshot: snap })
    }
    // 200 логина, но профиль не читается — честно: сайт не подтвердил сессию
    return NextResponse.json(
      {
        ok: false,
        message:
          'Сайт вернул успех, но сессия не подтвердилась — попробуйте войти ещё раз или через EXE-сборку',
      },
      { status: 502 },
    )
  }

  if (looksLikeCaptcha(result.status, result.body)) {
    return NextResponse.json(
      {
        ok: false,
        captchaRequired: true,
        message:
          'Сайт запросил капчу при входе. Подождите немного и повторите, либо войдите на сайте в EXE-сборке / браузере',
      },
      { status: 200 },
    )
  }

  if (result.status === 401 || result.status === 403) {
    // Точный текст сайта: «Пользователь с таким логином не найден»,
    // «Неправильный логин!» и т.п. — показываем как есть
    return NextResponse.json(
      { ok: false, message: siteErrorText(result.body, 'Сайт отклонил вход (неверный логин или пароль)') },
      { status: 200 },
    )
  }

  return NextResponse.json(
    {
      ok: false,
      message: `Сайт ответил ошибкой входа (HTTP ${result.status}) — попробуйте позже`,
    },
    { status: 200 },
  )
}

export async function DELETE() {
  // Выход ЧЕРЕЗ САЙТ (best-effort), затем удалить локальную сессию
  const session = await loadWebSession()
  if (session) {
    await siteLogout(session.cookie).catch(() => 0)
  }
  await clearWebSession()
  const snap: YummyAccountSnapshot = {
    state: 'loggedOut',
    user: null,
    lastSync: new Date().toISOString(),
    source: 'live',
    message: null,
  }
  return NextResponse.json({ ok: true, snapshot: snap })
}
