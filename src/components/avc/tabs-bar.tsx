'use client'
/**
 * TabsBar — горизонтальная панель вкладок с кнопками закрытия и «+».
 */
import { Plus, X } from 'lucide-react'
import { useAvcStore } from '@/lib/avc/store'
import { cn } from '@/lib/utils'

export function TabsBar() {
  const tabs = useAvcStore((s) => s.tabs)
  const activeTabId = useAvcStore((s) => s.activeTabId)
  const setActiveTab = useAvcStore((s) => s.setActiveTab)
  const closeTab = useAvcStore((s) => s.closeTab)
  const addTab = useAvcStore((s) => s.addTab)

  return (
    <div
      role="tablist"
      aria-label="Вкладки"
      className="avc-scroll glass flex items-end gap-1 overflow-x-auto border-b border-cyan-200/10 px-2 sm:px-3"
    >
      {tabs.map((tab, i) => {
        const isActive = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={0}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setActiveTab(tab.id)
              }
            }}
            className={cn(
              'group flex max-w-[200px] min-w-[110px] cursor-pointer items-center gap-1 rounded-t-lg border-x border-t px-2.5 py-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
              isActive
                ? 'border-border bg-card text-sky-300'
                : 'border-transparent text-muted-foreground hover:bg-card/60 hover:text-foreground',
            )}
          >
            <span className="flex-1 truncate" title={tab.title}>
              {i + 1}. {tab.title}
            </span>
            <button
              aria-label={`Закрыть вкладку: ${tab.title}`}
              className="rounded p-0.5 text-muted-foreground opacity-60 transition-all hover:bg-accent hover:text-rose-400 group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
            {isActive && <span className="absolute" aria-hidden />}
          </div>
        )
      })}
      <button
        aria-label="Новая вкладка"
        title="Новая вкладка"
        onClick={() => addTab({ kind: 'home', title: 'Главная', payload: {} })}
        className="mb-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <Plus className="h-4 w-4" aria-hidden />
      </button>
    </div>
  )
}
