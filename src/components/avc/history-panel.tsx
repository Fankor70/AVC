'use client'
/**
 * HistoryPanel — правая боковая панель истории команд.
 * Перезагружается при инкременте historyVersion (после каждой executeText).
 */
import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Trash2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAvcStore } from '@/lib/avc/store'
import { LABELS } from '@/lib/voice/parser'
import type { VoiceCommandType } from '@/lib/avc/types'
import { cn } from '@/lib/utils'

interface HistoryItem {
  id: number
  raw: string
  command: string
  confidence: number
  success: boolean
  message: string | null
  source: string
  createdAt: string
}

function commandLabel(command: string): string {
  return LABELS[command as VoiceCommandType] ?? command
}

function timeOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--'
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

export function HistoryPanel() {
  const historyVersion = useAvcStore((s) => s.historyVersion)
  const bumpHistoryVersion = useAvcStore((s) => s.bumpHistoryVersion)
  const [items, setItems] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/history?limit=25')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { items?: HistoryItem[] }
      setItems(data.items ?? [])
      setError(null)
    } catch (e) {
      setItems([])
      setError(e instanceof Error ? e.message : 'История недоступна')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, historyVersion])

  const clearAll = async () => {
    try {
      await fetch('/api/history', { method: 'DELETE' })
      bumpHistoryVersion()
    } catch {
      // не критично
    }
  }

  return (
    <aside
      aria-label="История команд"
      className="glass hidden w-72 shrink-0 flex-col border-l border-cyan-200/10 md:flex"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <h2 className="text-sm font-semibold text-foreground">История команд</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Очистить историю"
          title="Очистить историю"
          className="h-8 w-8 text-muted-foreground hover:text-rose-400"
          onClick={() => void clearAll()}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <div className="avc-scroll min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2.5">
        {loading && <p className="p-2 text-xs text-muted-foreground">Загрузка...</p>}
        {!loading && error && (
          <div className="p-2 text-xs text-rose-400">
            История недоступна: {error}
            <Button variant="ghost" size="sm" className="mt-1 min-h-7 px-2 text-[11px]" onClick={() => void load()}>
              Повторить
            </Button>
          </div>
        )}
        {!loading && items.length === 0 && (
          <p className="p-2 text-xs text-muted-foreground">Пока нет команд. Скажите что-нибудь!</p>
        )}
        {items.map((item) => (
          <div
            key={item.id}
            className="rounded-lg border border-border/80 bg-card/60 px-2.5 py-2 text-xs"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 font-medium text-foreground">
                {item.success ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />
                ) : (
                  <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden />
                )}
                <span className="truncate">{commandLabel(item.command)}</span>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{timeOf(item.createdAt)}</span>
            </div>
            <div className="mt-1 truncate text-muted-foreground" title={item.raw}>
              «{item.raw}»
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span
                className={cn(
                  'tabular-nums',
                  item.confidence >= 0.7 ? 'text-emerald-400/80' : 'text-sky-400/40',
                )}
              >
                {Math.round(item.confidence * 100)}%
              </span>
              {item.source === 'llm' && (
                <span className="rounded border border-rose-500/30 bg-rose-500/10 px-1 text-[10px] text-rose-300">
                  LLM
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}
