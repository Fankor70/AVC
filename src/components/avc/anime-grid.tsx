'use client'
/**
 * AnimeGrid — сетка карточек аниме (секции/поиск) + скелетон загрузки.
 * Наведение (мышь) → плавающее превью рядом с карточкой: полное название,
 * рейтинг, жанры, описание — без перехода на страницу (короткие названия
 * на карточке обрезаются — в превью видно всё).
 */
import { useRef } from 'react'
import { Star } from 'lucide-react'
import { openAnimeCard } from '@/lib/avc/executor'
import type { AnimeCard } from '@/lib/avc/types'
import { Skeleton } from '@/components/ui/skeleton'
import { AnimeHoverPreview, useAnimeHover } from './anime-hover-preview'

export function AnimeGrid({ items }: { items: AnimeCard[] }) {
  const { hover, onEnter, onLeave } = useAnimeHover()
  const gridRef = useRef<HTMLDivElement | null>(null)
  const open = (card: AnimeCard) => void openAnimeCard(card, true)

  return (
    <div ref={gridRef} className="relative">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {items.map((card) => (
        <button
          key={`${card.animeId}-${card.slug}`}
          onClick={() => open(card)}
          onMouseEnter={(e) => onEnter(card, e.currentTarget)}
          onMouseLeave={onLeave}
          aria-label={`Открыть: ${card.title}`}
          className="group text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded-xl"
        >
          <div className="relative overflow-hidden rounded-lg border border-border bg-card transition-all group-hover:border-sky-400/40 group-hover:shadow-[0_0_20px_rgba(56, 189, 248,0.12)]">
            {card.poster ? (
              <img
                src={card.poster}
                alt={card.title}
                loading="lazy"
                className="aspect-[3/4] w-full object-cover transition-transform group-hover:scale-[1.03]"
              />
            ) : (
              <div className="flex aspect-[3/4] w-full items-center justify-center text-xs text-muted-foreground">
                Нет постера
              </div>
            )}
            {card.rating !== null && card.rating > 0 && (
              <span className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-md bg-black/75 px-1.5 py-0.5 text-[11px] font-semibold text-sky-400">
                <Star className="h-3 w-3" aria-hidden />
                {card.rating.toFixed(1)}
              </span>
            )}
          </div>
          <div className="mt-1.5 line-clamp-2 text-sm font-medium text-foreground transition-colors group-hover:text-sky-300">
            {card.title}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
            {card.year !== null && <span>{card.year}</span>}
            {card.type && <span>· {card.type}</span>}
            {card.status && <span>· {card.status}</span>}
          </div>
        </button>
      ))}
      </div>
      <AnimeHoverPreview hover={hover} onOpen={open} onNavigate={open} />
    </div>
  )
}

export function AnimeGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>
          <Skeleton className="aspect-[3/4] w-full rounded-lg bg-card" />
          <Skeleton className="mt-2 h-4 w-4/5 rounded bg-card" />
          <Skeleton className="mt-1 h-3 w-2/5 rounded bg-card" />
        </div>
      ))}
    </div>
  )
}
