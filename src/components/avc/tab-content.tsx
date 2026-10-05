'use client'
/**
 * TabContent — рендер активной вкладки по kind: home / section / search / anime.
 */
import { useEffect, useState } from 'react'
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Dices,
  Loader2,
  SearchX,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { AnimeGrid, AnimeGridSkeleton } from './anime-grid'
import { AnimeView } from './anime-view'
import { executeText } from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import { AnimeCard, BrowserTab, SectionPage } from '@/lib/avc/types'

// --- Главная -----------------------------------------------------------------

interface DiagResult {
  name: string
  ok: boolean
  detail: string
}

const HINT_CHIPS: string[] = [
  'Открой топ сто',
  'Покажи онгоинги',
  'Найди Берсерк',
  'Следующая серия',
]

function HomeView() {
  const [diag, setDiag] = useState<DiagResult[] | null>(null)
  const [diagLoading, setDiagLoading] = useState(false)
  const [diagError, setDiagError] = useState<string | null>(null)

  const runDiagnostics = async () => {
    setDiagLoading(true)
    setDiagError(null)
    try {
      const res = await fetch('/api/site/diagnostics')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { results?: DiagResult[] }
      setDiag(data.results ?? [])
    } catch (e) {
      setDiagError(e instanceof Error ? e.message : 'Ошибка диагностики')
    } finally {
      setDiagLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl py-6">
      <div className="text-center">
        <h2 className="bg-gradient-to-r from-sky-200 via-sky-400 to-rose-400 bg-clip-text text-2xl font-bold text-transparent md:text-4xl">
          Скажите команду или нажмите микрофон
        </h2>
        <p className="mt-3 text-sm text-muted-foreground md:text-base">
          Голосовое управление аниме-сайтом: поиск, каталоги, серии, озвучки, плеер и вкладки.
          Удерживайте <kbd className="rounded border border-border bg-card px-1.5 py-0.5 text-xs">Ctrl + Space</kbd> или кнопку микрофона внизу.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {HINT_CHIPS.map((chip) => (
            <button
              key={chip}
              onClick={() => void executeText(chip, 'text')}
              className="min-h-11 rounded-full border border-border bg-card/60 px-4 text-sm text-foreground transition-all hover:border-sky-400/40 hover:text-sky-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              «{chip}»
            </button>
          ))}
        </div>
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {[
          { icon: SearchX, title: 'Поиск', text: '«Найди берсерк», «открой клейм» — совпадения покажутся списком: скажите номер.' },
          { icon: Sparkles, title: 'Сериалы', text: '«Следующая серия», «включи пятую», «озвучка anidub», «назад на 30 секунд».' },
          { icon: Dices, title: 'Витрина', text: '«Открой топ сто», «покажи онгоинги», «открой случайное», «расписание».' },
          { icon: Loader2, title: 'Плеер и вкладки', text: '«Пауза», «громкость 50», «полный экран», «новая вкладка», «вкладка три».' },
        ].map(({ icon: Icon, title, text }) => (
          <div
            key={title}
            className="rounded-xl border border-border bg-card/60 p-4 transition-colors hover:border-border"
          >
            <div className="flex items-center gap-2 text-sky-400">
              <Icon className="h-5 w-5" aria-hidden />
              <span className="font-semibold text-foreground">{title}</span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{text}</p>
          </div>
        ))}
      </div>

      <div className="mt-8 text-center">
        <Button
          variant="outline"
          onClick={() => void runDiagnostics()}
          disabled={diagLoading}
          className="min-h-11 border-border bg-card/60 hover:border-sky-400/40 hover:text-sky-300"
        >
          {diagLoading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Диагностика сайта
        </Button>
        {diagError && (
          <p className="mt-3 text-sm text-rose-400">✗ {diagError}</p>
        )}
        {diag && (
          <ul className="mx-auto mt-4 max-w-md space-y-1.5 text-left">
            {diag.map((d) => (
              <li
                key={d.name}
                className="flex items-start gap-2 rounded-lg border border-border bg-card/60 px-3 py-2 text-sm"
              >
                {d.ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden />
                )}
                <span className="min-w-0">
                  <span className="text-foreground">{d.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{d.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// --- Секция ------------------------------------------------------------------

const PAGE_SIZE_FALLBACK = 1

function SectionView({ tab }: { tab: BrowserTab }) {
  const patchTab = useAvcStore((s) => s.patchTab)
  const pushBackStack = useAvcStore((s) => s.pushBackStack)
  const bumpReload = useAvcStore((s) => s.bumpReload)
  const reloadCounter = useAvcStore((s) => s.tabReloadCounter[tab.id] ?? 0)
  const [data, setData] = useState<SectionPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedKey, setLoadedKey] = useState('')

  const section = typeof tab.payload.section === 'string' ? tab.payload.section : 'catalog'
  const page = typeof tab.payload.page === 'number' ? tab.payload.page : PAGE_SIZE_FALLBACK
  const requestKey = `${section}:${page}:${reloadCounter}`
  const loading = loadedKey !== requestKey

  useEffect(() => {
    let cancelled = false
    fetch(`/api/site/section/${encodeURIComponent(section)}?page=${page}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as SectionPage
      })
      .then((d) => {
        if (cancelled) return
        setData(d)
        setError(null)
        setLoadedKey(requestKey)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Ошибка загрузки секции')
        setLoadedKey(requestKey)
      })
    return () => {
      cancelled = true
    }
  }, [section, page, reloadCounter, requestKey])

  useEffect(() => {
    if (data && data.title && data.title !== tab.title) {
      patchTab(tab.id, { title: data.title })
    }
  }, [data, tab.id, tab.title, patchTab])

  const goToPage = (next: number) => {
    if (next < 1) return
    if (data?.totalPages != null && next > data.totalPages) return
    pushBackStack(tab.id, { kind: tab.kind, title: tab.title, payload: tab.payload })
    patchTab(tab.id, { payload: { ...tab.payload, page: next } })
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">{data?.title ?? tab.title}</h2>
        <div className="flex items-center gap-2">
          {data?.source === 'demo' && (
            <Badge className="border border-sky-400/40 bg-sky-400/40 text-sky-300">
              Демо-данные (сайт недоступен)
            </Badge>
          )}
          {data?.totalPages != null && data.totalPages > 1 && (
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="icon"
                aria-label="Предыдущая страница"
                disabled={page <= 1}
                onClick={() => goToPage(page - 1)}
                className="h-11 w-11 border-border bg-card/60"
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
              <span className="min-w-14 text-center text-sm text-muted-foreground">
                {page} / {data.totalPages}
              </span>
              <Button
                variant="outline"
                size="icon"
                aria-label="Следующая страница"
                disabled={data.totalPages !== null && page >= data.totalPages}
                onClick={() => goToPage(page + 1)}
                className="h-11 w-11 border-border bg-card/60"
              >
                <ChevronRight className="h-5 w-5" />
              </Button>
            </div>
          )}
        </div>
      </div>

      {loading && <AnimeGridSkeleton />}
      {!loading && error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-6 text-center text-sm text-rose-300">
          ✗ {error}
          <div className="mt-3">
            <Button
              variant="outline"
              onClick={() => bumpReload(tab.id)}
              className="min-h-11 border-border"
            >
              Повторить
            </Button>
          </div>
        </div>
      )}
      {!loading && !error && data && <AnimeGrid items={data.items} />}
      {!loading && !error && data && data.items.length === 0 && (
        <p className="py-10 text-center text-sm text-muted-foreground">Секция пуста</p>
      )}
    </div>
  )
}

// --- Поиск ---------------------------------------------------------------------

function SearchView({ tab }: { tab: BrowserTab }) {
  const query = typeof tab.payload.query === 'string' ? tab.payload.query : ''
  const reloadCounter = useAvcStore((s) => s.tabReloadCounter[tab.id] ?? 0)
  const [items, setItems] = useState<AnimeCard[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loadedKey, setLoadedKey] = useState('')

  const requestKey = `${query}:${reloadCounter}`
  const loading = loadedKey !== requestKey

  useEffect(() => {
    let cancelled = false
    fetch(`/api/site/search?q=${encodeURIComponent(query)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as { items?: AnimeCard[] }
      })
      .then((d) => {
        if (cancelled) return
        setItems(d.items ?? [])
        setError(null)
        setLoadedKey(requestKey)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Ошибка поиска')
        setLoadedKey(requestKey)
      })
    return () => {
      cancelled = true
    }
  }, [query, reloadCounter, requestKey])

  return (
    <div>
      <h2 className="mb-4 text-lg font-bold">
        Результаты: <span className="text-sky-300">{query}</span>
      </h2>
      {loading && <AnimeGridSkeleton />}
      {!loading && error && <p className="text-sm text-rose-400">✗ {error}</p>}
      {!loading && !error && items.length === 0 && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          Ничего не найдено по запросу «{query}»
        </p>
      )}
      {!loading && !error && items.length > 0 && <AnimeGrid items={items} />}
    </div>
  )
}

// --- переключатель ---------------------------------------------------------------

export function TabContent({ tab }: { tab: BrowserTab }) {
  switch (tab.kind) {
    case 'home':
      return <HomeView />
    case 'section':
      return <SectionView tab={tab} />
    case 'search':
      return <SearchView tab={tab} />
    case 'anime':
      return <AnimeView tab={tab} />
    default:
      return <HomeView />
  }
}
