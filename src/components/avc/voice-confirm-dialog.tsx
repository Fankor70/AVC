'use client'
/**
 * VoiceConfirmDialog — подтверждение переключения озвучки (резолвер не уверен).
 *
 * Управляется store: voiceConfirm = { spoken, match } | null.
 * «Да» → executor.confirmVoiceMatch(), «Нет»/закрытие → executor.cancelVoiceMatch().
 * Фокус автоматически на кнопке «Да» — выбор доступен с клавиатуры.
 */
import { useRef } from 'react'
import { Mic } from 'lucide-react'
import { cancelVoiceMatch, confirmVoiceMatch } from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import type { VoiceProviderMatch } from '@/lib/avc/types'
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

/** Цвет бейджа способа сопоставления резолвера */
const VIA_STYLES: Record<VoiceProviderMatch['matchedVia'], string> = {
  exact: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
  alias: 'border-sky-400/40 bg-sky-400/40 text-sky-300',
  translit: 'border-violet-400/40 bg-violet-400/10 text-violet-300',
  fuzzy: 'border-border bg-accent/60 text-foreground',
}

const VIA_LABELS: Record<VoiceProviderMatch['matchedVia'], string> = {
  exact: 'точное совпадение',
  alias: 'по алиасу',
  translit: 'по произношению',
  fuzzy: 'нечёткое совпадение',
}

export function VoiceConfirmDialog() {
  const voiceConfirm = useAvcStore((s) => s.voiceConfirm)
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null)
  const open = voiceConfirm !== null

  const close = (accept: boolean) => {
    if (accept) confirmVoiceMatch()
    else cancelVoiceMatch()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        // Если озвучка уже подтверждена/отменена кнопками — store пуст, повторно не отменяем
        if (!v && useAvcStore.getState().voiceConfirm) cancelVoiceMatch()
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(e) => {
          // фокус на «Да» — подтверждение доступно с клавиатуры (Enter)
          e.preventDefault()
          confirmBtnRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mic className="h-4 w-4 text-sky-400" aria-hidden />
            Уточним озвучку
          </DialogTitle>
          <DialogDescription>
            {voiceConfirm && (
              <>
                Вы говорите: «<span className="italic text-foreground">{voiceConfirm.spoken}</span>».
                Больше всего похоже на:
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {voiceConfirm && (
          <>
            <div className="rounded-xl border border-border bg-card/60 p-4 text-center">
              <p className="text-lg font-bold text-sky-300">{voiceConfirm.match.name}</p>
              <div className="mt-2 flex items-center justify-center gap-2">
                <Badge
                  variant="outline"
                  className={cn('text-xs', VIA_STYLES[voiceConfirm.match.matchedVia])}
                >
                  {Math.round(voiceConfirm.match.confidence * 100)}%
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {VIA_LABELS[voiceConfirm.match.matchedVia]}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                ref={confirmBtnRef}
                onClick={() => close(true)}
                aria-label="Да, переключить озвучку"
                className="min-h-11 flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Да, переключить
              </Button>
              <Button
                variant="outline"
                onClick={() => close(false)}
                aria-label="Нет, отмена"
                className="min-h-11 flex-1 border-border bg-card/60 hover:border-zinc-500"
              >
                Нет, отмена
              </Button>
            </div>

            <p className="text-xs leading-relaxed text-muted-foreground">
              Не то? Скажите название точнее или выберите озвучку на странице аниме. Уверенные
              команды ({'>'}= 85%) переключаются без вопроса.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
