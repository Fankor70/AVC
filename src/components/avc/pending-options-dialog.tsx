'use client'
/**
 * PendingOptionsDialog — выбор варианта после поиска («Скажите номер варианта»).
 */
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { executeCommand } from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import { VoiceCommandType } from '@/lib/avc/types'

export function PendingOptionsDialog() {
  const pending = useAvcStore((s) => s.pendingOptions)
  const setPendingOptions = useAvcStore((s) => s.setPendingOptions)

  const select = (index: number) => {
    void executeCommand({
      type: VoiceCommandType.SelectOption,
      params: { index },
      confidence: 1,
      label: `Вариант ${index}`,
    })
  }

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(o) => {
        if (!o) setPendingOptions(null)
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto avc-scroll sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Найдено несколько вариантов{pending ? `: «${pending.query}»` : ''}
          </DialogTitle>
          <DialogDescription>Скажите номер варианта или кликните по нему.</DialogDescription>
        </DialogHeader>
        <ol className="space-y-2">
          {(pending?.items ?? []).map((item, i) => (
            <li key={`${item.animeId}-${i}`}>
              <button
                onClick={() => select(i + 1)}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-card/60 p-2 text-left transition-all hover:border-sky-400/40 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-sky-400/40 text-sm font-bold text-sky-300">
                  {i + 1}
                </span>
                {item.poster ? (
                  <img
                    src={item.poster}
                    alt=""
                    loading="lazy"
                    className="h-16 w-12 shrink-0 rounded-md border border-border object-cover"
                  />
                ) : (
                  <span className="h-16 w-12 shrink-0 rounded-md border border-border bg-card" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {item.title}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    {item.year !== null && <span>{item.year}</span>}
                    {item.rating !== null && item.rating > 0 && (
                      <Badge className="border border-sky-400/40 bg-sky-400/40 text-[10px] text-sky-300">
                        ★ {item.rating.toFixed(1)}
                      </Badge>
                    )}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </DialogContent>
    </Dialog>
  )
}
