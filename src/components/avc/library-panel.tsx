'use client'
/**
 * LibraryPanel — правая Sheet-панель «Библиотека YummyAnime».
 *
 * ДВА источника данных, честно разделённых:
 *  1. БИБЛИОТЕКА САЙТА (нужен вход): списки статусов с реального аккаунта —
 *     Смотрю / В Планах / Просмотрено / Брошено / Отложено / Любимые.
 *     Источник: GET /api/yummy/library → сайт /api/users/{id}/lists/{N}.
 *     Своя оценка (user.rating), избранное, дата следующей серии — с сайта.
 *  2. ЛОКАЛЬНЫЙ ТРЕКИНГ ПРОСМОТРА (работает всегда): приложение само
 *     запоминает какое аниме включалось и на какой серии остановились
 *     (SQLite через /api/watch-progress, изоляция по аккаунту). Сайт
 *     прогресс серий наружу не отдаёт — поэтому ведём свою запись.
 *
 * Клик по тайтлу открывает его в приложении; «Продолжить» — сразу серию.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen,
  Clock3,
  Eye,
  EyeOff,
  Flag,
  Heart,
  History,
  ListTodo,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  Star,
  X,
  ExternalLink,
} from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { avcApi } from '@/lib/avc/api'
import {
  continueWatchingFromLast,
  continueWatchProgressItem,
  openAnimeByRef,
} from '@/lib/avc/executor'
import { siteProfileUrl } from '@/lib/avc/site-urls'
import { useAvcStore } from '@/lib/avc/store'
import type {
  WatchProgressItem,
  WatchProgressResult,
  YummyLibraryItem,
  YummyLibraryResult,
  YummyListId,
} from '@/lib/avc/types'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

/** Безопасный слот аккаунта для локального трекинга (userId сайта или 'anon') */
function accountKeyOf(): string {
  const acc = useAvcStore.getState().yummyAccount
  const id = acc.state === 'loggedIn' ? acc.user?.userId : null
  return id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : 'anon'
}

/** «5 мин назад», «2 ч назад», «3 дн назад» — для записей прогресса */
function relativeTime(iso: string): string {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return ''
  const diff = Math.max(0, Date.now() - ts)
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'только что'
  if (m < 60) return `${m} мин назад`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} ч назад`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} дн назад`
  return new Date(ts).toLocaleDateString('ru-RU')
}

/** Дата выхода следующей серии (unix сек → «12 окт») */
function nextEpisodeDate(unix: number | null): string | null {
  if (!unix) return null
  const d = new Date(unix * 1000)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

/** Пилюля статуса тайтла (цвет по значению сайта) */
function StatusPill({ item }: { item: YummyLibraryItem }) {
  const alias = item.animeStatusAlias
  const label = item.animeStatus ?? null
  if (!label) return null
  const cls =
    alias === 'ongoing'
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
      : alias === 'announced'
        ? 'bg-sky-500/15 text-sky-300 border-sky-500/30'
        : 'bg-zinc-500/15 text-foreground border-zinc-500/30'
  return <span className={cn('rounded border px-1.5 py-0.5 text-[10px] leading-none', cls)}>{label}</span>
}

/** Строка локального прогресса («Продолжить просмотр») */
function ProgressRow({
  item,
  onContinue,
  onForget,
}: {
  item: WatchProgressItem
  onContinue: () => void
  onForget: () => void
}) {
  const pct =
    item.episode !== null && item.episodesTotal !== null && item.episodesTotal > 0
      ? Math.min(100, Math.round((item.episode / item.episodesTotal) * 100))
      : null
  return (
    <div className="group flex items-center gap-2.5 rounded-xl border border-border bg-card/60 p-2">
      {item.poster ? (
        <img
          src={item.poster}
          alt=""
          loading="lazy"
          className="h-14 w-10 shrink-0 rounded-lg border border-border object-cover"
        />
      ) : (
        <span className="flex h-14 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
          <Play className="h-3.5 w-3.5 text-zinc-700" aria-hidden />
        </span>
      )}
      <button
        onClick={onContinue}
        className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        aria-label={`Продолжить: ${item.title}`}
      >
        <span className="block truncate text-sm text-foreground">{item.title}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock3 className="h-3 w-3 shrink-0" aria-hidden />
          {item.episode !== null ? `серия ${item.episode}` : 'серия не включалась'}
          {item.episodesTotal !== null && item.episode !== null ? ` из ${item.episodesTotal}` : ''}
          <span aria-hidden>·</span>
          {relativeTime(item.updatedAt)}
        </span>
        {pct !== null && (
          <span className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-secondary">
            <span className="block h-full rounded-full bg-sky-400" style={{ width: `${pct}%` }} />
          </span>
        )}
      </button>
      <Button
        size="icon"
        onClick={onContinue}
        aria-label={`Продолжить просмотр: ${item.title}`}
        className="h-9 w-9 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
      >
        <Play className="h-4 w-4" aria-hidden />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        onClick={onForget}
        aria-label={`Забыть: ${item.title}`}
        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </div>
  )
}

/** Карточка тайтла из библиотеки сайта */
function LibraryCard({
  item,
  progress,
  onOpen,
}: {
  item: YummyLibraryItem
  progress: WatchProgressItem | undefined
  onOpen: () => void
}) {
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-xl border border-border bg-card/60 p-2 text-left transition-colors hover:border-sky-400/40 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {item.poster ? (
        <img
          src={item.poster}
          alt=""
          loading="lazy"
          className="h-16 w-12 shrink-0 rounded-lg border border-border object-cover"
        />
      ) : (
        <span className="flex h-16 w-12 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
          <BookOpen className="h-4 w-4 text-zinc-700" aria-hidden />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{item.title}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {item.year !== null && <span>{item.year}</span>}
          {item.type && <span aria-hidden>·</span>}
          {item.type && <span>{item.type}</span>}
          <StatusPill item={item} />
          {item.nextEpisodeAt !== null && (
            <>
              <span aria-hidden>·</span>
              <span className="text-sky-300/90">
                новая серия: {nextEpisodeDate(item.nextEpisodeAt) ?? 'скоро'}
              </span>
            </>
          )}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
          {item.ownRating !== null && (
            <span className="inline-flex items-center gap-0.5 rounded bg-sky-400/40 px-1.5 py-0.5 text-[10px] text-sky-300">
              <Star className="h-2.5 w-2.5" aria-hidden /> моя: {item.ownRating}
            </span>
          )}
          {progress?.episode !== null && progress?.episode !== undefined && (
            <span className="inline-flex items-center gap-0.5 rounded bg-zinc-700/40 px-1.5 py-0.5 text-[10px] text-foreground">
              <Play className="h-2.5 w-2.5" aria-hidden />
              вы на серии {progress.episode}
              {progress.episodesTotal !== null ? ` из ${progress.episodesTotal}` : ''}
            </span>
          )}
        </span>
      </span>
      {item.isFavorite && <Heart className="h-4 w-4 shrink-0 fill-rose-500 text-rose-500" aria-label="В любимых" />}
    </button>
  )
}

type TabKey = 'all' | YummyListId

const TAB_ICONS: Record<Exclude<TabKey, 'all'>, typeof Eye> = {
  0: Eye, // Смотрю
  1: ListTodo, // В Планах
  2: Flag, // Просмотрено
  3: EyeOff, // Брошено
  5: History, // Отложено
  4: Heart, // Любимые
}

export function LibraryPanel() {
  const open = useAvcStore((s) => s.favoritesOpen)
  const setOpen = useAvcStore((s) => s.setFavoritesOpen)
  const account = useAvcStore((s) => s.yummyAccount)
  const setAuthOpen = useAvcStore((s) => s.setAuthOpen)
  const baseUrl = useAvcStore((s) => s.settings.baseUrl)

  const [library, setLibrary] = useState<YummyLibraryResult | null>(null)
  const [progress, setProgress] = useState<WatchProgressResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<TabKey>('all')
  const [query, setQuery] = useState('')

  const loggedIn = account.state === 'loggedIn'

  /** Загрузка данных (без синхронного setState — безопасна для вызова из эффекта) */
  const fetchData = useCallback(async () => {
    const key = accountKeyOf()
    const [lib, prog] = await Promise.all([
      loggedIn ? avcApi.yummyLibrary() : Promise.resolve(null),
      avcApi.watchProgressList(key),
    ])
    if (lib) setLibrary(lib)
    setProgress(prog)
    return lib
  }, [loggedIn])

  /** Ручное обновление (кнопка) — со спиннером и toast о проблеме */
  const load = useCallback(
    async (refresh: boolean) => {
      setLoading(true)
      const lib = await fetchData()
      if (refresh && lib && !lib.available && lib.reason) {
        toast({ variant: 'destructive', description: lib.reason })
      }
      setLoading(false)
    },
    [fetchData],
  )

  // Панель открывается из разных мест через store (не через onOpenChange) —
  // при каждом открытии: сброс фильтров + загрузка. Всё внутри таймера
  // (внешний планировщик), чтобы не звать setState синхронно в теле эффекта.
  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => {
      setTab('all')
      setQuery('')
      void fetchData().catch(() => {})
    }, 0)
    return () => window.clearTimeout(t)
  }, [open, loggedIn, fetchData])

  /** Закрытие/открытие средствами самого Sheet (Escape/оверлей) */
  const handleOpenChange = (next: boolean): void => {
    setOpen(next)
  }

  const progressByAnimeId = useMemo(() => {
    const map = new Map<number, WatchProgressItem>()
    for (const it of progress?.items ?? []) map.set(it.animeId, it)
    return map
  }, [progress])

  /** Плоский список всех тайтлов библиотеки (без дублей по animeId) */
  const allItems = useMemo(() => {
    if (!library?.available) return []
    const seen = new Set<string>()
    const out: YummyLibraryItem[] = []
    for (const list of library.lists) {
      for (const item of list.items) {
        const key = item.animeId !== null ? `id${item.animeId}` : `s${item.slug ?? item.title}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(item)
      }
    }
    // Свежие добавления сверху (addedAt — unix сек)
    return out.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
  }, [library])

  const visibleItems = useMemo(() => {
    let items = allItems
    if (tab !== 'all') items = items.filter((i) => i.listId === tab || (tab === 4 && i.isFavorite))
    const q = query.trim().toLowerCase()
    if (q !== '') items = items.filter((i) => i.title.toLowerCase().includes(q))
    return items
  }, [allItems, tab, query])

  const openItem = (item: { slug: string | null; animeId: number | null; title: string }) => {
    if (!item.slug && item.animeId === null) return
    void openAnimeByRef({
      slug: item.slug ?? '',
      animeId: item.animeId,
      title: item.title,
    }).catch(() => {
      toast({ variant: 'destructive', description: 'Не удалось открыть тайтл' })
    })
    setOpen(false)
  }

  const forget = (animeId: number) => {
    void avcApi.watchProgressDelete(accountKeyOf(), animeId).then((ok) => {
      if (ok) {
        setProgress((p) =>
          p ? { ...p, items: p.items.filter((i) => i.animeId !== animeId) } : p,
        )
        toast({ description: 'Убрано из «Продолжить просмотр»' })
      }
    })
  }

  const counts = useMemo(() => {
    const map = new Map<YummyListId, number>()
    for (const list of library?.lists ?? []) map.set(list.listId, list.count)
    return map
  }, [library])

  const tabs: Array<{ key: TabKey; label: string; count: number | null }> = [
    { key: 'all', label: 'Все', count: library?.available ? allItems.length : null },
    { key: 0, label: 'Смотрю', count: counts.get(0) ?? null },
    { key: 1, label: 'В Планах', count: counts.get(1) ?? null },
    { key: 2, label: 'Просмотрено', count: counts.get(2) ?? null },
    { key: 3, label: 'Брошено', count: counts.get(3) ?? null },
    { key: 5, label: 'Отложено', count: counts.get(5) ?? null },
    { key: 4, label: 'Любимые', count: counts.get(4) ?? null },
  ]

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-3 border-border bg-background p-4 sm:max-w-md"
      >
        <SheetHeader className="p-0">
          <SheetTitle className="flex items-center gap-2 text-lg">
            <BookOpen className="h-5 w-5 text-sky-400" aria-hidden />
            Библиотека YummyAnime
          </SheetTitle>
          <SheetDescription className="text-xs text-muted-foreground">
            Списки вашего аккаунта с сайта + прогресс серий приложения
          </SheetDescription>
        </SheetHeader>

        {/* ЛОКАЛЬНЫЙ ТРЕКИНГ: продолжить просмотр (работает всегда) */}
        <div className="rounded-xl border border-border bg-card/60 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Продолжить просмотр
            </span>
            {progress?.items && progress.items.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void continueWatchingFromLast()}
                className="h-7 gap-1 px-2 text-xs text-sky-300 hover:bg-sky-400/40 hover:text-sky-200"
              >
                <Play className="h-3 w-3" aria-hidden />
                Последнее
              </Button>
            )}
          </div>
          {!progress ? (
            <div className="flex justify-center py-3">
              <Loader2 className="h-4 w-4 animate-spin text-sky-400" aria-hidden />
            </div>
          ) : progress.items.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">
              Пока пусто — включите любую серию, и приложение запомнит на какой вы остановились.
            </p>
          ) : (
            <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
              {progress.items.slice(0, 8).map((item) => (
                <ProgressRow
                  key={item.animeId}
                  item={item}
                  onContinue={() => {
                    setOpen(false)
                    void continueWatchProgressItem(item).then((res) => {
                      if (!res.success) toast({ variant: 'destructive', description: res.message })
                    })
                  }}
                  onForget={() => forget(item.animeId)}
                />
              ))}
            </div>
          )}
        </div>

        {/* БИБЛИОТЕКА САЙТА: заголовок + обновить + открыть на сайте */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Списки аккаунта
          </span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Обновить библиотеку"
              disabled={loading}
              onClick={() => void load(true)}
              className="h-9 w-9 text-muted-foreground hover:text-sky-300"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-4 w-4" aria-hidden />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Открыть профиль и библиотеку на сайте"
              onClick={() =>
                window.open(
                  siteProfileUrl(baseUrl, loggedIn ? account.user?.userId ?? null : null),
                  '_blank',
                  'noopener',
                )
              }
              className="h-9 w-9 text-muted-foreground hover:text-sky-300"
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>

        {!loggedIn ? (
          <div className="space-y-3 rounded-xl border border-border bg-card/60 p-4 text-sm">
            <p className="text-foreground">
              Списки (Смотрю, В Планах, Просмотрено, Брошено, Отложено, Любимые) хранятся в вашем
              аккаунте YummyAnime. Войдите — и они появятся здесь.
            </p>
            <Button
              onClick={() => {
                setOpen(false)
                setAuthOpen(true)
              }}
              className="min-h-11 w-full gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Войти через YummyAnime
            </Button>
          </div>
        ) : !library ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-sky-400" aria-hidden />
          </div>
        ) : !library.available ? (
          <div className="rounded-xl border border-border bg-card/60 p-4 text-sm text-foreground">
            <p className="mb-2">{library.reason ?? 'Библиотека недоступна'}</p>
            <p className="text-xs text-muted-foreground">
              Мы не показываем выдуманные данные — попробуйте обновить позже.
            </p>
          </div>
        ) : (
          <>
            {/* Табы статусов с счётчиками */}
            <div
              role="tablist"
              aria-label="Списки библиотеки"
              className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1"
            >
              {tabs.map((t) => {
                const Icon = t.key === 'all' ? Layers : TAB_ICONS[t.key as Exclude<TabKey, 'all'>]
                const active = tab === t.key
                return (
                  <button
                    key={String(t.key)}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setTab(t.key)}
                    className={cn(
                      'flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                      active
                        ? 'border-sky-400/40 bg-sky-400/40 text-sky-200'
                        : 'border-border bg-card/60 text-muted-foreground hover:border-border hover:text-foreground',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                    {t.label}
                    {t.count !== null && (
                      <span
                        className={cn(
                          'rounded-full px-1.5 py-0.5 text-[10px] leading-none',
                          active ? 'bg-sky-400/40 text-sky-200' : 'bg-secondary text-muted-foreground',
                        )}
                      >
                        {t.count}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>

            {/* Поиск по библиотеке */}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск по названию…"
              aria-label="Поиск по библиотеке"
              className="h-10 w-full rounded-xl border border-border bg-card/60 px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-sky-400/40 focus:outline-none"
            />

            {/* Список тайтлов */}
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              {library.reason && (
                <p className="mb-2 rounded-lg border border-sky-400/40 bg-sky-400/40 p-2 text-xs text-sky-200/80">
                  {library.reason}
                </p>
              )}
              {visibleItems.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {query.trim() !== ''
                    ? 'Ничего не найдено'
                    : tab === 'all'
                      ? 'Списки пока пусты — добавляйте тайтлы на сайте или голосом («добавь в смотрю»)'
                      : 'В этом списке пока пусто'}
                </p>
              ) : (
                <ul className="space-y-2 pb-2">
                  {visibleItems.map((item, i) => (
                    <li key={`${item.animeId ?? item.slug ?? i}-${i}`}>
                      <LibraryCard
                        item={item}
                        progress={
                          item.animeId !== null
                            ? progressByAnimeId.get(item.animeId)
                            : undefined
                        }
                        onOpen={() => openItem(item)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
