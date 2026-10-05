'use client'
/**
 * Anime Voice Controller — корневая страница (app-shell).
 *
 * Структура: Header → QuickSections → TabsBar → [main content | HistoryPanel]
 * → нижняя панель (VoicePanel + MiniPlayer, «sticky by construction»).
 * Диалоги: варианты поиска, настройки, справка, отладка, сессия.
 */
import { useEffect, useState } from 'react'
import { avcApi, getElectronBridge } from '@/lib/avc/api'
import { SeaBackground } from '@/components/avc/sea-background'
import { AuthDialog } from '@/components/avc/auth-dialog'
import { AiSetupDialog } from '@/components/avc/ai-setup-dialog'
import { DebugPanel } from '@/components/avc/debug-panel'
import { HeaderBar } from '@/components/avc/header-bar'
import { HelpDialog } from '@/components/avc/help-dialog'
import { HistoryPanel } from '@/components/avc/history-panel'
import { Hotkeys } from '@/components/avc/hotkeys'
import { LibraryPanel } from '@/components/avc/library-panel'
import { MiniPlayer } from '@/components/avc/mini-player'
import { MockPlayerHarness } from '@/components/avc/mock-player-harness'
import { PendingOptionsDialog } from '@/components/avc/pending-options-dialog'
import { QuickSections } from '@/components/avc/quick-sections'
import { SessionRestoreDialog } from '@/components/avc/session-restore-dialog'
import { SettingsDialog } from '@/components/avc/settings-dialog'
import { TabContent } from '@/components/avc/tab-content'
import { TabsBar } from '@/components/avc/tabs-bar'
import { VoiceConfirmDialog } from '@/components/avc/voice-confirm-dialog'
import { VoicePanel } from '@/components/avc/voice-panel'
import { useVoice } from '@/lib/avc/use-voice'
import { useAvcStore } from '@/lib/avc/store'
import { toast } from '@/hooks/use-toast'
import type { AppSettings } from '@/lib/avc/types'
import { cn } from '@/lib/utils'

export default function Page() {
  const tabs = useAvcStore((s) => s.tabs)
  const activeTabId = useAvcStore((s) => s.activeTabId)
  const couchMode = useAvcStore((s) => s.settings.couchMode)
  const voice = useVoice()
  const [sessionResolved, setSessionResolved] = useState(false)

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null

  // Загрузка настроек при монтировании (merge с DEFAULT_SETTINGS)
  useEffect(() => {
    let cancelled = false
    fetch('/api/settings')
      .then(async (r) => (r.ok ? ((await r.json()) as { settings?: AppSettings }) : null))
      .then((d) => {
        if (cancelled || !d?.settings) return
        const st = useAvcStore.getState()
        st.updateSettings(d.settings)
        if (st.playback.volume === 70 && typeof d.settings.defaultVolume === 'number') {
          st.patchPlayback({ volume: d.settings.defaultVolume })
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  // Загрузка: аккаунт YummyAnime (Electron-first) + алиасы (один раз)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [account, aliases] = await Promise.all([
          avcApi.yummyAccount(false),
          avcApi.aliases(),
        ])
        if (cancelled) return
        const st = useAvcStore.getState()
        st.setYummyAccount(account)
        st.setVoiceAliases(aliases)
      } catch {
        // сервер/сайт недоступны — работаем дальше (offline behavior)
      }
    })()
    // EXE-сборка: главный процесс владеет постоянной сессией сайта и сам
    // сообщает об изменениях состояния (вход/выход/истечение) — подписываемся.
    const bridge = getElectronBridge()
    let unsubscribe: (() => void) | null = null
    let unsubscribeStatus: (() => void) | null = null
    if (bridge) {
      unsubscribe = bridge.onAccountChanged((snap) => {
        if (cancelled) return
        useAvcStore.getState().setYummyAccount(snap)
      })
      // Статусы входа (капча/неверный пароль/успех) — из окна сайта в toast
      unsubscribeStatus = bridge.onAuthStatus?.((msg) => {
        if (!cancelled && msg) toast({ description: msg })
      }) ?? null
    }
    return () => {
      cancelled = true
      unsubscribe?.()
      unsubscribeStatus?.()
    }
  }, [])

  // Глобальный Ctrl+Space — push-to-talk
  const { startPushToTalk, stopPushToTalkAndProcess } = voice
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && e.ctrlKey) {
        e.preventDefault()
        if (!e.repeat) void startPushToTalk()
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space' && e.ctrlKey) {
        e.preventDefault()
        stopPushToTalkAndProcess()
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [startPushToTalk, stopPushToTalkAndProcess])

  // Автосохранение сессии (после того, как решён вопрос восстановления)
  useEffect(() => {
    if (!sessionResolved) return
    const t = setTimeout(() => {
      const st = useAvcStore.getState()
      void fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabs: st.tabs, activeId: st.activeTabId }),
      }).catch(() => undefined)
    }, 1000)
    return () => clearTimeout(t)
  }, [tabs, activeTabId, sessionResolved])

  // ДИАГНОСТИЧЕСКИЙ стенд автопропуска: /?mockplayer=1 (см. mock-player-harness.tsx).
  // Включается ТОЛЬКО в клиентском эффекте: SSR и первый клиентский рендер обязаны
  // совпасть (иначе hydration mismatch), стенд подменяет шелл сразу после монтирования.
  const [isMockHarness, setIsMockHarness] = useState(false)
  useEffect(() => {
    // отложенно (не синхронно в теле эффекта — правило react-hooks/set-state-in-effect):
    // SSR и первый клиентский рендер совпадают, стенд включается сразу после монтирования
    const id = window.setTimeout(() => {
      if (window.location.search.includes('mockplayer')) setIsMockHarness(true)
    }, 0)
    return () => window.clearTimeout(id)
  }, [])
  if (isMockHarness) return <MockPlayerHarness />

  return (
    <div
      className={cn(
        'relative flex h-screen flex-col overflow-hidden text-foreground selection:bg-sky-400/40',
        couchMode ? 'text-[17px] lg:text-[21px]' : 'text-sm',
      )}
    >
      {/* Морской фон позади интерфейса: статичный градиент, ноль GPU-нагрузки */}
      <SeaBackground />

      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <HeaderBar />
        <QuickSections />
        <TabsBar />

        <div className="flex min-h-0 flex-1">
          <main
            id="avc-content"
            className="avc-scroll min-w-0 flex-1 overflow-y-auto p-3 sm:p-4"
            tabIndex={-1}
            aria-label="Содержимое вкладки"
          >
            {activeTab && <TabContent key={activeTab.id} tab={activeTab} />}
          </main>
          {!couchMode && <HistoryPanel />}
        </div>

        <footer className="glass mt-auto flex flex-col gap-2 border-t border-cyan-200/10 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4 sm:px-4">
          <VoicePanel voice={voice} />
          <MiniPlayer />
        </footer>
      </div>

      {/* Диалоги и панели */}
      <PendingOptionsDialog />
      <SettingsDialog />
      <AiSetupDialog />
      <HelpDialog />
      {!couchMode && <DebugPanel />}
      <SessionRestoreDialog onResolved={() => setSessionResolved(true)} />
      <VoiceConfirmDialog />
      <AuthDialog />
      <LibraryPanel />
      <Hotkeys />
    </div>
  )
}
