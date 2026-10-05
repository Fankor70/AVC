'use client'
/**
 * AnimeView — вкладка аниме: постер, инфо, бейджи, действия аккаунта,
 * озвучки, пагинированная сетка серий, диалог «Серии» (ShowEpisodes) и плеер.
 *
 * РЕАЛЬНЫЕ действия аккаунта (спецификация I §9): статусы списка, избранное и
 * оценка выполняются ВНУТРИ постоянной сессии сайта через IPC-мост (EXE).
 * Без сессии — честная просьба войти (диалог входа открывается сам).
 *
 * Сетка серий: пагинация по 60 кнопок вместо «спрятанного» max-h-64 скролла
 * (EPISODE_PARSER_AUDIT §3 п.1) — голосовой пользователь добирается до любой
 * серии командами «вниз» (голос-скролл) и «серия N».
 */
import { useEffect, useMemo, useState } from 'react'
import { Check, ExternalLink, Film, Heart, Play, RotateCw, Star } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Player } from './player'
import { toast } from '@/hooks/use-toast'
import {
  executeCommand,
  getCachedDetails,
  maxEpisodeOf,
  syncPlaybackToDetails,
} from '@/lib/avc/executor'
import { avcApi } from '@/lib/avc/api'
import { useAvcStore } from '@/lib/avc/store'
import { LIBRARY_STATUSES } from '@/lib/avc/types'
import type { AnimeDetails, BrowserTab, WatchProgressItem, YummyAnimeOwnState } from '@/lib/avc/types'
import { VoiceCommandType } from '@/lib/avc/types'
import { cn } from '@/lib/utils'

/** Кнопок серий на страницу (аудит: ~48–60 видимых кнопок = «57–58 серий») */
const EPISODES_PER_PAGE = 60

/** Подписи шкалы сайта (модалка rating-list: 10 «шедевр» … 1 «ничтожно») */
const RATE_TITLES: Record<number, string> = {
  10: 'шедевр',
  9: 'великолепно',
  8: 'очень хорошо',
  7: 'хорошо',
  6: 'неплохо',
  5: 'посредственно',
  4: 'никак',
  3: 'плохо',
  2: 'ужасно',
  1: 'ничтожно',
}

export function AnimeView({ tab }: { tab: BrowserTab }) {
  const playback = useAvcStore((s) => s.playback)
  const patchTab = useAvcStore((s) => s.patchTab)
  const bumpReload = useAvcStore((s) => s.bumpReload)
  const reloadCounter = useAvcStore((s) => s.tabReloadCounter[tab.id] ?? 0)
  const [details, setDetails] = useState<AnimeDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedKey, setLoadedKey] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [localProgress, setLocalProgress] = useState<WatchProgressItem | null>(null)
  const accountState = useAvcStore((s) => s.yummyAccount.state)

  const slug = typeof tab.payload.slug === 'string' ? tab.payload.slug : null
  const animeId = typeof tab.payload.animeId === 'number' ? tab.payload.animeId : null
  const requestKey = `${slug ?? ''}|${animeId ?? ''}|${reloadCounter}`
  const loading = loadedKey !== requestKey

  useEffect(() => {
    let cancelled = false
    const cached = getCachedDetails(animeId, slug)
    const key = slug ?? (animeId !== null ? String(animeId) : '')
    const work: Promise<AnimeDetails> = cached
      ? Promise.resolve(cached)
      : key
        ? fetch(`/api/site/anime/${encodeURIComponent(key)}`).then(async (r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            return (await r.json()) as AnimeDetails
          })
        : Promise.reject(new Error('Не указан идентификатор аниме'))
    work
      .then((d) => {
        if (cancelled) return
        setDetails(d)
        setError(null)
        setLoadedKey(requestKey)
        syncPlaybackToDetails(d)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setDetails(null)
        setError(e instanceof Error ? e.message : 'Ошибка загрузки аниме')
        setLoadedKey(requestKey)
      })
    return () => {
      cancelled = true
    }
  }, [slug, animeId, reloadCounter, requestKey])

  useEffect(() => {
    if (details && details.title && details.title !== tab.title) {
      patchTab(tab.id, { title: details.title })
    }
  }, [details, tab.id, tab.title, patchTab])

  // Своё состояние тайтла (список/избранное/оценка) → подсветка кнопок.
  // Читается при загрузке и каждом входе в аккаунт; после действий состояние
  // кладёт в стор executor из ответа сайта (без повторного чтения страницы).
  const detailsSlug = details?.slug ?? null
  const animeIdNum = details?.animeId ?? null
  useEffect(() => {
    if (!detailsSlug || animeIdNum === null) return
    if (accountState !== 'loggedIn') {
      useAvcStore.getState().setOwnAnimeState(null)
      return
    }
    let cancelled = false
    void avcApi
      .animeOwnState(detailsSlug)
      .then((state) => {
        if (cancelled || !state) return
        useAvcStore.getState().setOwnAnimeState({ animeId: animeIdNum, state })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [detailsSlug, animeIdNum, accountState])

  // Локальный трекинг: если этот тайтл уже смотрели — подсказать где остановились
  // (подсказка видна пока серия не включена; после включения playback.currentEpisode !== null)
  useEffect(() => {
    if (animeId === null) return
    let cancelled = false
    const acc = useAvcStore.getState().yummyAccount
    const id = acc.state === 'loggedIn' ? acc.user?.userId : null
    const accountKey = id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : 'anon'
    void avcApi
      .watchProgressList(accountKey)
      .then((res) => {
        if (cancelled) return
        setLocalProgress(res.items.find((i) => i.animeId === animeId) ?? null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [animeId])

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-col gap-5 sm:flex-row">
          <Skeleton className="aspect-[3/4] w-full rounded-xl bg-card sm:w-44" />
          <div className="flex-1 space-y-3">
            <Skeleton className="h-7 w-3/4 rounded bg-card" />
            <Skeleton className="h-4 w-1/2 rounded bg-card" />
            <Skeleton className="h-24 w-full rounded bg-card" />
          </div>
        </div>
      </div>
    )
  }

  if (error || !details) {
    return (
      <div className="mx-auto max-w-5xl rounded-xl border border-rose-500/30 bg-rose-500/5 p-6 text-center text-sm text-rose-300">
        ✗ {error ?? 'Аниме не найдено'}
        <div className="mt-3">
          <Button
            variant="outline"
            onClick={() => bumpReload(tab.id)}
            className="min-h-11 border-border"
          >
            <RotateCw className="h-4 w-4" aria-hidden />
            Повторить
          </Button>
        </div>
      </div>
    )
  }

  const maxEp = maxEpisodeOf(details)
  const desc = details.description ?? ''
  const currentEp = playback.currentEpisode
  const isDemo = details.source === 'demo'

  const pickEpisode = (n: number) => {
    void executeCommand({
      type: VoiceCommandType.SelectEpisode,
      params: { episode: n },
      confidence: 1,
      label: `Серия ${n}`,
    })
  }

  // --- Статусы/избранное/оценка — РЕАЛЬНЫЕ действия через сессию сайта -----
  // Действия профиля обязаны давать ВИДНЫЙ результат: раньше результат
  // executeCommand выбрасывался — клик выглядел «мёртвым» (ни успеха,
  // ни ошибки, ни просьбы войти). Теперь каждый результат виден.
  const ACCOUNT_ACT_TYPES = new Set([
    VoiceCommandType.SetWatchStatus,
    VoiceCommandType.RemoveWatchStatus,
    VoiceCommandType.ToggleFavorite,
    VoiceCommandType.RateAnime,
    VoiceCommandType.RemoveRating,
  ])
  const act = (
    type: VoiceCommandType,
    params: Record<string, string | number | boolean>,
    label: string,
  ) => {
    void executeCommand({ type, params, confidence: 1, label }).then((result) => {
      if (!ACCOUNT_ACT_TYPES.has(type)) return // остальные сами показывают toast
      useAvcStore.getState().setVoiceMessage(result.message)
      if (result.success) {
        toast({ description: `✓ ${result.message}` })
      } else {
        toast({ variant: 'destructive', description: result.message })
      }
    })
  }

  const openOnSite = () => {
    const base = useAvcStore.getState().settings.baseUrl.replace(/\/+$/, '')
    if (details.slug) window.open(`${base}/catalog/item/${details.slug}`, '_blank', 'noopener')
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-col gap-5 sm:flex-row">
        {details.poster ? (
          <img
            src={details.poster}
            alt={details.title}
            loading="lazy"
            className="aspect-[3/4] w-full shrink-0 rounded-xl border border-border object-cover sm:w-44"
          />
        ) : (
          <div className="flex aspect-[3/4] w-full shrink-0 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground sm:w-44">
            <Film className="h-8 w-8" aria-hidden />
          </div>
        )}

        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-bold md:text-2xl">
            {details.title}
            {isDemo && (
              <Badge className="border border-rose-400/40 bg-rose-400/10 text-rose-300">
                ДЕМО-ДАННЫЕ — сайт недоступен
              </Badge>
            )}
          </h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {details.year !== null && (
              <Badge variant="outline" className="border-border text-foreground">
                {details.year}
              </Badge>
            )}
            {details.rating !== null && details.rating > 0 && (
              <Badge className="border border-sky-400/40 bg-sky-400/40 text-sky-300">
                <Star className="h-3 w-3" aria-hidden />
                {details.rating.toFixed(1)}
              </Badge>
            )}
            {details.status && (
              <Badge variant="outline" className="border-border text-foreground">
                {details.status}
              </Badge>
            )}
            {details.type && (
              <Badge variant="outline" className="border-border text-foreground">
                {details.type}
              </Badge>
            )}
            {details.genres.slice(0, 5).map((g) => (
              <Badge key={g} variant="outline" className="border-border text-muted-foreground">
                {g}
              </Badge>
            ))}
          </div>

          {desc && (
            <div className="mt-3">
              <p className={cn('leading-relaxed text-foreground', !expanded && 'line-clamp-4')}>
                {desc}
              </p>
              {desc.length > 180 && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="mt-1 text-xs text-sky-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  {expanded ? 'Свернуть' : 'Показать полностью'}
                </button>
              )}
            </div>
          )}

          <AccountActionBar
            details={details}
            onAct={act}
            onOpenSite={openOnSite}
          />

          {/* Локальный трекинг: «вы останавливались на серии N» — до включения серии */}
          {localProgress && localProgress.episode !== null && playback.currentEpisode === null && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-sky-400/40 bg-sky-400/40 p-2.5 text-sm">
              <Play className="h-4 w-4 shrink-0 text-sky-300" aria-hidden />
              <span className="text-foreground">
                Вы смотрели здесь: серия{' '}
                <span className="font-semibold text-sky-300">{localProgress.episode}</span>
                {localProgress.episodesTotal !== null && (
                  <span className="text-muted-foreground"> из {localProgress.episodesTotal}</span>
                )}
              </span>
              <Button
                size="sm"
                onClick={() =>
                  act(
                    VoiceCommandType.SelectEpisode,
                    { episode: localProgress.episode as number },
                    `Продолжить с серии ${localProgress.episode}`,
                  )
                }
                className="min-h-9 gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Продолжить с {localProgress.episode}
              </Button>
            </div>
          )}

          <p className="mt-3 text-sm text-muted-foreground">
            Серия <span className="font-semibold text-sky-300">{currentEp ?? '—'}</span> из{' '}
            {maxEp > 0 ? maxEp : '—'} · Озвучка:{' '}
            <span className="text-foreground">{playback.currentDub ?? 'не выбрана'}</span>
          </p>

          {details.dubs.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">
                Озвучки (в скобках — серий в этой озвучке)
              </div>
              <div className="flex flex-wrap gap-2">
                {details.dubs.map((d) => {
                  const active = playback.currentDub === d.name
                  return (
                    <button
                      key={d.name}
                      onClick={() =>
                        act(
                          VoiceCommandType.SelectVoice,
                          { dub: d.shortName },
                          `Озвучка ${d.shortName}`,
                        )
                      }
                      aria-pressed={active}
                      className={cn(
                        'min-h-11 rounded-full border px-3 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                        active
                          ? 'border-sky-400 bg-sky-400/40 text-sky-300 shadow-[0_0_14px_rgba(56, 189, 248,0.15)]'
                          : 'border-border bg-card/60 text-foreground hover:border-zinc-500',
                      )}
                    >
                      {d.shortName}
                      {d.episodes.length > 0 && (
                        <span className="ml-1 text-muted-foreground">· {d.episodes.length} эп.</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {maxEp > 0 && (
        <div className="mt-6">
          <EpisodeGrid
            title="Серии"
            maxEp={maxEp}
            totalCount={details.episodesTotal && details.episodesTotal > 0 ? details.episodesTotal : null}
            currentEp={currentEp}
            onPick={pickEpisode}
          />
        </div>
      )}

      <div className="mt-6">
        <Player />
      </div>

      <EpisodesDialog details={details} maxEp={maxEp} />
    </div>
  )
}

// --- панель действий аккаунта ------------------------------------------------

function AccountActionBar({
  details,
  onAct,
  onOpenSite,
}: {
  details: AnimeDetails
  onAct: (type: VoiceCommandType, params: Record<string, string | number | boolean>, label: string) => void
  onOpenSite: () => void
}) {
  const account = useAvcStore((s) => s.yummyAccount)
  const ownEntry = useAvcStore((s) => s.ownAnimeState)
  const loggedIn = account.state === 'loggedIn'
  const username = account.user?.username ?? null
  // Своё состояние тайтла: активный список, избранное, оценка — иначе подсветить
  // «поставил или нет» невозможно (урок: «ни звездочки ни сердечки не видны»)
  const own: YummyAnimeOwnState | null =
    ownEntry && ownEntry.animeId === details.animeId ? ownEntry.state : null
  const favActive = own?.isFavorite === true
  const rated = typeof own?.rating === 'number' && own.rating >= 1 && own.rating <= 10

  return (
    <div className="mt-4 rounded-xl border border-border bg-card/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {loggedIn && username
            ? `Аккаунт YummyAnime: ${username}`
            : 'Списки, избранное и оценки — в вашем аккаунте YummyAnime'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenSite}
          aria-label="Открыть страницу тайтла на сайте"
          className="min-h-9 gap-1.5 px-2 text-xs text-muted-foreground hover:text-sky-300"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          На сайте
        </Button>
      </div>

      {/* Статусы списка (реестр сайта: Смотрю/В Планах/Просмотрено/Брошено/Отложено).
          Активный статус подсвечен и помечен aria-pressed — видно, что стоит, и его можно снять. */}
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Статус просмотра">
        {LIBRARY_STATUSES.map((s) => {
          const active = own?.listId === s.id
          return (
            <Button
              key={s.id}
              variant="outline"
              size="sm"
              onClick={() =>
                onAct(VoiceCommandType.SetWatchStatus, { status: s.alias }, `Статус: ${s.title}`)
              }
              aria-pressed={active}
              aria-label={`${active ? 'Стоит в списке' : 'Добавить'} «${details.title}» — «${s.title}»`}
              className={cn(
                'min-h-9 border-border px-2.5 text-xs',
                active
                  ? 'border-sky-400/70 bg-sky-400/15 text-sky-200'
                  : 'bg-card/60 text-foreground hover:border-sky-400/40 hover:text-sky-300',
              )}
            >
              {active && <Check className="h-3.5 w-3.5" aria-hidden />}
              {s.title}
            </Button>
          )
        })}
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            onAct(
              VoiceCommandType.ToggleFavorite,
              { favorite: !favActive },
              favActive ? 'Убрать из Любимых' : 'В Любимые',
            )
          }
          aria-pressed={favActive}
          aria-label={`${favActive ? 'Убрать из' : 'Добавить в'} Любимые «${details.title}»`}
          className={cn(
            'min-h-9 gap-1 border-border px-2.5 text-xs',
            favActive
              ? 'border-rose-400/70 bg-rose-400/15 text-rose-300'
              : 'bg-card/60 text-foreground hover:border-rose-400/60 hover:text-rose-300',
          )}
        >
          <Heart
            className={cn('h-3.5 w-3.5', favActive && 'fill-rose-500 text-rose-400')}
            aria-hidden
          />
          {favActive ? 'В Любимых' : 'Любимое'}
        </Button>
        {own?.listId !== null && own?.listId !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onAct(VoiceCommandType.RemoveWatchStatus, {}, 'Убрать из списка')}
            aria-label="Убрать тайтл из всех списков"
            className="min-h-9 px-2 text-xs text-muted-foreground hover:text-rose-300"
          >
            Убрать из списка
          </Button>
        )}
      </div>

      {/* Оценка 1..10 (шкала сайта): текущая оценка видна в селекте и залитой звезде */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Star
          className={cn('h-4 w-4', rated ? 'fill-sky-300 text-sky-300' : 'text-sky-300')}
          aria-hidden
        />
        <Select
          value={rated ? String(own?.rating) : ''}
          onValueChange={(v: string) => {
            const n = parseInt(v, 10)
            if (Number.isInteger(n) && n >= 1 && n <= 10) {
              onAct(VoiceCommandType.RateAnime, { rating: n }, `Оценка ${n} из 10`)
            }
          }}
        >
          <SelectTrigger
            aria-label={rated ? `Моя оценка ${own?.rating} из 10 — изменить` : 'Поставить оценку от 1 до 10'}
            className={cn(
              'h-9 w-44 border-border bg-card/60 text-xs',
              rated ? 'border-sky-400/70 text-sky-200' : 'text-foreground',
            )}
          >
            <SelectValue placeholder={rated ? `Моя оценка: ${own?.rating} из 10` : 'Оценить (1–10)'} />
          </SelectTrigger>
          <SelectContent className="border-border bg-card">
            {[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => (
              <SelectItem key={n} value={String(n)} className="text-xs text-foreground">
                {n} — {RATE_TITLES[n]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onAct(VoiceCommandType.RemoveRating, {}, 'Убрать оценку')}
          aria-label="Убрать мою оценку"
          className="min-h-9 px-2 text-xs text-muted-foreground hover:text-rose-300"
        >
          Убрать оценку
        </Button>
      </div>
    </div>
  )
}

// --- пагинированная сетка серий ----------------------------------------------

function EpisodeGrid({
  title,
  maxEp,
  totalCount,
  currentEp,
  onPick,
}: {
  title: string
  maxEp: number
  /** Заявленное число серий из /api/anime/{id} (count, а для онгоингов aired) */
  totalCount: number | null
  currentEp: number | null
  onPick: (n: number) => void
}) {
  const totalPages = Math.max(1, Math.ceil(maxEp / EPISODES_PER_PAGE))
  const [page, setPage] = useState(1)
  const [lastEp, setLastEp] = useState<number | null>(currentEp)
  // Номер серии вне текущей страницы → переход на её страницу (adjust-during-render,
  // https://react.dev/learn/you-might-not-need-an-effect)
  if (currentEp !== lastEp) {
    setLastEp(currentEp)
    if (currentEp !== null && currentEp >= 1 && currentEp <= maxEp) {
      const epPage = Math.ceil(currentEp / EPISODES_PER_PAGE)
      const cur = Math.min(Math.max(page, 1), totalPages)
      if (epPage !== cur) setPage(epPage)
    }
  }
  const safePage = Math.min(Math.max(page, 1), totalPages)
  const from = (safePage - 1) * EPISODES_PER_PAGE + 1
  const to = Math.min(maxEp, safePage * EPISODES_PER_PAGE)
  const eps = useMemo(
    () => Array.from({ length: to - from + 1 }, (_, i) => from + i),
    [from, to],
  )

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
        {/* Честный счётчик: заявленное число серий ≠ позиций в озвучке (аудит §3 п.2б) */}
        <p className="text-xs text-muted-foreground">
          Серий: <span className="font-semibold text-foreground">{totalCount && totalCount > 0 ? totalCount : maxEp}</span>
          {totalCount && totalCount > 0 && totalCount !== maxEp && (
            <span> (доступно {maxEp})</span>
          )}
          {totalPages > 1 && (
            <span className="ml-2">
              · страница {safePage} из {totalPages}
            </span>
          )}
        </p>
      </div>
      <div className="grid grid-cols-6 gap-2 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12">
        {eps.map((n) => (
          <button
            key={n}
            onClick={() => onPick(n)}
            aria-label={`Включить серию ${n}`}
            aria-current={currentEp === n ? 'true' : undefined}
            className={cn(
              'min-h-11 rounded-lg border text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
              currentEp === n
                ? 'border-sky-400 bg-sky-400/40 text-sky-300 shadow-[0_0_14px_rgba(56, 189, 248,0.2)]'
                : 'border-border bg-card/60 text-foreground hover:border-sky-400/40 hover:text-sky-200',
            )}
          >
            {n}
          </button>
        ))}
      </div>
      {totalPages > 1 && (
        <div className="mt-3 flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={safePage <= 1}
            onClick={() => setPage(safePage - 1)}
            aria-label="Предыдущая страница серий"
            className="min-h-9 border-border text-xs text-foreground"
          >
            ‹ Назад
          </Button>
          <span className="min-w-20 text-center text-xs tabular-nums text-muted-foreground">
            {from}–{to} из {maxEp}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={safePage >= totalPages}
            onClick={() => setPage(safePage + 1)}
            aria-label="Следующая страница серий"
            className="min-h-9 border-border text-xs text-foreground"
          >
            Вперёд ›
          </Button>
        </div>
      )}
    </div>
  )
}

function EpisodesDialog({ details, maxEp }: { details: AnimeDetails; maxEp: number }) {
  const open = useAvcStore((s) => s.episodesPanelOpen)
  const setOpen = useAvcStore((s) => s.setEpisodesPanelOpen)
  const currentEp = useAvcStore((s) => s.playback.currentEpisode)
  const totalCount =
    details.episodesTotal && details.episodesTotal > 0 ? details.episodesTotal : null

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto avc-scroll sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Серии — {details.title}</DialogTitle>
        </DialogHeader>
        {maxEp > 0 ? (
          <EpisodeGrid
            title=""
            maxEp={maxEp}
            totalCount={totalCount}
            currentEp={currentEp}
            onPick={(n) => {
              void executeCommand({
                type: VoiceCommandType.SelectEpisode,
                params: { episode: n },
                confidence: 1,
                label: `Серия ${n}`,
              })
              setOpen(false)
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Серии не найдены</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
