'use client'
/**
 * DevConsole — панель разработчика (владельца приложения): что происходит
 * под капотом — версия/платформа, состояние AI-воркера, ХВОСТ ЛОГА,
 * контекст воспроизведения, последние команды и шаги пайплайна.
 *
 * Доступ ТОЛЬКО по секретному коду (вводится в диалоге из шапки; код
 * нигде не документируется и в открытом виде в коде не лежит).
 * Отчёт можно скопировать в буфер или отправить в issues репозитория
 * (токен GitHub вводится один раз, живёт только в localStorage этой машины).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Copy, Loader2, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { getElectronBridge } from '@/lib/avc/api'
import { useAvcStore } from '@/lib/avc/store'
import { toast } from '@/hooks/use-toast'

/** Секретный код доступа — не хранится в открытом виде (base64) */
const DEV_CODE = atob('QVZD')
const TOKEN_KEY = 'avc-dev-token'
const UNLOCK_KEY = 'avc-dev-unlocked'

interface AppInfo {
  version: string
  platform: string
  electron: string | null
  node: string | null
  userData: string
  logsFile: string
  modelsDir: string
  workerRunning: boolean
  workerError: string | null
  isPackaged: boolean
}

export function DevConsole({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])
  const [logFile, setLogFile] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [token, setToken] = useState('')
  const [sending, setSending] = useState(false)
  const [lastUrl, setLastUrl] = useState<string | null>(null)

  const playback = useAvcStore((s) => s.playback)
  const pipeline = useAvcStore((s) => s.pipeline)
  const lastExecuted = useAvcStore((s) => s.lastExecuted)
  const settings = useAvcStore((s) => s.settings)

  const refresh = useCallback(async () => {
    const ai = getElectronBridge()?.ai
    if (ai?.getAppInfo) {
      try {
        setAppInfo(await ai.getAppInfo())
      } catch {
        setAppInfo(null)
      }
    }
    if (ai?.readDebugLogs) {
      try {
        const res = await ai.readDebugLogs(250)
        setLogLines(res.lines ?? [])
        setLogFile(res.file ?? null)
      } catch {
        setLogLines([])
      }
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, refresh])

  useEffect(() => {
    if (open) setToken(localStorage.getItem(TOKEN_KEY) ?? '')
  }, [open])

  /** Полный диагностический отчёт одним текстом */
  const report = useMemo(() => {
    const st = useAvcStore.getState()
    const parts: string[] = []
    parts.push('=== AVC DEV DIAGNOSTICS ===')
    parts.push(`date: ${new Date().toISOString()}`)
    if (appInfo) {
      parts.push(
        `\n--- APP ---\nversion: ${appInfo.version}\nplatform: ${appInfo.platform}\nelectron: ${appInfo.electron} node: ${appInfo.node}\npackaged: ${appInfo.isPackaged}\nuserData: ${appInfo.userData}\nmodelsDir: ${appInfo.modelsDir}\nworkerRunning: ${appInfo.workerRunning}\nworkerError: ${appInfo.workerError ?? '—'}`,
      )
    } else {
      parts.push('\n--- APP ---\nweb-режим (превью) — данные приложения недоступны')
    }
    parts.push(`\n--- PLAYBACK ---\n${JSON.stringify(st.playback, null, 1)}`)
    parts.push(`\n--- LAST EXECUTED ---\n${st.lastExecuted ? JSON.stringify({ raw: st.lastExecuted.raw, results: st.lastExecuted.result }, null, 1) : '—'}`)
    parts.push(`\n--- PIPELINE (последние шаги) ---\n${st.pipeline.map((p) => `${p.stage}: ${p.detail}`).join('\n') || '—'}`)
    parts.push(`\n--- VOICE/STT НАСТРОЙКИ ---\n${JSON.stringify({ sttEngine: st.settings.sttEngine, aiProfile: st.settings.aiProfile, micGain: st.settings.micGain, vadSensitivity: st.settings.vadSensitivity, micDeviceId: st.settings.micDeviceId }, null, 1)}`)
    if (logLines.length > 0) {
      parts.push(`\n--- LOG TAIL (${logFile ?? 'avc.log'}) ---\n${logLines.join('\n')}`)
    }
    return parts.join('\n')
  }, [appInfo, logLines, logFile, playback, pipeline, lastExecuted, settings])

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(report)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      toast({ description: 'Отчёт скопирован в буфер обмена' })
    } catch {
      toast({ variant: 'destructive', description: 'Не удалось скопировать' })
    }
  }

  const sendToGitHub = async () => {
    const t = token.trim()
    if (t.length < 20) {
      toast({ variant: 'destructive', description: 'Вставьте GitHub-токен (repo scope) — он хранится только на этом ПК' })
      return
    }
    setSending(true)
    try {
      localStorage.setItem(TOKEN_KEY, t)
      const res = await fetch('/api/debug/upload-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t, body: report }),
      })
      const json = (await res.json()) as { ok: boolean; url?: string | null; error?: string }
      if (json.ok && json.url) {
        setLastUrl(json.url)
        toast({ description: `Отчёт отправлен: ${json.url}` })
      } else {
        toast({ variant: 'destructive', description: json.error ?? 'Не удалось отправить' })
      }
    } catch (e) {
      toast({ variant: 'destructive', description: e instanceof Error ? e.message : 'Ошибка отправки' })
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl" aria-describedby="dev-console-desc">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="rounded bg-sky-950 px-2 py-0.5 text-xs text-sky-300">DEV</span>
            Панель разработчика
          </DialogTitle>
        </DialogHeader>
        <p id="dev-console-desc" className="sr-only">
          Диагностика приложения: версия, состояние AI-воркера, логи, контекст воспроизведения
        </p>

        {/* Сводка приложения */}
        <div className="rounded-lg border border-border bg-card/60 p-3 text-xs">
          {appInfo ? (
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              <span>Версия: <b className="text-foreground">{appInfo.version}</b>{appInfo.isPackaged ? ' (EXE)' : ' (dev)'}</span>
              <span>Платформа: {appInfo.platform}</span>
              <span>Electron: {appInfo.electron ?? '—'} · Node: {appInfo.node ?? '—'}</span>
              <span>
                AI-воркер:{' '}
                <b className={appInfo.workerRunning ? 'text-emerald-400' : 'text-rose-400'}>
                  {appInfo.workerRunning ? 'работает' : 'НЕ запущен'}
                </b>
                {appInfo.workerError ? ` — ${appInfo.workerError}` : ''}
              </span>
              <span className="break-all sm:col-span-2">Каталог моделей: {appInfo.modelsDir}</span>
              <span className="break-all sm:col-span-2">Лог: {appInfo.logsFile}</span>
            </div>
          ) : (
            <p className="text-muted-foreground">Web-режим (превью) — системные данные доступны только в приложении (EXE)</p>
          )}
        </div>

        {/* Хвост лога */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Лог (последние {logLines.length} строк)
            </h4>
          </div>
          <pre className="max-h-64 overflow-y-auto rounded-lg border border-border bg-black/60 p-2.5 font-mono text-[10px] leading-relaxed text-emerald-300/90 [scrollbar-width:thin]">
            {logLines.length > 0 ? logLines.join('\n') : (appInfo ? 'Лог пуст' : 'Логи доступны в приложении (EXE)')}
          </pre>
        </div>

        {/* Отправка на GitHub */}
        <div className="rounded-lg border border-border bg-card/60 p-3">
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Отправить отчёт в GitHub
          </h4>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="GitHub-токен (repo scope), хранится только на этом ПК"
              aria-label="GitHub-токен"
              className="h-9 min-w-0 flex-1 border-border bg-card font-mono text-xs"
            />
            <Button size="sm" className="min-h-9 gap-1.5" disabled={sending} onClick={() => void sendToGitHub()}>
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Send className="h-3.5 w-3.5" aria-hidden />}
              Отправить
            </Button>
            <Button variant="outline" size="sm" className="min-h-9 gap-1.5 border-border" onClick={() => void copyAll()}>
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
              Копировать всё
            </Button>
          </div>
          {lastUrl && (
            <p className="mt-1.5 break-all text-[11px] text-emerald-400">Отчёт: {lastUrl}</p>
          )}
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            В отчёт входят: версия/платформа, состояние AI-воркера, хвост лога, контекст
            воспроизведения и последние команды. Токен никуда не пересылается, кроме GitHub API.
          </p>
        </div>

        <Button
          variant="ghost"
          size="icon"
          aria-label="Закрыть панель разработчика"
          className="absolute right-3 top-3"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Gate — диалог ввода секретного кода. Код сверяется без упоминаний в UI;
 * разблокировка живёт до перезапуска приложения (sessionStorage).
 */
export function DevGate({ open, onClose, onUnlocked }: { open: boolean; onClose: () => void; onUnlocked: () => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState(false)

  const tryUnlock = () => {
    // сравнение через собранный код — без строкового литерала в исходнике
    const expected = DEV_CODE
    if (value.trim() === expected) {
      sessionStorage.setItem(UNLOCK_KEY, '1')
      setError(false)
      setValue('')
      onUnlocked()
    } else {
      setError(true)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-xs" aria-describedby="dev-gate-desc">
        <DialogHeader>
          <DialogTitle className="text-base">Вход</DialogTitle>
        </DialogHeader>
        <p id="dev-gate-desc" className="sr-only">Подтверждение доступа</p>
        <Input
          type="password"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setError(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') tryUnlock()
          }}
          placeholder="Код доступа"
          aria-label="Код доступа"
          aria-invalid={error}
          className="h-10 border-border bg-card text-center font-mono tracking-widest"
          autoFocus
        />
        {error && <p className="text-center text-xs text-rose-400">Неверный код</p>}
        <Button className="min-h-10" onClick={tryUnlock}>
          Открыть
        </Button>
      </DialogContent>
    </Dialog>
  )
}

/** Разблокирована ли dev-консоль в этой сессии */
export function isDevUnlocked(): boolean {
  try {
    return sessionStorage.getItem(UNLOCK_KEY) === '1'
  } catch {
    return false
  }
}
