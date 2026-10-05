'use client'
/**
 * InstallPwa — ненавязчивый баннер установки PWA.
 *
 * Ловит beforeinstallprompt, сохраняет событие и показывает фиксированный
 * маленький Card снизу-слева с кнопкой «Установить» (event.prompt()).
 * Не показывается, если:
 *  - пользователь уже закрыл баннер (localStorage 'avc-pwa-dismissed' = '1');
 *  - приложение уже запущено как standalone (display-mode: standalone);
 *  - сработал appinstalled (уже установлено).
 * SSR-safe: по умолчанию возвращает null.
 */
import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

/** Не стандартизированное событие установки (Chromium) */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

const DISMISS_KEY = 'avc-pwa-dismissed'

export function InstallPwa() {
  const [visible, setVisible] = useState(false)
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null)

  useEffect(() => {
    let dismissed = false
    try {
      dismissed = localStorage.getItem(DISMISS_KEY) === '1'
    } catch {
      dismissed = true // приватный режим и т.п. — не показываем
    }
    if (dismissed) return
    if (window.matchMedia?.('(display-mode: standalone)').matches) return

    const onPrompt = (e: Event) => {
      e.preventDefault()
      setPromptEvent(e as BeforeInstallPromptEvent)
      setVisible(true)
    }
    const onInstalled = () => {
      setPromptEvent(null)
      setVisible(false)
    }

    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (!visible || !promptEvent) return null

  const install = async () => {
    try {
      await promptEvent.prompt()
    } catch {
      /* пользователь/браузер отказал — просто скрываем */
    }
    setVisible(false)
  }

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* ignore */
    }
    setVisible(false)
  }

  return (
    <Card className="fixed bottom-3 left-3 z-50 w-72 gap-0 border-border bg-card/60 p-3 shadow-[0_8px_30px_rgba(0,0,0,0.6)] backdrop-blur">
      <div className="flex items-start gap-2.5">
        <Download className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" aria-hidden />
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-foreground">
          Установить AnimeVC на устройство — как приложение
        </p>
        <button
          onClick={dismiss}
          aria-label="Не показывать предложение установки"
          className="-mt-0.5 -mr-0.5 shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <Button
        size="sm"
        onClick={() => void install()}
        aria-label="Установить приложение"
        className="mt-2.5 min-h-9 w-full gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
      >
        <Download className="h-3.5 w-3.5" aria-hidden />
        Установить
      </Button>
    </Card>
  )
}
