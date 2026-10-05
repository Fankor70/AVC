'use client'
/**
 * QuickSections — быстрый ряд кнопок секций (мобильно — горизонтальный скролл).
 * Клик = вызов executeCommand через хелпер openSection.
 */
import type { LucideIcon } from 'lucide-react'
import {
  CalendarClock,
  CalendarDays,
  Dices,
  Home,
  Library,
  Sparkles,
  Trophy,
} from 'lucide-react'
import { openSection } from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import type { SiteSectionId } from '@/lib/avc/types'
import { cn } from '@/lib/utils'

interface SectionDef {
  id: SiteSectionId
  label: string
  icon: LucideIcon
}

const SECTIONS: SectionDef[] = [
  { id: 'home', label: 'Главная', icon: Home },
  { id: 'catalog', label: 'Каталог', icon: Library },
  { id: 'top100', label: 'ТОП-100', icon: Trophy },
  { id: 'ongoing', label: 'Онгоинги', icon: Sparkles },
  { id: 'announcements', label: 'Анонсы', icon: CalendarClock },
  { id: 'schedule', label: 'Расписание', icon: CalendarDays },
  { id: 'random', label: 'Случайное', icon: Dices },
]

export function QuickSections() {
  const tabs = useAvcStore((s) => s.tabs)
  const activeTabId = useAvcStore((s) => s.activeTabId)
  const active = tabs.find((t) => t.id === activeTabId) ?? null

  const isActive = (id: SiteSectionId): boolean => {
    if (!active) return false
    if (id === 'home') return active.kind === 'home'
    return active.kind === 'section' && active.payload.section === id
  }

  return (
    <div className="avc-scroll glass overflow-x-auto border-b border-cyan-200/10 px-3 py-2 sm:px-4">
      <div className="flex gap-2">
        {SECTIONS.map(({ id, label, icon: Icon }) => {
          const activeBtn = isActive(id)
          return (
            <button
              key={id}
              onClick={() => void openSection(id)}
              aria-label={`Открыть: ${label}`}
              aria-current={activeBtn ? 'page' : undefined}
              className={cn(
                'flex min-h-11 shrink-0 items-center gap-2 rounded-xl border px-3 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                activeBtn
                  ? 'border-sky-400/40 bg-sky-400/40 text-sky-300 shadow-[0_0_18px_rgba(56, 189, 248,0.15)]'
                  : 'border-border bg-card/60 text-foreground hover:border-border hover:text-foreground',
              )}
            >
              <Icon className="h-5 w-5" aria-hidden />
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
