'use client'
/**
 * UpdateDialog — ПОЛНАЯ state-машина обновления приложения (§3.5, §10).
 *
 * Проверка   → current/latest  → доступно?  → скачивание (%, МБ, скорость, ETA)
 *   → верификация SHA-256 → подготовка → перезапуск → итог после старта (§3.12).
 *
 * Никогда не скачивает при current == latest: сравнение версий выполняется
 * В MAIN-ПРОЦЕССЕ дважды (check и install) — рендерер только отображает.
 * Web-режим (без EXE-моста) диалог не открывается — там кнопка скачивает EXE.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react'
import {
  getElectronBridge,
  type UpdateProgress,
  type UpdateResult,
} from '@/lib/avc/api'
import { useAvcStore } from '@/lib/avc/store'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

type Phase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'preparing'
  | 'restarting'
  | 'success'
  | 'error'

interface CheckInfo {
  current: string
  latest: string | null
  relation: 'newer' | 'older' | 'up-to-date' | 'unknown'
  releaseName?: string | null
  releasedAt?: string | null
  releaseNotes?: string | null
  available: boolean
  assetName: string | null
  assetSizeBytes?: number | null
  releasesUrl: string
  lastUpdateResult?: UpdateResult | null
  error?: string
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} ГБ`
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} МБ`
  return `${Math.max(0, Math.round(n / 1024))} КБ`
}

function fmtSpeed(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps) || bps <= 0) return ''
  return `${fmtBytes(bps)}/с`
}

function fmtEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return `~${Math.ceil(seconds)} с`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `~${m} мин ${s} с`
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}

export function UpdateDialog() {
  const open = useAvcStore((s) => s.updateDialogOpen)
  const setOpen = useAvcStore((s) => s.setUpdateDialogOpen)

  const [phase, setPhase] = useState<Phase>('idle')
  const [info, setInfo] = useState<CheckInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{
    percent: number | null
    received: number | null
    total: number | null
    speed: number | null
  }>({ percent: null, received: null, total: null, speed: null })
  const [shaVerified, setShaVerified] = useState<boolean | null>(null)
  const [lastResult, setLastResult] = useState<UpdateResult | null>(null)
  const busyRef = useRef(false)

  /** Проверка обновления (main сверяет версии — рендерер только показывает) */
  const runCheck = useCallback(async () => {
    const bridge = getElectronBridge()
    if (!bridge?.checkUpdate) return
    setPhase('checking')
    setError(null)
    setShaVerified(null)
    try {
      const res = await bridge.checkUpdate()
      setInfo(res)
      if (res.lastUpdateResult) setLastResult(res.lastUpdateResult)
      if (res.error) {
        setError(res.error)
        setPhase('error')
      } else if (res.available) {
        setPhase('available')
      } else {
        setPhase('up-to-date')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось проверить обновления')
      setPhase('error')
    }
  }, [])

  /** Установка: main сам скачивает → проверяет SHA → готовит → перезапускает */
  const startInstall = useCallback(async () => {
    const bridge = getElectronBridge()
    if (!bridge?.installUpdate || busyRef.current) return
    busyRef.current = true
    setError(null)
    setPhase('downloading')
    setProgress({ percent: 0, received: 0, total: info?.assetSizeBytes ?? null, speed: null })
    try {
      const res = await bridge.installUpdate()
      if (!res.ok) {
        setError(res.error ?? 'Не удалось установить обновление')
        setPhase('error')
      }
      // ok: дальше приходят события progress (restarting), приложение перезапустится
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось установить обновление')
      setPhase('error')
    } finally {
      busyRef.current = false
    }
  }, [info])

  // Прогресс-события из main (фазы §3.5)
  useEffect(() => {
    if (!open) return
    const bridge = getElectronBridge()
    const offProgress = bridge?.onUpdateProgress?.((p: UpdateProgress) => {
      if (p.phase === 'downloading') {
        setPhase('downloading')
        setProgress({
          percent: typeof p.percent === 'number' ? p.percent : null,
          received: p.receivedBytes ?? null,
          total: p.totalBytes ?? null,
          speed: p.speedBps ?? null,
        })
      } else if (p.phase === 'verifying') {
        setPhase('verifying')
      } else if (p.phase === 'preparing') {
        setShaVerified(p.shaVerified === true)
        setPhase('preparing')
      } else if (p.phase === 'restarting') {
        setShaVerified(p.shaVerified === true)
        setPhase('restarting')
      } else if (p.phase === 'error') {
        setError(p.error ?? 'Ошибка обновления')
        setPhase('error')
      }
    })
    return () => {
      offProgress?.()
    }
  }, [open])

  // Итог прошлого обновления (событие из main при старте + из check)
  useEffect(() => {
    if (!open) return
    const bridge = getElectronBridge()
    const offResult = bridge?.onUpdateResult?.((r: UpdateResult) => setLastResult(r))
    return () => {
      offResult?.()
    }
  }, [open])

  // При каждом открытии — свежая проверка
  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => {
      void runCheck()
    }, 0)
    return () => window.clearTimeout(t)
  }, [open, runCheck])

  const busy = phase === 'checking' || phase === 'downloading' || phase === 'verifying' || phase === 'preparing' || phase === 'restarting'
  const etaSec =
    progress.speed && progress.speed > 0 && progress.total && progress.received != null
      ? (progress.total - progress.received) / progress.speed
      : null

  const phaseTitle: Record<Phase, string> = {
    idle: 'Обновление приложения',
    checking: 'Проверка обновлений…',
    'up-to-date': 'У вас последняя версия',
    available: 'Доступно обновление',
    downloading: 'Скачивание обновления…',
    verifying: 'Проверка целостности…',
    preparing: 'Подготовка установки…',
    restarting: 'Перезапуск AVC-Anime…',
    success: 'Обновление установлено',
    error: 'Обновление не удалось',
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md border-border bg-card text-foreground">
        <DialogHeader className="p-0">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <RefreshCw className={cn('h-5 w-5 text-sky-400', busy && 'animate-spin')} aria-hidden />
            {phaseTitle[phase]}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Портативная сборка обновляет сама себя: проверка версий → скачивание → проверка
            целостности → замена EXE → перезапуск.
          </DialogDescription>
        </DialogHeader>

        {/* Итог ПРОШЛОГО обновления (маркер после перезапуска, §3.12) */}
        {lastResult && phase !== 'restarting' && (
          <div
            role="status"
            className={cn(
              'flex items-start gap-2 rounded-lg border p-2.5 text-xs',
              lastResult.ok
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                : 'border-amber-500/30 bg-amber-500/10 text-amber-200',
            )}
          >
            {lastResult.ok ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            )}
            <span>
              {lastResult.ok
                ? `Предыдущее обновление прошло успешно: ${lastResult.from ? `${lastResult.from} → ` : ''}${lastResult.to ?? ''}`
                : `Предыдущее обновление НЕ завершилось: ожидалась версия ${lastResult.expected ?? '—'}, работает ${lastResult.running ?? '—'}. Приложение продолжает работать — повторите обновление.`}
            </span>
          </div>
        )}

        {/* checking */}
        {phase === 'checking' && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-sky-400" aria-hidden />
            Сверяю версию приложения с опубликованным релизом…
          </div>
        )}

        {/* up-to-date: НЕ скачиваем ничего */}
        {phase === 'up-to-date' && info && (
          <div className="space-y-3 py-1">
            <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>Вы уже используете последнюю версию. Скачивать нечего.</span>
            </div>
            <dl className="space-y-1 rounded-lg border border-border bg-background/40 p-3 text-xs">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Текущая версия:</dt>
                <dd className="font-semibold tabular-nums">{info.current}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Последний релиз:</dt>
                <dd className="font-semibold tabular-nums">{info.latest ?? '—'}</dd>
              </div>
            </dl>
          </div>
        )}

        {/* available: версия/имя/дата/размер/примечания */}
        {phase === 'available' && info && (
          <div className="space-y-3 py-1">
            <div className="flex items-start gap-2 rounded-lg border border-sky-400/40 bg-sky-400/10 p-3 text-sm">
              <Download className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" aria-hidden />
              <div className="min-w-0">
                <p className="text-sky-100">
                  Доступна версия <span className="font-bold tabular-nums">{info.latest}</span>
                  {info.releaseName ? ` — ${info.releaseName}` : ''}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {[
                    `у вас: ${info.current}`,
                    info.assetSizeBytes ? `размер: ${fmtBytes(info.assetSizeBytes)}` : null,
                    info.releasedAt ? `опубликован: ${fmtDate(info.releasedAt)}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
            </div>
            {info.releaseNotes && (
              <div className="max-h-32 overflow-y-auto rounded-lg border border-border bg-background/40 p-2.5 text-xs text-muted-foreground">
                <p className="whitespace-pre-wrap break-words">{info.releaseNotes}</p>
              </div>
            )}
            <div className="flex gap-2">
              <Button
                onClick={() => void startInstall()}
                className="min-h-11 flex-1 gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <Download className="h-4 w-4" aria-hidden />
                Скачать и установить
              </Button>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => window.open(info.releasesUrl, '_blank', 'noopener')}
                aria-label="Открыть страницу релизов"
              >
                <ExternalLink className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          </div>
        )}

        {/* downloading: полоса + % + МБ + скорость + ETA */}
        {phase === 'downloading' && (
          <div className="space-y-3 py-1" aria-live="polite">
            <Progress value={progress.percent ?? 0} className="h-2.5" />
            <div className="flex flex-wrap items-center justify-between gap-1 text-xs text-muted-foreground">
              <span className="font-bold tabular-nums text-sky-300">
                {progress.percent != null ? `${Math.floor(progress.percent)}%` : 'скачивание…'}
              </span>
              <span className="tabular-nums">
                {fmtBytes(progress.received)} / {fmtBytes(progress.total)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 tabular-nums">
                <RefreshCw className="h-3 w-3" aria-hidden />
                {fmtSpeed(progress.speed) || 'скорость —'}
              </span>
              <span className="inline-flex items-center gap-1 tabular-nums">
                <Clock3 className="h-3 w-3" aria-hidden />
                {fmtEta(etaSec) || 'остаток —'}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Не закрывайте приложение — установленная версия не трогается до полной проверки файла.
            </p>
          </div>
        )}

        {/* verifying */}
        {phase === 'verifying' && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <ShieldCheck className="h-4 w-4 animate-pulse text-emerald-400" aria-hidden />
            Сверяю SHA-256 скачанного файла с манифестом релиза…
          </div>
        )}

        {/* preparing */}
        {phase === 'preparing' && (
          <div className="space-y-2 py-1" aria-live="polite">
            <div className="flex items-center justify-center gap-2 py-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-sky-400" aria-hidden />
              Готовлю замену EXE и перезапуск…
            </div>
            {shaVerified != null && (
              <p
                className={cn(
                  'rounded-lg border p-2 text-xs',
                  shaVerified
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                    : 'border-amber-500/30 bg-amber-500/10 text-amber-200',
                )}
              >
                {shaVerified
                  ? 'Целостность подтверждена: SHA-256 совпал с манифестом релиза.'
                  : 'Контрольная сумма недоступна в этом релизе — установка продолжена без неё.'}
              </p>
            )}
          </div>
        )}

        {/* restarting */}
        {phase === 'restarting' && (
          <div className="space-y-2 py-1" aria-live="polite">
            <div className="flex items-center justify-center gap-2 py-3 text-sm text-sky-200">
              <Loader2 className="h-4 w-4 animate-spin text-sky-400" aria-hidden />
              Приложение закроется и запустится заново автоматически.
            </div>
            <p className="text-center text-xs text-muted-foreground">
              После запуска новой версии здесь появится подтверждение её версии.
            </p>
          </div>
        )}

        {/* error: стадия + причина + повтор */}
        {phase === 'error' && (
          <div className="space-y-3 py-1">
            <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{error ?? 'Неизвестная ошибка'}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Установленная версия не изменена — можно безопасно повторить попытку или открыть
              страницу релизов и скачать EXE вручную.
            </p>
            <div className="flex gap-2">
              <Button
                onClick={() => void runCheck()}
                variant="outline"
                className="min-h-11 flex-1 gap-2"
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                Проверить снова
              </Button>
              {info && (
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => window.open(info.releasesUrl, '_blank', 'noopener')}
                  aria-label="Открыть страницу релизов"
                >
                  <ExternalLink className="h-4 w-4" aria-hidden />
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Футер: закрыть (недоступен в фазе restarting — приложение и так закрывается) */}
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="min-h-9 gap-1 text-muted-foreground hover:text-foreground"
            disabled={phase === 'restarting'}
            onClick={() => setOpen(false)}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            {phase === 'up-to-date' || phase === 'success' ? 'Закрыть' : 'Отмена'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
