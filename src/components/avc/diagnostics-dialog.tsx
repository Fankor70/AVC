'use client'
/**
 * DiagnosticsDialog — «Диагностика входа YummyAnime» (спецификация, секция 20).
 *
 * Показывает ТОЛЬКО не-секретные данные (секция 15): машина состояний
 * аутентификации, имя пользователя, время последней проверки, сеть.
 *
 * Действия:
 *   - Selftest аутентификации — выполняется в EXE-сборке через мост
 *     (avcApi.authSelfTest); в веб-режиме — честное «доступно в EXE».
 *   - «Сбросить сессию сайта» — ОПАСНОЕ действие (секция 22): двухшаговое
 *     подтверждение через AlertDialog; оболочка бэкапит профиль перед
 *     очисткой и возвращает путь к бэкапу.
 */
import { useEffect, useState } from 'react'
import { Activity, Loader2, Mic, ShieldAlert, Stethoscope } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { avcApi, getElectronBridge } from '@/lib/avc/api'
import { siteBase } from '@/lib/avc/site-urls'
import { useAvcStore } from '@/lib/avc/store'
import type {
  YummyAccountSnapshot,
  YummyAuthSelfTestReport,
  YummySelfTestStatus,
} from '@/lib/avc/types'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

/** Локализованные подписи машины состояний аутентификации */
const AUTH_STATE_LABELS: Record<YummyAccountSnapshot['state'], string> = {
  unknown: 'Неизвестно',
  checking: 'Проверяется',
  loggedOut: 'Не выполнен',
  loggedIn: 'Выполнен',
  sessionExpired: 'Истекла',
  unavailable: 'Недоступно',
}

/** Цвета бейджей статусов selftest (emerald/rose/zinc/amber — секция 20) */
const STATUS_BADGE: Record<YummySelfTestStatus, string> = {
  PASS: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  FAIL: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  SKIP: 'border-border bg-accent/60 text-muted-foreground',
  BLOCKED: 'border-amber-500/40 bg-amber-500/10 text-sky-300',
}

/** Крупные итоги отчёта: ключ + русская подпись */
const SUMMARY_BADGES: {
  key: keyof Pick<YummyAuthSelfTestReport, 'persistence' | 'loginDetection' | 'logoutDetection'>
  label: string
}[] = [
  { key: 'persistence', label: 'Сохранность сессии' },
  { key: 'loginDetection', label: 'Детекция входа' },
  { key: 'logoutDetection', label: 'Детекция выхода' },
]

/** Хост сайта из настроек (по умолчанию old.yummyani.me) */
function siteHost(baseUrl: string): string {
  const base = siteBase(baseUrl)
  try {
    return new URL(base).hostname
  } catch {
    return base
  }
}

interface DiagnosticsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DiagnosticsDialog({ open, onOpenChange }: DiagnosticsDialogProps) {
  const storeAccount = useAvcStore((s) => s.yummyAccount)
  const setYummyAccount = useAvcStore((s) => s.setYummyAccount)
  const baseUrl = useAvcStore((s) => s.settings.baseUrl)

  const [hasBridge, setHasBridge] = useState(false)
  const [online, setOnline] = useState(true)
  /** Свежий снимок, полученный при открытии диалога (локальное состояние) */
  const [account, setAccount] = useState<YummyAccountSnapshot | null>(null)
  const [testBusy, setTestBusy] = useState(false)
  const [report, setReport] = useState<YummyAuthSelfTestReport | null>(null)
  const [voiceRestartBusy, setVoiceRestartBusy] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetBusy, setResetBusy] = useState(false)
  const [resetResult, setResetResult] = useState<{
    ok: boolean
    backupPath: string | null
    message: string
  } | null>(null)

  // При открытии: определяем мост, сеть и (в EXE) тянем свежий снимок аккаунта
  useEffect(() => {
    if (!open) return
    const bridge = getElectronBridge()
    setHasBridge(bridge !== null)
    setOnline(typeof navigator === 'undefined' ? true : navigator.onLine)
    if (!bridge) {
      setAccount(null)
      return
    }
    let cancelled = false
    void avcApi
      .yummyAccount(false)
      .then((snap) => {
        if (!cancelled) setAccount(snap)
      })
      .catch(() => {
        /* мост недоступен — оставляем данные из store */
      })
    return () => {
      cancelled = true
    }
  }, [open])

  /** Отображаемое состояние: свежий снимок, иначе — текущее значение store */
  const view = account ?? storeAccount

  /** Фаза 6.7: перезапуск голосового сервиса — переинициализация AI-воркера */
  const restartVoice = async () => {
    const ai = getElectronBridge()?.ai
    if (!ai?.initialize) return
    setVoiceRestartBusy(true)
    try {
      await ai.initialize()
      const st = await ai.getStatus().catch(() => null)
      const r = st?.ready
      toast({
        description: r
          ? `Голосовой сервис перезапущен: STT ${r.stt ? 'готов' : 'недоступен'}`
          : 'Голосовой сервис перезапущен',
      })
    } catch (e) {
      toast({ description: `Не удалось перезапустить: ${e instanceof Error ? e.message : String(e)}`, variant: 'destructive' })
    } finally {
      setVoiceRestartBusy(false)
    }
  }

  const runSelfTest = async () => {
    setTestBusy(true)
    try {
      const rep = await avcApi.authSelfTest()
      if (!rep) {
        toast({ description: 'Диагностика доступна в EXE-сборке' })
        return
      }
      setReport(rep)
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Ошибка диагностики',
      })
    } finally {
      setTestBusy(false)
    }
  }

  /** ОПАСНОЕ действие (секция 22): сброс постоянного профиля сайта (с бэкапом) */
  const performReset = async () => {
    setResetBusy(true)
    try {
      const res = await avcApi.resetYummySession()
      if (!res) {
        toast({ description: 'Сброс сессии доступен в EXE-сборке' })
        return
      }
      setResetResult(res)
      if (res.ok) {
        toast({
          description: res.backupPath
            ? `Сессия сайта сброшена. Бэкап профиля: ${res.backupPath}`
            : res.message || 'Сессия сайта сброшена',
        })
      } else {
        toast({
          variant: 'destructive',
          description: res.message || 'Не удалось сбросить сессию сайта',
        })
      }
      // После сброса обновляем снимок аккаунта (store + локальная шапка)
      const snap = await avcApi.yummyAccount(false)
      setAccount(snap)
      setYummyAccount(snap)
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Ошибка сброса сессии',
      })
    } finally {
      setResetBusy(false)
    }
  }

  const profileLabel =
    view.state === 'loggedIn'
      ? 'Доступен'
      : view.state === 'loggedOut' || view.state === 'sessionExpired'
        ? 'Нет'
        : '—'

  const username = view.user ? (view.user.username ?? view.user.displayName ?? 'без имени') : null

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Stethoscope className="h-5 w-5 text-sky-400" aria-hidden />
              Диагностика входа YummyAnime
            </DialogTitle>
            <DialogDescription>
              Только не-секретные данные: приложение не показывает и не передаёт
              cookie, токены и пароли.
            </DialogDescription>
          </DialogHeader>

          {/* Шапка: текущее состояние (без секретов) */}
          <section aria-label="Текущее состояние входа">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-xl border border-border bg-card/60 p-3 text-xs">
              <dt className="text-muted-foreground">Сайт</dt>
              <dd className="truncate text-foreground">{siteHost(baseUrl)}</dd>

              <dt className="text-muted-foreground">Сессия</dt>
              <dd className="text-foreground">{hasBridge ? 'Постоянная (EXE)' : 'Недоступна (web)'}</dd>

              <dt className="text-muted-foreground">Состояние</dt>
              <dd className="text-foreground">{AUTH_STATE_LABELS[view.state]}</dd>

              <dt className="text-muted-foreground">Пользователь</dt>
              <dd className="truncate text-foreground">{username ?? '—'}</dd>

              <dt className="text-muted-foreground">Профиль</dt>
              <dd className="text-foreground">{profileLabel}</dd>

              <dt className="text-muted-foreground">Последняя проверка</dt>
              <dd className="tabular-nums text-foreground">
                {view.lastSync ? new Date(view.lastSync).toLocaleTimeString('ru-RU') : '—'}
              </dd>

              <dt className="text-muted-foreground">Сеть</dt>
              <dd
                className={cn(
                  'font-medium',
                  online ? 'text-emerald-300' : 'text-rose-300',
                )}
                aria-label={online ? 'Сеть: онлайн' : 'Сеть: офлайн'}
              >
                {online ? 'ONLINE' : 'OFFLINE'}
              </dd>
            </dl>
          </section>

          {/* Действия */}
          <div className="flex flex-col gap-2">
            <Button
              onClick={() => void runSelfTest()}
              disabled={testBusy}
              className="min-h-11 gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {testBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Activity className="h-4 w-4" aria-hidden />
              )}
              Запустить тест аутентификации
            </Button>

            {/* Фаза 6.7: перезапуск голосового сервиса (восстановление после сбоев) */}
            {typeof window !== 'undefined' && getElectronBridge()?.ai?.initialize && (
              <Button
                variant="outline"
                disabled={voiceRestartBusy}
                onClick={() => void restartVoice()}
                className="min-h-11 gap-2 border-border bg-card/60 text-sky-300 hover:border-sky-400/50 hover:bg-sky-400/10 hover:text-sky-200"
              >
                {voiceRestartBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Mic className="h-4 w-4" aria-hidden />
                )}
                Перезапустить голосовой сервис (AI)
              </Button>
            )}

            <Button
              variant="outline"
              disabled={resetBusy}
              onClick={() => setResetOpen(true)}
              className="min-h-11 gap-2 border-border bg-card/60 text-rose-300 hover:border-rose-500/50 hover:bg-rose-500/10 hover:text-rose-200"
            >
              {resetBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <ShieldAlert className="h-4 w-4" aria-hidden />
              )}
              Сбросить сессию сайта
            </Button>
          </div>

          {resetResult && (
            <p
              role="status"
              className={cn(
                'rounded-lg border p-2.5 text-xs leading-relaxed',
                resetResult.ok
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                  : 'border-rose-500/30 bg-rose-500/10 text-rose-200',
              )}
            >
              {resetResult.message}
              {resetResult.backupPath && (
                <span className="mt-1 block break-all text-muted-foreground">
                  Бэкап профиля: {resetResult.backupPath}
                </span>
              )}
            </p>
          )}

          {/* Отчёт selftest (только безопасные данные) */}
          {report && (
            <section
              aria-label="Отчёт теста аутентификации"
              className="space-y-3 rounded-xl border border-border bg-card/60 p-3"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>Отчёт от {new Date(report.ranAt).toLocaleTimeString('ru-RU')}</span>
                <span aria-hidden>·</span>
                <span>Сеть оболочки: {report.network}</span>
              </div>

              <div className="flex flex-wrap gap-2">
                {SUMMARY_BADGES.map(({ key, label }) => (
                  <Badge
                    key={key}
                    variant="outline"
                    className={cn('px-2 py-1 text-[11px]', STATUS_BADGE[report[key]])}
                  >
                    {label}: {report[key]}
                  </Badge>
                ))}
              </div>

              <ul className="space-y-1.5">
                {report.steps.map((step, i) => (
                  <li key={`${step.name}-${i}`} className="flex items-start gap-2 text-xs">
                    <Badge
                      variant="outline"
                      className={cn(
                        'mt-0.5 w-20 shrink-0 justify-center text-[10px]',
                        STATUS_BADGE[step.status],
                      )}
                    >
                      {step.status}
                    </Badge>
                    <span className="min-w-0">
                      <span className="text-foreground">{step.name}</span>
                      <span className="block break-all text-muted-foreground">{step.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </DialogContent>
      </Dialog>

      {/* ОПАСНОЕ действие: двухшаговое подтверждение (спека, секция 22) */}
      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent className="border-border bg-background sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground">
              Сбросить сессию сайта?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              Постоянный профиль сайта (вход в YummyAnime) будет очищен — вход придётся
              выполнить заново. Перед очисткой оболочка сохранит резервную копию профиля
              и покажет путь к ней. Действие нельзя отменить.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={resetBusy}
              className="border-border bg-card text-foreground hover:text-sky-300"
            >
              Отмена
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void performReset()}
              className="gap-2 bg-rose-600 text-white hover:bg-rose-500"
            >
              <ShieldAlert className="h-4 w-4" aria-hidden />
              Сбросить сессию
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
