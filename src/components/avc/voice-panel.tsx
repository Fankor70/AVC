'use client'
/**
 * VoicePanel — нижняя левая панель: кнопка микрофона (push-to-talk),
 * статус голоса, режим микрофона, тестовый ввод команд, последний результат.
 */
import { useEffect, useState } from 'react'
import { Loader2, Mic, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { executeText } from '@/lib/avc/executor'
import { getElectronBridge } from '@/lib/avc/api'
import { useAvcStore } from '@/lib/avc/store'
import type { VoiceApi } from '@/lib/avc/use-voice'
import { cn } from '@/lib/utils'

function statusLine(status: string, message: string): string {
  switch (status) {
    case 'listening':
      return 'Слушаю...'
    case 'recognizing':
      return 'Распознаю...'
    case 'executing':
      return `Выполняю: ${message}`
    case 'error':
      return message || 'Ошибка'
    default:
      // idle тоже может нести полезное сообщение (напр. «Речь не распознана…»)
      return message || '🎤 Готов'
  }
}

export function VoicePanel({ voice }: { voice: VoiceApi }) {
  const voiceStatus = useAvcStore((s) => s.voiceStatus)
  // УРОК РЕЛИЗА 1.0.12: пользователь должен ВИДЕТЬ, готов ли локальный STT,
  // ещё ДО нажатия микрофона — иначе «оно зависло или работает не понятно»
  const [localStt, setLocalStt] = useState<{ ready: boolean; error: string | null; engine?: string } | null>(null)
  const isExe = typeof window !== 'undefined' && !!getElectronBridge()?.ai?.available
  const voiceMessage = useAvcStore((s) => s.voiceMessage)
  const voiceMode = useAvcStore((s) => s.settings.voiceMode)
  const lastExecuted = useAvcStore((s) => s.lastExecuted)
  const [testText, setTestText] = useState('')

  const listening = voiceStatus === 'listening'
  const pushToTalk = voiceMode === 'push-to-talk'

  // Живой уровень микрофона 0..1 (обновляется ~10 раз/с, пока идёт listening)
  const micLevelPct = Math.round(Math.min(1, Math.max(0, voice.micLevel)) * 100)
  const levelColor =
    micLevelPct < 30 ? 'bg-zinc-600' : micLevelPct < 70 ? 'bg-sky-400' : 'bg-rose-500'
  const interim = listening && voice.interimText.trim() ? voice.interimText.trim() : null
  const engineLabel =
    voice.engineName === 'local' ? 'Локально (офлайн)' : voice.engineName === 'browser' ? 'Браузер' : 'Сервер'

  useEffect(() => {
    if (!isExe) return
    const ai = getElectronBridge()?.ai
    let cancelled = false
    const probe = () => {
      void ai
        ?.getStatus()
        .then((st) => {
          if (cancelled) return
          setLocalStt({
            ready: !!st.ready?.stt,
            error: st.workerError ?? (st.ready?.stt ? null : (st.stt?.error ?? 'модели не установлены')),
            engine: st.engine,
          })
        })
        .catch(() => {
          if (!cancelled) setLocalStt({ ready: false, error: 'AI-воркер недоступен' })
        })
    }
    probe()
    const off = ai?.onWorkerState?.(() => setTimeout(probe, 400))
    const timer = setInterval(probe, 20000)
    return () => {
      cancelled = true
      off?.()
      clearInterval(timer)
    }
  }, [isExe])

  const micHandlers = pushToTalk
    ? {
        onPointerDown: () => void voice.startPushToTalk(),
        onPointerUp: () => voice.stopPushToTalkAndProcess(),
        onPointerLeave: () => {
          if (listening) voice.stopPushToTalkAndProcess()
        },
      }
    : { onClick: () => voice.toggleAlwaysListening() }

  const submitTest = (e: React.FormEvent) => {
    e.preventDefault()
    const t = testText.trim()
    if (!t) return
    setTestText('')
    void executeText(t, 'text')
  }

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex shrink-0 flex-col items-center gap-1">
          <button
            {...micHandlers}
            disabled={!voice.isMicSupported}
            aria-label={
              pushToTalk
                ? 'Микрофон: удерживайте для записи'
                : 'Микрофон: переключить постоянное слушание'
            }
            aria-pressed={pushToTalk ? undefined : listening}
            className={cn(
              'flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-40',
              listening
                ? 'animate-pulse border-rose-300/60 bg-rose-500 text-white shadow-[0_0_26px_rgba(244,63,94,0.55)]'
                : 'border-sky-300/50 bg-sky-400 text-sky-950 shadow-[0_0_18px_rgba(56, 189, 248,0.35)] hover:bg-sky-300',
            )}
          >
            <Mic className="h-6 w-6" aria-hidden />
          </button>
          {/* Уровень микрофона: zinc-600 < 30% < sky-400 < 70% < rose-500 */}
          <div
            className="h-1.5 w-14 overflow-hidden rounded-full bg-secondary"
            role="meter"
            aria-label="Уровень микрофона"
            aria-valuenow={micLevelPct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={cn('h-full rounded-full transition-all duration-75', levelColor)}
              style={{ width: `${micLevelPct}%` }}
            />
          </div>
        </div>
        <div className="hidden min-w-0 flex-1 sm:block">
          <div
            className={cn(
              'truncate text-sm font-medium',
              listening && 'text-rose-400',
              voiceStatus === 'error' && 'text-rose-400',
            )}
            aria-live="polite"
          >
            {voiceStatus === 'executing' ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" aria-hidden />
                {statusLine(voiceStatus, voiceMessage)}
              </span>
            ) : (
              statusLine(voiceStatus, voiceMessage)
            )}
            {/* Бейдж фактического движка распознавания */}
            <span
              className="ml-1.5 inline-block rounded border border-border px-1 py-px align-middle text-[10px] font-normal leading-4 text-muted-foreground"
              title="Движок распознавания"
            >
              {engineLabel}
            </span>
            {isExe && localStt && !localStt.ready && (
              <span className="text-[10px] leading-tight text-rose-400" role="status">
                Локальный STT не готов: {localStt.error} — Настройки → AI
              </span>
            )}
            {isExe && localStt?.ready && (
              <span className="text-[10px] leading-tight text-emerald-400" role="status">
                Локальный STT готов ({localStt.engine === 'gigaam-offline' ? 'GigaAM' : 'T-One'})
              </span>
            )}
          </div>
          {interim && (
            <div className="truncate text-xs italic text-muted-foreground" aria-live="polite">
              «{interim}»
            </div>
          )}
          <div
            className={cn(
              'truncate text-xs',
              lastExecuted && !lastExecuted.result.success ? 'text-rose-400' : 'text-emerald-400/90',
            )}
          >
            {lastExecuted
              ? `${lastExecuted.result.success ? '✓' : '✗'} «${lastExecuted.raw}» — ${lastExecuted.result.message}`
              : 'Ctrl + Space — удерживайте для диктовки'}
          </div>
        </div>
      </div>

      <Select
        value={voiceMode}
        onValueChange={(v: string) => voice.setAlwaysListening(v === 'always-listening')}
      >
        <SelectTrigger
          aria-label="Режим микрофона"
          className="h-11 w-full shrink-0 border-border bg-card/60 text-xs sm:w-[168px]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="border-border bg-card">
          <SelectItem value="push-to-talk">🎙 Рация (удерживать)</SelectItem>
          <SelectItem value="always-listening">📡 Постоянное слушание</SelectItem>
        </SelectContent>
      </Select>

      <form onSubmit={submitTest} className="flex min-w-[220px] flex-[2] gap-1.5">
        <Input
          value={testText}
          onChange={(e) => setTestText(e.target.value)}
          placeholder="Тест команды без микрофона: следующая серия"
          aria-label="Тестовая текстовая команда"
          className="h-11 min-w-0 border-border bg-card/60 text-sm placeholder:text-muted-foreground focus-visible:ring-ring/60"
        />
        <Button
          type="submit"
          size="icon"
          aria-label="Выполнить команду"
          className="h-11 w-11 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Send className="h-4 w-4" aria-hidden />
        </Button>
      </form>
    </div>
  )
}
