/**
 * Site Adapter API — единая точка доступа к слою адаптера.
 *
 *   GET /api/site/search?q=берсерк
 *   GET /api/site/section/ongoing?page=1
 *   GET /api/site/anime/70            (id)
 *   GET /api/site/anime/berserk       (slug)
 *   GET /api/site/random
 *   GET /api/site/videos/70
 *   GET /api/site/diagnostics
 */
import { NextRequest, NextResponse } from 'next/server'
import { getAdapter } from '@/lib/sites/yummy/adapter'
import { SiteSectionId } from '@/lib/avc/types'

export const dynamic = 'force-dynamic'

const VALID_SECTIONS: SiteSectionId[] = [
  'home',
  'catalog',
  'ongoing',
  'announcements',
  'schedule',
  'top100',
  'random',
]

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> },
) {
  const { path } = await params
  const [resource, arg] = path ?? []
  const adapter = getAdapter()
  const sp = req.nextUrl.searchParams

  try {
    switch (resource) {
      case 'search': {
        const q = sp.get('q')?.trim()
        if (!q) return NextResponse.json({ error: 'Параметр q обязателен' }, { status: 400 })
        const items = await adapter.searchAnime(q)
        return NextResponse.json({ query: q, items })
      }
      case 'section': {
        const section = arg as SiteSectionId
        if (!VALID_SECTIONS.includes(section)) {
          return NextResponse.json({ error: `Неизвестная секция: ${arg}` }, { status: 400 })
        }
        const page = parseInt(sp.get('page') ?? '1', 10) || 1
        const data = await adapter.getSection(section, page)
        return NextResponse.json(data)
      }
      case 'anime': {
        if (!arg) return NextResponse.json({ error: 'Нужен id или slug' }, { status: 400 })
        const details = /^\d+$/.test(arg)
          ? await adapter.getAnimeById(parseInt(arg, 10))
          : await adapter.getAnimeBySlug(arg)
        if (!details) return NextResponse.json({ error: 'Аниме не найдено' }, { status: 404 })
        return NextResponse.json(details)
      }
      case 'random': {
        const details = await adapter.getRandom()
        if (!details) return NextResponse.json({ error: 'Сайт недоступен' }, { status: 502 })
        return NextResponse.json(details)
      }
      case 'videos': {
        if (!arg || !/^\d+$/.test(arg)) {
          return NextResponse.json({ error: 'Нужен числовой id' }, { status: 400 })
        }
        const videos = await adapter.getVideos(parseInt(arg, 10))
        return NextResponse.json({ videos })
      }
      case 'diagnostics': {
        const results = await adapter.runDiagnostics()
        return NextResponse.json({ results })
      }
      default:
        return NextResponse.json({ error: `Неизвестный ресурс: ${resource}` }, { status: 404 })
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Внутренняя ошибка адаптера' },
      { status: 500 },
    )
  }
}
