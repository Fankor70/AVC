/**
 * POST /api/debug/upload-logs — отправка диагностического отчёта владельцем
 * приложения в issues репозитория (чтобы по логам можно было разобрать,
 * что происходит на его машине: запросы, ошибки, состояние воркера).
 *
 * Токен GitHub (repo scope) вводится ОДИН раз в панели диагностики, хранится
 * только локально (localStorage браузера приложения) и НЕ сохраняется на
 * сервере: маршрут лишь проксирует запрос в GitHub API.
 */
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const REPO = process.env.AVC_GITHUB_REPO ?? 'HellShaftSam/AVC-AnimeVoiceCommand'

export async function POST(req: Request) {
  let body: { token?: string; title?: string; body?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Некорректный запрос' }, { status: 400 })
  }
  const token = String(body.token ?? '').trim()
  const text = String(body.body ?? '')
  if (token.length < 20 || text.length < 20) {
    return NextResponse.json({ ok: false, error: 'Нужны токен и текст отчёта' }, { status: 400 })
  }
  const title = String(body.title ?? '').slice(0, 120) || `AVC diagnostics ${new Date().toISOString().slice(0, 16)}`
  // GitHub issue body ≤ 65536 символов — честно обрезаем с маркером
  const cut = text.length > 60000 ? `${text.slice(0, 60000)}\n… (обрезано: ${text.length} символов всего)` : text

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'AVC-Anime-Diagnostics',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, body: cut }),
      cache: 'no-store',
    })
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 300)
      return NextResponse.json(
        { ok: false, error: `GitHub API: HTTP ${res.status} ${errText}` },
        { status: 200 },
      )
    }
    const json = (await res.json()) as { html_url?: string; number?: number }
    return NextResponse.json({ ok: true, url: json.html_url ?? null, number: json.number ?? null })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Сеть недоступна' },
      { status: 200 },
    )
  }
}
