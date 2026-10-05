'use client'
/**
 * MiniPlayer — компактный плеер в нижней панели: инфо о тайтле + реальный
 * таймлайн (из событий плеера), управление (prev/-10/play/+10/next),
 * громкость + mute, fullscreen. Команды идут через executor → player-bridge.
 */
import {
  Loader2,
  Maximize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { executeCommand } from '@/lib/avc/executor'
import { sendPlayerCommand, storeToPlayerVolume } from '@/lib/avc/player-bridge'
import { useAvcStore } from '@/lib/avc/store'
import { VoiceCommandType } from '@/lib/avc/types'

/** Секунды → «мм:сс»; неизвестное значение → «--:--» */
function fmtTime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '--:--'
  const total = Math.floor(sec)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function ctrl(type: VoiceCommandType, params: Record<string, string | number | boolean> = {}): void {
  void executeCommand({ type, params, confidence: 1, label: '' })
}

export function MiniPlayer() {
  const animeTitle = useAvcStore((s) => s.playback.animeTitle)
  const currentEpisode = useAvcStore((s) => s.playback.currentEpisode)
  const episodesAired = useAvcStore((s) => s.playback.episodesAired)
  const currentDub = useAvcStore((s) => s.playback.currentDub)
  const isPlaying = useAvcStore((s) => s.playback.isPlaying)
  const volume = useAvcStore((s) => s.playback.volume)
  const currentTime = useAvcStore((s) => s.playback.currentTime)
  const duration = useAvcStore((s) => s.playback.duration)
  const executing = useAvcStore((s) => s.voiceStatus === 'executing')
  const patchPlayback = useAvcStore((s) => s.patchPlayback)
  const setFullscreen = useAvcStore((s) => s.setPlayerFullscreen)

  if (!animeTitle) return null

  const iconBtn =
    'h-10 w-10 rounded-full text-foreground hover:bg-accent hover:text-sky-300 focus-visible:ring-ring/60'

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
      <div className="hidden min-w-0 flex-1 md:block">
        <div className="truncate text-sm font-medium text-foreground" title={animeTitle}>
          {animeTitle}
        </div>
        <div className="flex items-center gap-1 truncate text-xs text-muted-foreground">
          <span className="truncate">
            Серия {currentEpisode ?? '—'}/{episodesAired ?? '—'} · {currentDub ?? 'озвучка не выбрана'}
          </span>
          {executing && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-sky-400" aria-hidden />}
        </div>
        {/* Реальный таймлайн из событий плеера */}
        <div className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
          <span className="text-foreground">{fmtTime(currentTime)}</span>
          <span className="mx-1 text-muted-foreground">/</span>
          {fmtTime(duration > 0 ? duration : null)}
        </div>
      </div>

      <Button variant="ghost" size="icon" aria-label="Предыдущая серия" className={iconBtn} onClick={() => ctrl(VoiceCommandType.PreviousEpisode)}>
        <SkipBack className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" aria-label="Назад на 10 секунд" className={iconBtn} onClick={() => ctrl(VoiceCommandType.SeekBackward, { seconds: 10 })}>
        <RotateCcw className="h-4 w-4" />
      </Button>
      <Button
        size="icon"
        aria-label={isPlaying ? 'Пауза' : 'Воспроизведение'}
        className="h-11 w-11 shrink-0 rounded-full bg-sky-400 text-sky-950 shadow-[0_0_16px_rgba(56, 189, 248,0.35)] hover:bg-sky-300"
        onClick={() => ctrl(VoiceCommandType.TogglePlayPause)}
      >
        {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
      </Button>
      <Button variant="ghost" size="icon" aria-label="Вперёд на 10 секунд" className={iconBtn} onClick={() => ctrl(VoiceCommandType.SeekForward, { seconds: 10 })}>
        <RotateCw className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" aria-label="Следующая серия" className={iconBtn} onClick={() => ctrl(VoiceCommandType.NextEpisode)}>
        <SkipForward className="h-4 w-4" />
      </Button>

      <div className="hidden min-w-0 items-center gap-1.5 sm:flex sm:w-28">
        <Button
          variant="ghost"
          size="icon"
          aria-label={volume > 0 ? 'Выключить звук' : 'Включить звук'}
          title={volume > 0 ? 'Выключить звук' : 'Включить звук'}
          className="h-9 w-9 shrink-0 rounded-full text-muted-foreground hover:bg-accent hover:text-sky-300"
          onClick={() =>
            void executeCommand({
              type: volume > 0 ? VoiceCommandType.Mute : VoiceCommandType.Unmute,
              params: {},
              confidence: 1,
              label: '',
            })
          }
        >
          {volume > 0 ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4 text-rose-400" />}
        </Button>
        <Slider
          value={[volume]}
          min={0}
          max={100}
          step={1}
          aria-label="Громкость"
          onValueChange={(v: number[]) => {
            const val = Array.isArray(v) ? v[0] : volume
            if (typeof val === 'number') {
              patchPlayback({ volume: val })
              sendPlayerCommand({
                key: 'player_set_volume',
                value: { volume: storeToPlayerVolume(val), muted: false },
              })
            }
          }}
          className="w-full [&_[data-slot=slider-range]]:bg-sky-400 [&_[data-slot=slider-thumb]]:border-sky-400"
        />
      </div>

      <Button
        variant="ghost"
        size="icon"
        aria-label="Полный экран"
        className="h-10 w-10 rounded-full text-foreground hover:bg-accent hover:text-sky-300 focus-visible:ring-ring/60"
        onClick={() => setFullscreen(true)}
      >
        <Maximize className="h-4 w-4" />
      </Button>
    </div>
  )
}
