'use client'
/**
 * AutoSkipControls — автопропуск ПРЯМО в панели управления плеером (кнопки
 * видны и в обычном режиме, и в полном экране):
 *
 *  1. «Авто-серия» (FastForward): переключатель settings.autoplayNext — когда
 *     серия закончилась, сама включается следующая (player.tsx → scheduleAutoNext).
 *  2. «Автопропуск» (SlidersHorizontal): popover с ПЕРЕКЛЮЧАТЕЛЯМИ и РАБОЧИМИ
 *     СЛАЙДЕРАМИ опенинга/эндинга — ручные секунды работают даже там, где у сайта
 *     нет таймингов. Как на других сайтах: включил — опенинг перематывается сам.
 *
 * Приоритет источников: если включён «Автопропуск по сайту» (settings.autoSkipIntros)
 * и у серии есть точные тайминги — используются они; иначе — слайдеры.
 * Каждое изменение: мгновенно в store + debounce 600 мс → PUT /api/settings
 * (тот же механизм сохранения, что в SettingsDialog).
 */
import { useEffect, useRef, useState } from 'react'
import { FastForward, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { useAvcStore } from '@/lib/avc/store'
import type { AppSettings } from '@/lib/avc/types'
import { cn } from '@/lib/utils'

const SKY_SLIDER =
  '[&_[data-slot=slider-range]]:bg-sky-400 [&_[data-slot=slider-thumb]]:border-sky-400'

export function AutoSkipControls() {
  const settings = useAvcStore((s) => s.settings)
  const updateSettings = useAvcStore((s) => s.updateSettings)
  const [open, setOpen] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  /** Мгновенно в store, затем debounce → PUT /api/settings (как в SettingsDialog) */
  const change = (partial: Partial<AppSettings>) => {
    updateSettings(partial)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      void fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(useAvcStore.getState().settings),
      }).catch(() => undefined)
    }, 600)
  }

  const opActive = settings.autoSkipOpening || settings.autoSkipIntros
  const edActive = settings.autoSkipEnding || settings.autoSkipIntros

  const barBtn =
    'h-11 w-11 rounded-full text-foreground hover:bg-accent hover:text-sky-300 focus-visible:ring-ring/60 relative'

  return (
    <div className="flex items-center gap-0.5">
      {/* --- Авто-серия: по концу серии сама включается следующая --- */}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Автопереход на следующую серию"
        aria-pressed={settings.autoplayNext}
        title={
          settings.autoplayNext
            ? 'Автопереход на следующую серию: ВКЛ (нажмите, чтобы выключить)'
            : 'Автопереход на следующую серию: выкл (нажмите, чтобы включить)'
        }
        className={cn(
          barBtn,
          settings.autoplayNext && 'bg-sky-400/90 text-sky-950 hover:bg-sky-300 hover:text-sky-950',
        )}
        onClick={() => change({ autoplayNext: !settings.autoplayNext })}
      >
        <FastForward className="h-5 w-5" />
      </Button>

      {/* --- Панель автопропуска: переключатели + слайдеры OP/ED --- */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Настройки автопропуска опенинга и эндинга"
            title="Автопропуск опенинга и эндинга (секунды — слайдерами)"
            className={cn(
              barBtn,
              (opActive || edActive) && 'text-sky-300',
            )}
          >
            <SlidersHorizontal className="h-5 w-5" />
            {(opActive || edActive) && (
              <span
                className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.9)]"
                aria-hidden
              />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={8}
          className="z-[70] w-[19rem] glass border-cyan-200/10 p-4"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-foreground">Автопропуск</p>
            <p className="text-[11px] text-muted-foreground">сохраняется автоматически</p>
          </div>

          {/* Следующая серия */}
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <Label htmlFor="mock-as-next" className="text-sm text-foreground">
                Следующая серия сама
              </Label>
              <p className="text-[11px] text-muted-foreground">
                По окончании серии включится следующая
              </p>
            </div>
            <Switch
              id="autoskip-next"
              checked={settings.autoplayNext}
              onCheckedChange={(v: boolean) => change({ autoplayNext: v })}
              aria-label="Автопереход на следующую серию"
            />
          </div>

          <Separator className="my-3 bg-secondary" />

          {/* Опенинг */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <Label htmlFor="mock-as-op" className="text-sm text-foreground">
                Пропускать опенинг
              </Label>
              <p className="text-[11px] text-muted-foreground">
                Первые <span className="tabular-nums font-semibold text-sky-300">{settings.autoSkipOpeningSec}</span> сек серии
              </p>
            </div>
            <Switch
              id="autoskip-opening"
              checked={settings.autoSkipOpening}
              onCheckedChange={(v: boolean) => change({ autoSkipOpening: v })}
              aria-label="Автопропуск опенинга"
            />
          </div>
          <Slider
            value={[settings.autoSkipOpeningSec]}
            min={0}
            max={180}
            step={5}
            disabled={!settings.autoSkipOpening}
            aria-label="Длительность опенинга, секунд"
            aria-valuetext={`${settings.autoSkipOpeningSec} секунд`}
            className={cn('mt-2.5', SKY_SLIDER, !settings.autoSkipOpening && 'opacity-50')}
            onValueChange={(v: number[]) => {
              const val = Array.isArray(v) ? v[0] : undefined
              if (typeof val === 'number') change({ autoSkipOpeningSec: val })
            }}
          />

          {/* Эндинг */}
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <Label htmlFor="mock-as-ed" className="text-sm text-foreground">
                Пропускать эндинг
              </Label>
              <p className="text-[11px] text-muted-foreground">
                Последние <span className="tabular-nums font-semibold text-sky-300">{settings.autoSkipEndingSec}</span> сек серии
              </p>
            </div>
            <Switch
              id="autoskip-ending"
              checked={settings.autoSkipEnding}
              onCheckedChange={(v: boolean) => change({ autoSkipEnding: v })}
              aria-label="Автопропуск эндинга"
            />
          </div>
          <Slider
            value={[settings.autoSkipEndingSec]}
            min={0}
            max={180}
            step={5}
            disabled={!settings.autoSkipEnding}
            aria-label="Длительность эндинга, секунд"
            aria-valuetext={`${settings.autoSkipEndingSec} секунд`}
            className={cn('mt-2.5', SKY_SLIDER, !settings.autoSkipEnding && 'opacity-50')}
            onValueChange={(v: number[]) => {
              const val = Array.isArray(v) ? v[0] : undefined
              if (typeof val === 'number') change({ autoSkipEndingSec: val })
            }}
          />

          <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
            Точные тайминги с сайта (если есть) используются автоматически и имеют
            приоритет над слайдерами. Серии короче ~5 минут не трогаем.
          </p>
        </PopoverContent>
      </Popover>
    </div>
  )
}
