'use client'
/**
 * SessionRestoreDialog — восстановление предыдущей сессии вкладок (#30).
 * Автоматически НЕ восстанавливает: спрашивает пользователя.
 * «Нет» — сессия стирается (DELETE /api/session), старт с чистой главной.
 */
import { useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAvcStore } from '@/lib/avc/store'
import type { BrowserTab } from '@/lib/avc/types'

export function SessionRestoreDialog({ onResolved }: { onResolved: () => void }) {
  const [open, setOpen] = useState(false)
  const [session, setSession] = useState<{ tabs: BrowserTab[]; activeId: string | null } | null>(
    null,
  )
  const resolvedRef = useRef(false)

  const resolve = () => {
    if (resolvedRef.current) return
    resolvedRef.current = true
    onResolved()
  }

  const decline = async () => {
    resolve()
    setOpen(false)
    try {
      await fetch('/api/session', { method: 'DELETE' })
    } catch {
      // не критично
    }
  }

  const accept = () => {
    if (!session) return
    useAvcStore.getState().restoreSession(session.tabs, session.activeId)
    resolve()
    setOpen(false)
  }

  useEffect(() => {
    let cancelled = false
    fetch('/api/session')
      .then(async (r) => (r.ok ? ((await r.json()) as {
        tabs?: BrowserTab[]
        activeId?: string | null
        hasSession?: boolean
      }) : null))
      .then((d) => {
        if (cancelled || !d) {
          if (!cancelled) resolve()
          return
        }
        if (d.hasSession && d.tabs && d.tabs.length > 0) {
          setSession({ tabs: d.tabs, activeId: d.activeId ?? null })
          setOpen(true)
        } else {
          resolve()
        }
      })
      .catch(() => {
        if (!cancelled) resolve()
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleOpenChange = (o: boolean) => {
    setOpen(o)
    if (!o) void decline()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Восстановить предыдущую сессию?</DialogTitle>
          <DialogDescription>
            {session
              ? `Найдено вкладок: ${session.tabs.length}. Можно вернуть открытые разделы и аниме.`
              : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => void decline()}
            className="min-h-11 border-border bg-card/60"
          >
            Нет, начать заново
          </Button>
          <Button
            onClick={accept}
            className="min-h-11 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            Да, восстановить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
