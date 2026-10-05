'use client'
/**
 * AnimeHoverCard — превью аниме при наведении на карточку (спецификация:
 * «при наведении на карточку открывалась страница в окошке рядом, краткая
 * информация не переходя на аниме», длинные названия видны полностью).
 *
 * Задержка 350 мс (случайные проводки мышью не дёргают сеть), данные
 * /api/site/anime/{id} кэшируются на сессию. Тач-устройства не затронуты
 * (hover только по mouseenter с мышью). Открывается рядом с карточкой,
 * не перекрывает курсор, закрывается по уходу мыши.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { AnimeCard, AnimeDetails } from '@/lib/avc/types'

const detailsCache = new Map<string, AnimeDetails>()

function cacheKey(animeId: number, slug: string): string {
  return `${animeId}|${slug}`
}

export function prefetchAnimeDetails(animeId: number, slug: string): void {
  const key = cacheKey(animeId, slug)
  if (detailsCache.has(key)) return
  void fetch(`/api/site/anime/${encodeURIComponent(slug || String(animeId))}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((d: AnimeDetails) => detailsCache.set(key, d))
    .catch(() => undefined)
}

interface HoverState {
  card: AnimeCard
  anchor: { x: number; y: number; w: number }
}

export function useAnimeHover() {
  const [hover, setHover] = useState<HoverState | null>(null)
  const timerRef = useRef<number | null>(null)
  const lastLeaveRef = useRef(0)

  const onEnter = (card: AnimeCard, el: HTMLElement): void => {
    if (window.matchMedia('(pointer: coarse)').matches) return // тач — без превью
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      const r = el.getBoundingClientRect()
      setHover({ card, anchor: { x: r.left, y: r.top, w: r.width } })
    }, 350)
  }

  const onLeave = (): void => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = null
    lastLeaveRef.current = Date.now()
    setHover(null)
  }

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
  }, [])

  return { hover, onEnter, onLeave }
}

export function AnimeHoverPreview({
  hover,
  onOpen,
  onNavigate,
}: {
  hover: HoverState | null
  onOpen: (card: AnimeCard) => void
  onNavigate: (card: AnimeCard) => void
}) {
  const [details, setDetails] = useState<AnimeDetails | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    // setDetails в колбэках async-потока (не синхронно в теле эффекта)
    let cancelled = false
    if (!hover) {
      Promise.resolve().then(() => !cancelled && setDetails(null))
      return () => {
        cancelled = true
      }
    }
    const key = cacheKey(hover.card.animeId, hover.card.slug)
    const cached = detailsCache.get(key)
    if (cached) {
      Promise.resolve().then(() => !cancelled && setDetails(cached))
      return () => {
        cancelled = true
      }
    }
    Promise.resolve().then(() => {
      if (cancelled) return
      setDetails(null)
      setLoading(true)
    })
    void fetch(`/api/site/anime/${encodeURIComponent(hover.card.slug || String(hover.card.animeId))}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: AnimeDetails) => {
        detailsCache.set(key, d)
        if (!cancelled) {
          setDetails(d)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDetails(null)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [hover])

  if (!hover) return null

  // Позиция: справа от карточки, не вылезая за правый край окна
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1280
  const flip = hover.anchor.x + hover.anchor.w + 320 > viewportW
  const style: React.CSSProperties = flip
    ? { right: viewportW - hover.anchor.x + 8, top: hover.anchor.y }
    : { left: hover.anchor.x + hover.anchor.w + 8, top: hover.anchor.y }

  const d = details
  const maxEp = d?.episodesTotal ?? d?.episodesAired ?? null

  return (
    <div
      className="fixed z-[60] w-80 rounded-xl border border-sky-400/30 bg-card/95 p-3 shadow-[0_8px_40px_rgba(0,0,0,0.6)] backdrop-blur-sm"
      style={style}
      role="tooltip"
      aria-label={`Превью: ${hover.card.title}`}
      onMouseEnter={(e) => {
        // мышь ушла с карточки на превью — не даём ему закрыться
        e.stopPropagation()
      }}
    >
      <div className="flex gap-3">
        {hover.card.poster ? (
          <img
            src={hover.card.poster}
            alt=""
            className="aspect-[3/4] w-20 shrink-0 rounded-md border border-border object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex aspect-[3/4] w-20 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-[10px] text-muted-foreground">
            нет постера
          </div>
        )}
        <div className="min-w-0 flex-1">
          {/* Полное название — переносится целиком (жалоба: длинные названия не влезают) */}
          <h4 className="break-words text-sm font-semibold leading-snug text-foreground">
            {hover.card.title}
          </h4>
          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            {hover.card.year !== null && <span>{hover.card.year}</span>}
            {hover.card.type && <span>· {hover.card.type}</span>}
            {hover.card.rating !== null && hover.card.rating > 0 && (
              <span className="font-semibold text-sky-400">★ {hover.card.rating.toFixed(1)}</span>
            )}
            {hover.card.status && <span>· {hover.card.status}</span>}
            {maxEp != null && maxEp > 0 && <span>· серий: {maxEp}</span>}
          </div>
        </div>
      </div>

      {loading && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Загружаю описание…
        </p>
      )}
      {d?.description && (
        <p className="mt-2 line-clamp-5 text-xs leading-relaxed text-muted-foreground">
          {d.description}
        </p>
      )}
      {d && d.genres.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {d.genres.slice(0, 5).map((g) => (
            <span key={g} className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {g}
            </span>
          ))}
        </div>
      )}
      {!loading && !d && (
        <p className="mt-2 text-xs text-muted-foreground">Описание недоступно — откройте страницу</p>
      )}

      <button
        type="button"
        className="mt-2.5 min-h-9 w-full rounded-md bg-sky-400/15 px-3 text-xs font-semibold text-sky-300 transition-colors hover:bg-sky-400/25"
        onClick={() => onNavigate(hover.card)}
      >
        Открыть страницу
      </button>
    </div>
  )
}
