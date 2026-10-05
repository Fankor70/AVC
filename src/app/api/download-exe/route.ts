/**
 * GET /api/download-exe — «Скачать EXE одной кнопкой».
 *
 * Резолвит ПОСЛЕДНИЙ релиз GitHub (HellShaftSam/AVC-AnimeVoiceCommand) и
 * возвращает прямую ссылку на .exe-ассет (portable EXE собирается CI).
 *
 * Порядок:
 *   1. AVC_EXE_URL (env) — прямая ссылка на EXE (ручной оверрайд);
 *   2. GitHub API /releases/latest c GITHUB_TOKEN (env, если задан —
 *      работает и для приватного репозитория);
 *   3. без токена — анонимный запрос API;
 *   4. не нашли релиз/ассет — ok:false с ЧЕСТНОЙ причиной и ссылкой на
 *      страницу релизов (владелец репозитория качает из своего браузера).
 *
 * Никаких фиктивных ссылок: если ассета нет — так и пишем.
 */
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const REPO = 'HellShaftSam/AVC-AnimeVoiceCommand'
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`

export interface DownloadExeInfo {
  ok: boolean
  /** Прямая ссылка на .exe-ассет (или null, если релиза нет) */
  downloadUrl: string | null
  assetName: string | null
  tagName: string | null
  publishedAt: string | null
  /** Честная причина, если скачать нельзя */
  reason: string | null
  releasesUrl: string
}

export async function GET() {
  const result: DownloadExeInfo = {
    ok: false,
    downloadUrl: null,
    assetName: null,
    tagName: null,
    publishedAt: null,
    reason: null,
    releasesUrl: RELEASES_URL,
  }

  // 1. Ручной оверрайд ссылкой
  if (process.env.AVC_EXE_URL && process.env.AVC_EXE_URL.startsWith('http')) {
    result.ok = true
    result.downloadUrl = process.env.AVC_EXE_URL
    result.assetName = process.env.AVC_EXE_URL.split('/').pop() ?? 'AVC-Anime.exe'
    result.tagName = 'manual'
    return NextResponse.json(result)
  }

  // 2-3. GitHub API (токен повышает лимит и открывает приватный репозиторий)
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'AVC-Anime-App',
  }
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  }

  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 15000)
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers,
      cache: 'no-store',
      signal: ctrl.signal,
    })
    clearTimeout(t)

    if (res.ok) {
      const release = (await res.json()) as {
        tag_name?: string
        published_at?: string
        assets?: Array<{ name?: string; browser_download_url?: string }>
      }
      const assets = Array.isArray(release.assets) ? release.assets : []
      const exe = assets.find(
        (a) => typeof a.browser_download_url === 'string' && /\.exe$/i.test(a.name ?? a.browser_download_url ?? ''),
      )
      if (exe?.browser_download_url) {
        result.ok = true
        result.downloadUrl = exe.browser_download_url
        result.assetName = exe.name ?? null
        result.tagName = release.tag_name ?? null
        result.publishedAt = release.published_at ?? null
        return NextResponse.json(result)
      }
      result.reason = 'В последнем релизе нет EXE-файла — откройте страницу релизов и проверьте ассеты'
      return NextResponse.json(result)
    }

    if (res.status === 404) {
      result.reason =
        'Релизов ещё нет (или репозиторий приватен для анонимного API). Откройте страницу релизов в своём браузере GitHub'
      return NextResponse.json(result)
    }
    if (res.status === 403) {
      result.reason =
        'GitHub API ограничил запросы (rate limit). Добавьте GITHUB_TOKEN в переменные окружения — тогда кнопка найдёт EXE сама'
      return NextResponse.json(result)
    }
    result.reason = `GitHub API ответил ошибкой (HTTP ${res.status})`
    return NextResponse.json(result)
  } catch {
    result.reason = 'GitHub недоступен — проверьте интернет и попробуйте позже'
    return NextResponse.json(result)
  }
}
