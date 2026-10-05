'use client'
/**
 * SettingsDialog — настройки приложения. Каждое изменение мгновенно в store,
 * затем debounce 600 мс -> PUT /api/settings.
 *
 * Вкладки:
 *  - Общие: микрофон-режим, wake word, голос, воспроизведение, сайт, приватность;
 *  - Микрофон: движок STT, устройство, усиление/чувствительность, шумоподавление,
 *    тест микрофона (3.5 с запись → WAV 16 кГц → /api/voice/asr) с живым уровнем;
 *  - Озвучки: пользовательские алиасы произношения (требуют входа).
 *
 * Примечание: список устройств берётся напрямую через listMicDevices() — это тот же
 * источник данных, что и voice.micDevices, но диалог не должен зависеть от чужого
 * экземпляра хука useVoice.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Loader2, Mic, RefreshCw, X } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { avcApi, getElectronBridge, type AiCatalogModel, type AiHardwareInfo, type AiStatusSnapshot } from '@/lib/avc/api'
import { useAvcStore } from '@/lib/avc/store'
import type { AiProfile, AppSettings, SttEngine } from '@/lib/avc/types'
import {
  buildAudioConstraints,
  bufferToBase64,
  createMicChain,
  encodeWav16kMono,
  listMicDevices,
  rmsLevel,
  type MicChain,
} from '@/lib/voice/audio-utils'
import { DEFAULT_VOICE_ALIASES } from '@/lib/voice/provider-resolver'
import { clearAniskipCache } from '@/lib/avc/skip/aniskip'
import { Button } from '@/components/ui/button'
import { ModelsManagerCard } from '@/components/avc/models-manager-card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-sky-400/40">
      {children}
    </h3>
  )
}

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function SettingsDialog() {
  const open = useAvcStore((s) => s.settingsOpen)
  const setOpen = useAvcStore((s) => s.setSettingsOpen)
  const settings = useAvcStore((s) => s.settings)
  const updateSettings = useAvcStore((s) => s.updateSettings)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Накопленный за debounce-окно частичный патч: PUT шлёт ТОЛЬКО изменённые поля.
   *  Раньше уходил ВЕСЬ объект settings из store — если значение в БД поменялось
   *  извне (второй экземпляр/правка мимо UI), первое же касание настроек затирало
   *  его устаревшей копией из памяти. */
  const pendingPatchRef = useRef<Partial<AppSettings>>({})

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const change = (partial: Partial<AppSettings>) => {
    updateSettings(partial)
    pendingPatchRef.current = { ...pendingPatchRef.current, ...partial }
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      const patch = pendingPatchRef.current
      pendingPatchRef.current = {}
      void fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).catch(() => undefined)
    }, 600)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>Настройки</DialogTitle>
          <DialogDescription>
            Изменения применяются сразу и сохраняются автоматически.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="general" className="flex min-h-0 flex-1 flex-col gap-3">
          <TabsList className="shrink-0 bg-card/60">
            <TabsTrigger value="general" className="data-[state=active]:text-sky-300">
              Общие
            </TabsTrigger>
            <TabsTrigger value="mic" className="data-[state=active]:text-sky-300">
              Микрофон
            </TabsTrigger>
            <TabsTrigger value="voices" className="data-[state=active]:text-sky-300">
              Озвучки
            </TabsTrigger>
            <TabsTrigger value="ai" className="data-[state=active]:text-sky-300">
              AI
            </TabsTrigger>
          </TabsList>

          <div className="avc-scroll -mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
            {/* ------------------------------------------------ Общие */}
            <TabsContent value="general" className="mt-0 space-y-3">
              <section>
                <SectionTitle>Общие</SectionTitle>
                <div className="py-1">
                  <div className="text-sm text-foreground">Режим микрофона</div>
                  <RadioGroup
                    value={settings.voiceMode}
                    onValueChange={(v: string) =>
                      change({
                        voiceMode: v === 'always-listening' ? 'always-listening' : 'push-to-talk',
                      })
                    }
                    className="mt-2 gap-2"
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="push-to-talk" id="vm-ptt" />
                      <Label htmlFor="vm-ptt" className="text-sm text-foreground">
                        Рация — удерживать кнопку / Ctrl+Space
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="always-listening" id="vm-always" />
                      <Label htmlFor="vm-always" className="text-sm text-foreground">
                        Постоянное слушание (с автоостановкой по тишине)
                      </Label>
                    </div>
                  </RadioGroup>
                </div>
                <SettingRow label="Wake word" hint="Команды только после слова-активатора">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={settings.wakeWordEnabled}
                      onCheckedChange={(v: boolean) => change({ wakeWordEnabled: v })}
                      aria-label="Включить wake word"
                    />
                    <Input
                      value={settings.wakeWord}
                      onChange={(e) => change({ wakeWord: e.target.value })}
                      disabled={!settings.wakeWordEnabled}
                      aria-label="Слово-активатор"
                      className="h-9 w-28 border-border bg-card"
                    />
                  </div>
                </SettingRow>
                <SettingRow label="Режим дивана" hint="Крупный интерфейс с дивана">
                  <Switch
                    checked={settings.couchMode}
                    onCheckedChange={(v: boolean) => change({ couchMode: v })}
                    aria-label="Режим дивана"
                  />
                </SettingRow>
              </section>

              <Separator className="bg-secondary" />

              <section>
                <SectionTitle>Голос</SectionTitle>
                <div className="py-2">
                  <div className="flex items-center justify-between text-sm text-foreground">
                    <span>Порог уверенности</span>
                    <span className="tabular-nums text-sky-300">
                      {Math.round(settings.confidenceThreshold * 100)}%
                    </span>
                  </div>
                  <Slider
                    value={[settings.confidenceThreshold]}
                    min={0.3}
                    max={0.9}
                    step={0.05}
                    aria-label="Порог уверенности распознавания"
                    className="mt-3 [&_[data-slot=slider-range]]:bg-sky-400 [&_[data-slot=slider-thumb]]:border-sky-400"
                    onValueChange={(v: number[]) => {
                      const val = Array.isArray(v) ? v[0] : undefined
                      if (typeof val === 'number') change({ confidenceThreshold: val })
                    }}
                  />
                </div>
              </section>

              <Separator className="bg-secondary" />

              <section>
                <SectionTitle>Воспроизведение</SectionTitle>
                <SettingRow label="Шаг перемотки">
                  <Select
                    value={String(settings.seekStep)}
                    onValueChange={(v: string) => change({ seekStep: Number(v) })}
                  >
                    <SelectTrigger
                      aria-label="Шаг перемотки"
                      className="h-9 w-24 border-border bg-card"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="border-border bg-card">
                      <SelectItem value="5">5 сек</SelectItem>
                      <SelectItem value="10">10 сек</SelectItem>
                      <SelectItem value="30">30 сек</SelectItem>
                      <SelectItem value="60">60 сек</SelectItem>
                    </SelectContent>
                  </Select>
                </SettingRow>
                <SettingRow label="Шаг громкости">
                  <Select
                    value={String(settings.volumeStep)}
                    onValueChange={(v: string) => change({ volumeStep: Number(v) })}
                  >
                    <SelectTrigger
                      aria-label="Шаг громкости"
                      className="h-9 w-24 border-border bg-card"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="border-border bg-card">
                      <SelectItem value="5">5%</SelectItem>
                      <SelectItem value="10">10%</SelectItem>
                      <SelectItem value="20">20%</SelectItem>
                    </SelectContent>
                  </Select>
                </SettingRow>
                <div className="py-2">
                  <div className="flex items-center justify-between text-sm text-foreground">
                    <span>Громкость по умолчанию</span>
                    <span className="tabular-nums text-sky-300">{settings.defaultVolume}%</span>
                  </div>
                  <Slider
                    value={[settings.defaultVolume]}
                    min={0}
                    max={100}
                    step={5}
                    aria-label="Громкость по умолчанию"
                    className="mt-3 [&_[data-slot=slider-range]]:bg-sky-400 [&_[data-slot=slider-thumb]]:border-sky-400"
                    onValueChange={(v: number[]) => {
                      const val = Array.isArray(v) ? v[0] : undefined
                      if (typeof val === 'number') change({ defaultVolume: val })
                    }}
                  />
                </div>
                <SettingRow label="Автопереход к следующей серии">
                  <Switch
                    checked={settings.autoplayNext}
                    onCheckedChange={(v: boolean) => change({ autoplayNext: v })}
                    aria-label="Автопереход к следующей серии"
                  />
                </SettingRow>
                <SettingRow
                  label="Автопропуск опенинга/эндинга"
                  hint="Перематывает интро по таймингам сайта, если они есть"
                >
                  <Switch
                    checked={settings.autoSkipIntros}
                    onCheckedChange={(v: boolean) => change({ autoSkipIntros: v })}
                    aria-label="Автопропуск опенинга и эндинга"
                  />
                </SettingRow>
              </section>

              <Separator className="bg-secondary" />

              {/* --- Skip Segments: пропуск опенинга/эндинга/рекапы --- */}
              <section>
                <SectionTitle>Пропуск опенинга/эндинга</SectionTitle>
                <SettingRow label="Режим пропуска" hint="Кнопка у плеера / автопропуск / выкл">
                  <Select
                    value={settings.skipMode}
                    onValueChange={(v: string) =>
                      change({ skipMode: v === 'auto' ? 'auto' : v === 'off' ? 'off' : 'button' })
                    }
                  >
                    <SelectTrigger aria-label="Режим пропуска" className="h-9 w-44 border-border bg-card text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="border-border bg-card">
                      <SelectItem value="off">Выключено</SelectItem>
                      <SelectItem value="button">Показывать кнопку</SelectItem>
                      <SelectItem value="auto">Автопропуск</SelectItem>
                    </SelectContent>
                  </Select>
                </SettingRow>
                <SettingRow label="Опенинги">
                  <Switch checked={settings.skipOp} onCheckedChange={(v: boolean) => change({ skipOp: v })} aria-label="Пропускать опенинги" />
                </SettingRow>
                <SettingRow label="Эндинги">
                  <Switch checked={settings.skipEd} onCheckedChange={(v: boolean) => change({ skipEd: v })} aria-label="Пропускать эндинги" />
                </SettingRow>
                <SettingRow label="Рекапы">
                  <Switch checked={settings.skipRecap} onCheckedChange={(v: boolean) => change({ skipRecap: v })} aria-label="Пропускать рекапы" />
                </SettingRow>
                <SettingRow label="Тайминги сайта" hint="Источник: skips из данных серии">
                  <Switch checked={settings.skipSourceSite} onCheckedChange={(v: boolean) => change({ skipSourceSite: v })} aria-label="Тайминги сайта" />
                </SettingRow>
                <SettingRow label="Aniskip" hint="Краудсорсинг-таймкоды по MAL ID (открытый API)">
                  <Switch checked={settings.skipSourceAniskip} onCheckedChange={(v: boolean) => change({ skipSourceAniskip: v })} aria-label="Источник Aniskip" />
                </SettingRow>
                <SettingRow
                  label="Секунды fallback"
                  hint="«Пропусти опенинг» без данных перематывает на N секунд"
                >
                  <Select
                    value={String(settings.skipFallbackSec)}
                    onValueChange={(v: string) => change({ skipFallbackSec: Number(v) })}
                  >
                    <SelectTrigger aria-label="Секунды fallback" className="h-9 w-24 border-border bg-card text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="border-border bg-card">
                      {[60, 85, 90, 120].map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n} сек
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingRow>
                <div className="py-2">
                  <div className="flex items-center justify-between text-sm text-foreground">
                    <span>Порог уверенности автопропуска</span>
                    <span className="tabular-nums text-sky-300">{Math.round(settings.skipConfidence * 100)}%</span>
                  </div>
                  <Slider
                    value={[settings.skipConfidence]}
                    min={0.3}
                    max={1}
                    step={0.05}
                    aria-label="Порог уверенности автопропуска"
                    className="mt-3 [&_[data-slot=slider-range]]:bg-sky-400 [&_[data-slot=slider-thumb]]:border-sky-400"
                    onValueChange={(v: number[]) => {
                      const val = Array.isArray(v) ? v[0] : undefined
                      if (typeof val === 'number') change({ skipConfidence: val })
                    }}
                  />
                </div>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-9 border-border text-xs hover:text-rose-300"
                    onClick={() => {
                      void avcApi.skipMarksDelete('anon').then(() => {
                        useAvcStore.getState().bumpSkipMarksVersion()
                        toast({ description: 'Мои отметки таймкодов очищены' })
                      })
                    }}
                  >
                    Очистить мои отметки
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-9 px-2 text-xs text-muted-foreground"
                    onClick={() => {
                      clearAniskipCache()
                      toast({ description: 'Кэш таймкодов Aniskip очищен' })
                    }}
                  >
                    Очистить кэш Aniskip
                  </Button>
                </div>
              </section>

              <Separator className="bg-secondary" />

              <section>
                <SectionTitle>Сайт</SectionTitle>
                <SettingRow label="Базовый URL" hint="Адрес аниме-сайта для адаптера">
                  <Input
                    value={settings.baseUrl}
                    onChange={(e) => change({ baseUrl: e.target.value })}
                    aria-label="Базовый URL сайта"
                    className="h-9 w-56 border-border bg-card text-xs"
                  />
                </SettingRow>
              </section>

              <Separator className="bg-secondary" />

              <section>
                <SectionTitle>Приватность</SectionTitle>
                <SettingRow label="Сохранять историю команд">
                  <Switch
                    checked={settings.saveHistory}
                    onCheckedChange={(v: boolean) => change({ saveHistory: v })}
                    aria-label="Сохранять историю"
                  />
                </SettingRow>
              </section>
            </TabsContent>

            {/* ------------------------------------------------ Микрофон */}
            <TabsContent value="mic" className="mt-0 space-y-3">
              <MicSettings change={change} />
            </TabsContent>

            {/* ------------------------------------------------ Озвучки */}
            <TabsContent value="voices" className="mt-0">
              <VoiceAliasesSettings />
            </TabsContent>

            {/* ------------------------------------------------ Локальный AI */}
            <TabsContent value="ai" className="mt-0">
              <AiSettingsPanel change={change} />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Вкладка «Микрофон»
// ---------------------------------------------------------------------------

function MicSettings({ change }: { change: (partial: Partial<AppSettings>) => void }) {
  const settings = useAvcStore((s) => s.settings)
  const open = useAvcStore((s) => s.settingsOpen)
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [testState, setTestState] = useState<'idle' | 'recording' | 'recognizing'>('idle')
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [liveLevel, setLiveLevel] = useState(0)

  /** Всё, что надо погасить, если диалог закрыли посреди проверки */
  const testCleanupRef = useRef<(() => void) | null>(null)

  const refreshDevices = useCallback(async () => {
    setRefreshing(true)
    try {
      setMicDevices(await listMicDevices())
    } finally {
      setRefreshing(false)
    }
  }, [])

  // Список устройств обновляется при открытии диалога (permission могли выдать недавно)
  useEffect(() => {
    if (open) void refreshDevices()
  }, [open, refreshDevices])

  // Остановка теста при закрытии диалога/размонтировании
  useEffect(() => {
    return () => {
      testCleanupRef.current?.()
    }
  }, [])

  const runMicTest = async () => {
    if (testState !== 'idle') return
    setTestError(null)
    setTestResult(null)
    setLiveLevel(0)

    let stream: MediaStream | null = null
    let chain: MicChain | null = null
    let raf = 0
    let recorder: MediaRecorder | null = null

    const cleanup = () => {
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
      void chain?.ctx.close().catch(() => undefined)
      testCleanupRef.current = null
    }
    testCleanupRef.current = cleanup

    try {
      setTestState('recording')
      stream = await navigator.mediaDevices.getUserMedia({ audio: buildAudioConstraints(settings) })
      chain = createMicChain(stream, settings.micGain)

      // Живой уровень (RMS) с анализатора — уже усиленного сигнала
      const tick = () => {
        setLiveLevel(rmsLevel(chain!.analyser))
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)

      // 3.5 секунды записи из обработанного потока (micGain применён)
      const chunks: Blob[] = []
      recorder = new MediaRecorder(chain.destination.stream)
      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      const stopped = new Promise<void>((resolve) => {
        recorder!.onstop = () => resolve()
      })
      recorder.start()
      await new Promise((r) => setTimeout(r, 3500))
      if (recorder.state !== 'inactive') recorder.stop()
      await stopped

      cleanup()
      setLiveLevel(0)
      setTestState('recognizing')

      // gain уже применён в цепочке — здесь 1, чтобы не усилить дважды
      const wav = await encodeWav16kMono(new Blob(chunks), 1)
      const audio = bufferToBase64(await wav.arrayBuffer())
      const res = await fetch('/api/voice/asr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio, mime: 'audio/wav' }),
      })
      const data = (await res.json()) as { text?: string; error?: string }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      const text = data.text?.trim()
      setTestResult(text ? `Распознано: «${text}»` : 'Речь не распознана — попробуйте ещё раз')
    } catch (e) {
      cleanup()
      setLiveLevel(0)
      setTestError(
        e instanceof Error && e.message ? e.message : 'Не удалось проверить микрофон',
      )
    } finally {
      setTestState('idle')
    }
  }

  const levelPct = Math.round(Math.min(1, Math.max(0, liveLevel)) * 100)
  const levelColor =
    levelPct < 30 ? 'bg-zinc-600' : levelPct < 70 ? 'bg-sky-400' : 'bg-rose-500'

  return (
    <div>
      <section>
        <SectionTitle>Движок распознавания</SectionTitle>
        <SettingRow
          label="Движок STT"
          hint="В EXE «Авто» = локальный офлайн-движок (T-One). Браузерный доступен только в web-версии (Chrome/Edge)"
        >
          <Select
            value={settings.sttEngine}
            onValueChange={(v: string) => change({ sttEngine: v as SttEngine })}
          >
            <SelectTrigger aria-label="Движок распознавания" className="h-9 w-52 border-border bg-card text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-border bg-card">
              <SelectItem value="auto">Авто (браузер → сервер)</SelectItem>
              <SelectItem value="browser">Браузерный (Chrome/Edge)</SelectItem>
              <SelectItem value="server">Серверный (Whisper)</SelectItem>
              <SelectItem value="local">Локальный (T-One, офлайн)</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </section>

      <Separator className="bg-secondary" />

      <section>
        <SectionTitle>Микрофон</SectionTitle>
        <SettingRow
          label="Устройство"
          hint={micDevices.length === 0 ? 'Разрешите доступ к микрофону' : undefined}
        >
          <div className="flex items-center gap-1.5">
            <Select
              value={settings.micDeviceId || '__default__'}
              onValueChange={(v: string) => change({ micDeviceId: v === '__default__' ? '' : v })}
              disabled={micDevices.length === 0}
            >
              <SelectTrigger
                aria-label="Устройство микрофона"
                className="h-9 w-44 border-border bg-card text-xs"
              >
                <SelectValue placeholder="По умолчанию" />
              </SelectTrigger>
              <SelectContent className="border-border bg-card">
                <SelectItem value="__default__">По умолчанию</SelectItem>
                {micDevices.map((d) => (
                  <SelectItem key={d.deviceId} value={d.deviceId}>
                    {d.label || d.deviceId.slice(0, 12)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              aria-label="Обновить список микрофонов"
              title="Обновить список"
              onClick={() => void refreshDevices()}
              className="h-9 w-9 shrink-0 border-border bg-card hover:border-sky-400/40 hover:text-sky-300"
            >
              {refreshing ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-4 w-4" aria-hidden />
              )}
            </Button>
          </div>
        </SettingRow>

        <div className="py-2">
          <div className="flex items-center justify-between text-sm text-foreground">
            <span>Усиление микрофона</span>
            <span className="tabular-nums text-sky-300">×{settings.micGain}</span>
          </div>
          <Slider
            value={[settings.micGain]}
            min={1}
            max={4}
            step={0.25}
            aria-label="Усиление микрофона"
            className="mt-3 [&_[data-slot=slider-range]]:bg-sky-400 [&_[data-slot=slider-thumb]]:border-sky-400"
            onValueChange={(v: number[]) => {
              const val = Array.isArray(v) ? v[0] : undefined
              if (typeof val === 'number') change({ micGain: val })
            }}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Если вы далеко от микрофона — поставьте 2–3
          </p>
        </div>

        <div className="py-2">
          <div className="flex items-center justify-between text-sm text-foreground">
            <span>Чувствительность</span>
            <span className="tabular-nums text-sky-300">{settings.vadSensitivity}</span>
          </div>
          <Slider
            value={[settings.vadSensitivity]}
            min={0}
            max={100}
            step={1}
            aria-label="Чувствительность к тишине"
            className="mt-3 [&_[data-slot=slider-range]]:bg-sky-400 [&_[data-slot=slider-thumb]]:border-sky-400"
            onValueChange={(v: number[]) => {
              const val = Array.isArray(v) ? v[0] : undefined
              if (typeof val === 'number') change({ vadSensitivity: val })
            }}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">Выше = лучше ловит тихую речь</p>
        </div>

        <div className="py-2">
          <div className="flex items-center justify-between text-sm text-foreground">
            <span>Максимальная длительность фразы</span>
            <span className="tabular-nums text-sky-300">
              {Math.round(settings.maxUtteranceMs / 1000)} с
            </span>
          </div>
          <Slider
            value={[settings.maxUtteranceMs]}
            min={4000}
            max={30000}
            step={1000}
            aria-label="Максимальная длительность фразы"
            className="mt-3 [&_[data-slot=slider-range]]:bg-sky-400 [&_[data-slot=slider-thumb]]:border-sky-400"
            onValueChange={(v: number[]) => {
              const val = Array.isArray(v) ? v[0] : undefined
              if (typeof val === 'number') change({ maxUtteranceMs: val })
            }}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Если микрофон обрезает длинные фразы — увеличьте до 20–30 с
          </p>
        </div>

        <SettingRow label="Шумоподавление">
          <Switch
            checked={settings.noiseSuppression}
            onCheckedChange={(v: boolean) => change({ noiseSuppression: v })}
            aria-label="Шумоподавление"
          />
        </SettingRow>
        <SettingRow label="Автоусиление" hint="Автоматическая регулировка усиления (AGC)">
          <Switch
            checked={settings.autoGainControl}
            onCheckedChange={(v: boolean) => change({ autoGainControl: v })}
            aria-label="Автоусиление"
          />
        </SettingRow>
        <SettingRow label="Эхоподавление">
          <Switch
            checked={settings.echoCancellation}
            onCheckedChange={(v: boolean) => change({ echoCancellation: v })}
            aria-label="Эхоподавление"
          />
        </SettingRow>

        {/* Проверка микрофона */}
        <div className="mt-3 rounded-xl border border-border bg-card/60 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-foreground">Проверить микрофон</div>
              <div className="text-xs text-muted-foreground">Запись 3.5 с и серверное распознавание</div>
            </div>
            <Button
              variant="outline"
              onClick={() => void runMicTest()}
              disabled={testState !== 'idle'}
              aria-label="Проверить микрофон"
              className="min-h-11 shrink-0 gap-1.5 border-border bg-card hover:border-sky-400/40 hover:text-sky-300"
            >
              {testState !== 'idle' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Mic className="h-4 w-4" aria-hidden />
              )}
              {testState === 'recording'
                ? 'Говорите…'
                : testState === 'recognizing'
                  ? 'Распознаю…'
                  : 'Проверить'}
            </Button>
          </div>

          {testState === 'recording' && (
            <div
              className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-secondary"
              role="meter"
              aria-label="Уровень записи"
              aria-valuenow={levelPct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={cn('h-full rounded-full transition-all duration-75', levelColor)}
                style={{ width: `${levelPct}%` }}
              />
            </div>
          )}
          {testResult && <p className="mt-2 text-xs text-emerald-400">{testResult}</p>}
          {testError && (
            <p role="alert" className="mt-2 text-xs text-rose-400">
              {testError}
            </p>
          )}
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Вкладка «Озвучки» — пользовательские алиасы произношения
// ---------------------------------------------------------------------------

function VoiceAliasesSettings() {
  const voiceAliases = useAvcStore((s) => s.voiceAliases)
  const setVoiceAliases = useAvcStore((s) => s.setVoiceAliases)
  const [aliasInput, setAliasInput] = useState('')
  const [targetInput, setTargetInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [openList, setOpenList] = useState(false)

  const addAlias = async () => {
    const alias = aliasInput.trim()
    const target = targetInput.trim()
    if (!alias || !target) {
      toast({ variant: 'destructive', description: 'Заполните оба поля' })
      return
    }
    setBusy(true)
    try {
      const row = await avcApi.addAlias(target, alias)
      if (!row) {
        toast({ variant: 'destructive', description: 'Войдите, чтобы сохранять алиасы' })
        return
      }
      setVoiceAliases([...voiceAliases, row])
      setAliasInput('')
      setTargetInput('')
      toast({ description: `Алиас «${alias}» → «${target}» сохранён` })
    } catch {
      toast({ variant: 'destructive', description: 'Не удалось сохранить алиас' })
    } finally {
      setBusy(false)
    }
  }

  const removeAlias = async (id: string) => {
    const ok = await avcApi.deleteAlias(id)
    if (ok) {
      setVoiceAliases(voiceAliases.filter((r) => r.id !== id))
    } else {
      toast({ variant: 'destructive', description: 'Не удалось удалить алиас' })
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-sky-400/40">
          Мои алиасы озвучек
        </h3>
        <p className="text-xs text-muted-foreground">
          Скажите: «добавь ани либрия как команду для AniLibria» — и приложение запомнит
        </p>
      </div>

      {voiceAliases.length > 0 && (
        <ul className="space-y-1.5">
          {voiceAliases.map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card/60 px-2.5 py-2"
            >
              <span className="min-w-0 truncate text-sm">
                <span className="text-foreground">«{row.alias}»</span>
                <span className="mx-1.5 text-muted-foreground">→</span>
                <span className="text-sky-300">{row.targetName}</span>
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Удалить алиас ${row.alias}`}
                onClick={() => void removeAlias(row.id)}
                className="h-8 w-8 shrink-0 rounded-full text-muted-foreground hover:bg-rose-500/10 hover:text-rose-400"
              >
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {(
        <div className="space-y-2 rounded-xl border border-border bg-card/60 p-3">
          <div className="space-y-1.5">
            <Label htmlFor="avc-alias-input" className="text-xs text-muted-foreground">
              Произношение (как вы это говорите)
            </Label>
            <Input
              id="avc-alias-input"
              value={aliasInput}
              onChange={(e) => setAliasInput(e.target.value)}
              placeholder="ани либрия"
              aria-label="Алиас произношения"
              className="h-10 border-border bg-card focus-visible:ring-ring/60"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="avc-alias-target" className="text-xs text-muted-foreground">
              Официальное имя озвучки
            </Label>
            <Input
              id="avc-alias-target"
              value={targetInput}
              onChange={(e) => setTargetInput(e.target.value)}
              placeholder="AniLibria"
              aria-label="Официальное имя озвучки"
              className="h-10 border-border bg-card focus-visible:ring-ring/60"
            />
          </div>
          <Button
            onClick={() => void addAlias()}
            disabled={busy || !aliasInput.trim() || !targetInput.trim()}
            aria-label="Добавить алиас"
            className="min-h-11 w-full gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Добавить
          </Button>
        </div>
      )}

      <Collapsible open={openList} onOpenChange={setOpenList}>
        <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-lg border border-border bg-card/60 px-3 py-2.5 text-xs font-medium text-foreground hover:border-sky-400/40 hover:text-sky-300">
          <ChevronDown
            className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180"
            aria-hidden
          />
          Встроенные варианты произношения
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="mt-2 space-y-1.5 rounded-lg border border-border bg-card/60 p-3">
            {Object.entries(DEFAULT_VOICE_ALIASES).map(([target, aliases]) => (
              <li key={target} className="text-xs leading-relaxed">
                <span className="font-medium text-sky-300">{target}</span>
                <span className="text-muted-foreground"> — </span>
                <span className="text-muted-foreground">{aliases.join(', ')}</span>
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Вкладка «AI» — локальный AI-слой (спецификация §96–§98)
// ---------------------------------------------------------------------------

function AiSettingsPanel({ change }: { change: (partial: Partial<AppSettings>) => void }) {
  const settings = useAvcStore((s) => s.settings)
  const [status, setStatus] = useState<AiStatusSnapshot | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [hardware, setHardware] = useState<AiHardwareInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const isExe = typeof window !== 'undefined' && !!getElectronBridge()?.ai?.available

  const refresh = useCallback(async () => {
    const ai = getElectronBridge()?.ai
    if (!ai?.available) return
    try {
      setStatus(await ai.getStatus())
      setStatusError(null)
      setHardware(await ai.getHardware())
    } catch (e) {
      setStatus(null)
      setStatusError(e instanceof Error ? e.message : 'AI-воркер недоступен')
    }
  }, [])

  useEffect(() => {
    if (!isExe) return
    void refresh()
  }, [isExe, refresh])

  if (!isExe) {
    return (
      <div className="space-y-3">
        <section>
          <SectionTitle>Локальный AI</SectionTitle>
          <p className="py-2 text-sm text-muted-foreground">
            Локальный AI (офлайн-распознавание русской речи: T-One Streaming или GigaAM,
           Silero VAD) доступен в приложении AVC-Anime (EXE). LLM и TTS удалены из релиза
            по решению владельца. В браузере используются браузерное/серверное распознавание.
          </p>
        </section>
      </div>
    )
  }

  const readyBadge = (ready: boolean, state: string, error: string | null) => {
    if (ready) return <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[11px] text-emerald-400">READY</span>
    if (error) return <span className="rounded bg-rose-950 px-1.5 py-0.5 text-[11px] text-rose-400">ОШИБКА</span>
    return <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">{state || 'OFF'}</span>
  }

  return (
    <div className="space-y-3">
      {/* УРОК РЕЛИЗА 1.0.12: состояние AI-воркера и причина его падения — всегда
          видны. Пользователь больше не смотрит на вечный спиннер, не понимая,
          зависло приложение или работает */}
      <AiWorkerStatusCard status={status} onRestart={refresh} />

      {/* Фаза 5 аудита: каталог AI-моделей, безопасная миграция, список моделей */}
      <ModelsManagerCard />

      <Separator className="bg-secondary" />

      {/* Спецификация STT: каталог моделей (ru-fast/ru-accurate) + бенчмарк ПК */}
      <SttCatalogCard onStatusChanged={refresh} status={status} />

      <Separator className="bg-secondary" />

      {/* Живой тест распознавания (паттерн SkyrimNet «Speech-to-Text Test»):
          микрофон → AI-воркер → текст — вся цепочка проверяется одним кликом */}
      <SttLiveTestCard onStatusChanged={refresh} status={status} />

      <Separator className="bg-secondary" />

      <section>
        <SectionTitle>Локальный AI</SectionTitle>
        <SettingRow label="Профиль производительности" hint="Максимальная отзывчивость — минимум задержек (§19)">
          <Select
            value={settings.aiProfile}
            onValueChange={(v: string) => {
              change({ aiProfile: v as AiProfile })
              void getElectronBridge()?.ai?.setProfile(v)
            }}
          >
            <SelectTrigger aria-label="Профиль AI" className="h-9 w-56 border-border bg-card text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-border bg-card">
              <SelectItem value="max_responsiveness">Максимальная отзывчивость</SelectItem>
              <SelectItem value="balanced">Сбалансированный</SelectItem>
              <SelectItem value="quality">Качество</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </section>

      <Separator className="bg-secondary" />

      <section>
        <SectionTitle>Модели и диагностика</SectionTitle>
        {hardware && (
          <div className="mb-2 rounded-md border border-border bg-card/60 p-2 text-xs text-muted-foreground">
            {hardware.cpu} · RAM {hardware.ramHuman}
            {hardware.gpu?.name ? ` · GPU ${hardware.gpu.name}` : ''}
            {hardware.freeDisk != null ? ` · диск ${(hardware.freeDisk / 1024 / 1024 / 1024).toFixed(1)} ГБ` : ''}
          </div>
        )}
        {status ? (
          <div className="space-y-2">
            <div className="grid grid-cols-1 gap-1.5">
              {status.models.map((m) => (
                <div key={m.key} className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-xs">
                  <span className="truncate text-foreground">{m.name}</span>
                  <span className={m.installed ? 'text-emerald-400' : 'text-sky-400'}>
                    {m.installed ? 'Установлено' : 'Не установлено'}
                  </span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-1.5">
              <div className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-xs">
                <span className="text-foreground">
                  STT · {status.activeModel === 'gigaam-v3-russian' || status.activeModel === 'gigaam-v2-russian'
                    ? 'GigaAM (точный)'
                    : 'T-One Streaming (быстрый)'}{' '}
                  — активная модель: {status.activeModel ?? '—'}
                  {status.modelFallback && status.requestedModel && (
                    <span className="text-amber-400"> · модель {status.requestedModel} не установлена — работает эта, скачайте её в каталоге ниже</span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  {status.stt.lastFinalMs != null && <span className="text-muted-foreground">{status.stt.lastFinalMs} мс</span>}
                  {readyBadge(status.ready.stt, status.stt.state, status.stt.error)}
                </span>
              </div>
            </div>
            {status.stt.error && (
              <p className="text-[11px] leading-relaxed text-rose-400">{status.stt.error}</p>
            )}
          </div>
        ) : statusError ? (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-2.5 text-xs text-rose-300">
            ✗ Статус AI недоступен: {statusError}
            <Button variant="outline" size="sm" className="ml-2 min-h-7 border-border px-2 text-[11px]" onClick={() => void refresh()} disabled={busy}>
              Повторить
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Загружаю статус AI…
          </div>
        )}

        <div className="mt-3 flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busy}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Обновить
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await getElectronBridge()?.ai?.initialize()
                await refresh()
                toast({ description: 'AI-сервисы инициализированы' })
              } catch {
                toast({ variant: 'destructive', description: 'Не удалось инициализировать AI-сервисы' })
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            Перезапустить сервисы
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              localStorage.removeItem('avc-ai-setup-dismissed')
              toast({ description: 'Мастер установки откроется при следующем запуске, если модели не установлены' })
            }}
          >
            Мастер установки
          </Button>
        </div>
      </section>
    </div>
  )
}

/**
 * SttCatalogCard — каталог моделей STT (спецификация STT, фазы 3–6):
 * список моделей со статусом/лицензией/рекомендацией, действия
 * «Скачать / Сделать активной / Проверить / Удалить» и встроенный
 * бенчмарк «Проверить скорость на этом ПК» (RTF + рекомендация профиля).
 * Только EXE (в браузере моста нет — блок честно скрыт).
 */
/** МБ/с формат для прогресса загрузки моделей */
function fmtMb(bytes?: number): string {
  if (bytes == null || Number.isNaN(bytes)) return '?'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
  return `${Math.max(0, Math.round(bytes / 1024))} КБ`
}

function SttCatalogCard({
  onStatusChanged,
  status,
}: {
  onStatusChanged: () => void
  status: AiStatusSnapshot | null
}) {
  const ai = getElectronBridge()?.ai
  const [catalog, setCatalog] = useState<AiCatalogModel[] | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [benchBusy, setBenchBusy] = useState(false)
  /** Живой прогресс установки: проценты/скорость/фаза — прямо в строке модели */
  const [progress, setProgress] = useState<{
    id: string
    phase: string
    percent?: number
    receivedBytes?: number
    totalBytes?: number
    speedBps?: number
    message?: string
  } | null>(null)
  /** Персистентные ошибки установки по id модели (не только toast, который легко пропустить) */
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({})
  const [catalogError, setCatalogError] = useState<string | null>(null)

  const refreshCatalog = useCallback(async () => {
    if (!ai?.catalog) return
    try {
      setCatalog(await ai.catalog())
      setCatalogError(null)
    } catch (e) {
      setCatalog(null)
      setCatalogError(e instanceof Error ? e.message : 'Каталог моделей недоступен')
    }
  }, [ai])

  useEffect(() => {
    if (!ai?.catalog) return
    void refreshCatalog()
    // прогресс скачивания модели каталога (та же шина событий, что у мастера)
    const off = ai.onModelProgress?.((p) => {
      if (p.phase === 'downloading') {
        setProgress({
          id: p.id,
          phase: p.phase,
          percent: p.percent,
          receivedBytes: p.receivedBytes,
          totalBytes: p.totalBytes,
          speedBps: p.speedBps,
        })
      } else if (p.phase === 'retrying' || p.phase === 'mirror-fallback') {
        setProgress({ id: p.id, phase: p.phase, message: p.message })
      } else if (p.phase === 'verifying-sha256' || p.phase === 'extracting') {
        setProgress({ id: p.id, phase: p.phase })
      } else if (p.phase === 'error') {
        setProgress(null)
        setInstallErrors((prev) => ({ ...prev, [p.id]: p.error || 'Неизвестная ошибка загрузки' }))
      } else if (p.phase === 'done' || p.phase === 'removed') {
        setProgress(null)
        setInstallErrors((prev) => {
          if (!prev[p.id]) return prev
          const next = { ...prev }
          delete next[p.id]
          return next
        })
        void refreshCatalog()
      }
    })
    return () => off?.()
  }, [ai, refreshCatalog])

  if (!ai?.catalog) return null

  const action = async (key: string, kind: 'install' | 'activate' | 'verify' | 'remove') => {
    const modelId = key.split(':')[1] ?? key
    setBusyKey(key)
    if (kind === 'install') setInstallErrors((prev) => {
      if (!prev[modelId]) return prev
      const next = { ...prev }
      delete next[modelId]
      return next
    })
    try {
      if (kind === 'install') {
        const res = await ai.install!([key])
        const bad = res.find((r) => !r.ok)
        if (bad) setInstallErrors((prev) => ({ ...prev, [modelId]: bad.message ?? bad.kind ?? 'Ошибка установки' }))
        toast({ description: bad ? `Ошибка установки: ${bad.message ?? bad.kind}` : 'Модель установлена' })
      } else if (kind === 'activate') {
        const res = await ai.setSttModel!(key.split(':')[1] ?? key)
        toast({ description: res.message || (res.ok ? 'Модель активирована' : 'Не удалось активировать') })
        onStatusChanged()
      } else if (kind === 'verify') {
        const res = await ai.verifyComponent!(key)
        toast({ description: res.message || (res.ok ? 'Проверка пройдена' : 'Проверка не пройдена') })
      } else {
        const res = await ai.removeComponent!(key)
        toast({ description: res.ok ? 'Модель удалена' : res.message || 'Не удалось удалить' })
      }
      await refreshCatalog()
      onStatusChanged()
    } catch (e) {
      if (kind === 'install') {
        setInstallErrors((prev) => ({ ...prev, [modelId]: e instanceof Error ? e.message : String(e) }))
      }
      toast({ description: e instanceof Error ? e.message : 'Ошибка операции', variant: 'destructive' })
    } finally {
      setBusyKey(null)
    }
  }

  const runBenchmark = async () => {
    if (!ai.benchmark) return
    setBenchBusy(true)
    try {
      const res = await ai.benchmark()
      if (res.ok) {
        toast({ description: `RTF ${res.rtf ?? '?'} · декод ${res.decodeMs} мс / аудио ${res.audioMs} мс` })
      } else {
        toast({ description: res.message || 'Бенчмарк не выполнен', variant: 'destructive' })
      }
      onStatusChanged()
    } finally {
      setBenchBusy(false)
    }
  }

  const activeModel = status?.activeModel

  return (
    <section>
      <SectionTitle>Модели распознавания (STT)</SectionTitle>
      {catalogError ? (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-2.5 text-xs text-rose-300">
          ✗ Каталог моделей недоступен: {catalogError}
          <Button variant="outline" size="sm" className="ml-2 min-h-7 border-border px-2 text-[11px]" onClick={() => void refreshCatalog()}>
            Повторить
          </Button>
        </div>
      ) : !catalog ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Загружаю каталог моделей…
        </div>
      ) : (
        <div className="max-h-96 space-y-2 overflow-y-auto pr-1 [scrollbar-width:thin]">
          {catalog.map((m) => {
            const isActive = activeModel === m.id
            const rowProgress = progress?.id === m.id ? progress : null
            const rowError = installErrors[m.id]
            return (
              <div key={m.key} className={cn('rounded-lg border border-border bg-card/60 p-2.5 text-xs', isActive && 'border-sky-400/60')}>
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <span className="min-w-0 truncate font-medium text-foreground">{m.name}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {m.defaultModel && (
                      <span className="rounded bg-emerald-900 px-1.5 py-0.5 text-[11px] font-medium text-emerald-300">по умолчанию</span>
                    )}
                    {m.profile === 'ru-fast' && (
                      <span className="rounded bg-sky-950 px-1.5 py-0.5 text-[11px] text-sky-300">быстрая</span>
                    )}
                    {m.profile === 'ru-accurate' && (
                      <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[11px] text-emerald-300">точная</span>
                    )}
                    {isActive && (
                      <span className="rounded bg-sky-400 px-1.5 py-0.5 text-[11px] font-semibold text-sky-950">АКТИВНА</span>
                    )}
                    {m.damaged ? (
                      <span
                        className="rounded bg-rose-950 px-1.5 py-0.5 text-[11px] text-rose-400"
                        title={m.damageReason || undefined}
                      >
                        повреждена
                      </span>
                    ) : m.installed ? (
                      <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[11px] text-emerald-400">установлена</span>
                    ) : (
                      <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">не установлена</span>
                    )}
                  </span>
                </div>
                {m.description && <p className="mt-1 leading-relaxed text-muted-foreground">{m.description}</p>}
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {m.sizeHuman} · лицензия: {m.license ?? '—'}
                </p>
                {m.recommendedFor && (
                  <p className="mt-0.5 text-[11px] text-sky-300/80">{m.recommendedFor}</p>
                )}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {!m.installed && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-8 border-border px-2 text-[11px]"
                      disabled={busyKey !== null}
                      onClick={() => void action(m.key, 'install')}
                    >
                      {busyKey === m.key ? <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden /> : null}
                      Скачать
                    </Button>
                  )}
                  {m.installed && !isActive && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-8 border-border px-2 text-[11px] hover:text-sky-300"
                      disabled={busyKey !== null}
                      onClick={() => void action(m.key, 'activate')}
                    >
                      Сделать активной
                    </Button>
                  )}
                  {m.installed && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-h-8 px-2 text-[11px] text-muted-foreground"
                      disabled={busyKey !== null}
                      onClick={() => void action(m.key, 'verify')}
                    >
                      Проверить
                    </Button>
                  )}
                  {m.installed && !m.required && !isActive && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-h-8 px-2 text-[11px] text-muted-foreground hover:text-rose-300"
                      disabled={busyKey !== null}
                      onClick={() => void action(m.key, 'remove')}
                    >
                      Удалить
                    </Button>
                  )}
                </div>
                {/* Живой прогресс установки — прямо в строке модели: %, МБ, скорость */}
                {rowProgress && (
                  <div className="mt-2">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={Math.round(rowProgress.percent ?? 0)} aria-valuemin={0} aria-valuemax={100}>
                      <div
                        className="h-full rounded-full bg-sky-400 transition-[width] duration-300"
                        style={{ width: `${Math.min(100, Math.max(2, rowProgress.percent ?? 0))}%` }}
                      />
                    </div>
                    <p className="mt-1 flex items-center gap-1.5 text-[11px] text-sky-300">
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                      {rowProgress.phase === 'downloading'
                        ? `${Math.round(rowProgress.percent ?? 0)}% · ${fmtMb(rowProgress.receivedBytes)} из ${fmtMb(rowProgress.totalBytes)}${rowProgress.speedBps ? ` · ${fmtMb(rowProgress.speedBps)}/с` : ''}`
                        : rowProgress.phase === 'extracting'
                          ? 'Распаковка архива…'
                          : rowProgress.phase === 'verifying-sha256'
                            ? 'Проверка контрольной суммы…'
                            : rowProgress.message || 'Загрузка…'}
                    </p>
                  </div>
                )}
                {/* Персистентная ошибка установки — не только toast, который легко пропустить */}
                {rowError && !rowProgress && (
                  <div className="mt-2 rounded-md border border-rose-500/30 bg-rose-500/5 p-2 text-[11px] text-rose-300">
                    ✗ Не удалось установить: {rowError}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Бенчмарк: RTF и рекомендация профиля под этот ПК */}
      <div className="mt-3 rounded-lg border border-border bg-card/60 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-foreground">Скорость на этом ПК</span>
          <Button
            variant="outline"
            size="sm"
            className="min-h-8 border-border px-2 text-[11px]"
            disabled={benchBusy || !status?.ready.stt}
            onClick={() => void runBenchmark()}
          >
            {benchBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden /> : null}
            Проверить скорость
          </Button>
        </div>
        {status?.benchmark ? (
          <div className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
            <p>
              RTF <span className="tabular-nums text-foreground">{status.benchmark.rtf ?? '—'}</span> · декод{' '}
              <span className="tabular-nums text-foreground">{status.benchmark.decodeMs}</span> мс за{' '}
              <span className="tabular-nums text-foreground">{status.benchmark.audioMs}</span> мс аудио
            </p>
            <p className="text-sky-300/80">{status.benchmark.recommendation}</p>
          </div>
        ) : (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Замеряет RTF (отношение времени распознавания к длине аудио) и рекомендует профиль.
            RTF &gt; 0.5 — ПК слабый, лучше модель «быстрая» и профиль «Максимальная отзывчивость».
          </p>
        )}
      </div>
    </section>
  )
}

/**
 * SttLiveTestCard — живой тест распознавания одним кликом (паттерн SkyrimNet:
 * страница «Speech-to-Text Test» в настройках). Проверяет ВСЮ цепочку сразу:
 * микрофон → IPC → Silero VAD → активная STT-модель → текст на экране.
 * Честные ошибки: нет микрофона/отказ доступа, STT не готов, воркер мёртв.
 */
function SttLiveTestCard({
  status,
}: {
  status: AiStatusSnapshot | null
  onStatusChanged: () => void
}) {
  const ai = getElectronBridge()?.ai
  const [phase, setPhase] = useState<'idle' | 'recording' | 'finishing' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [partial, setPartial] = useState('')
  const [finals, setFinals] = useState<{ text: string; ms: number }[]>([])
  const [level, setLevel] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const sessionRef = useRef<{
    ctx: AudioContext
    processor: ScriptProcessorNode
    source: MediaStreamAudioSourceNode
    stream: MediaStream
    mute: GainNode
    startedAt: number
    maxTimer: ReturnType<typeof setTimeout>
    raf: number
    finals: { text: string; ms: number }[]
  } | null>(null)

  const teardown = useCallback(() => {
    const s = sessionRef.current
    sessionRef.current = null
    if (!s) return
    try { clearTimeout(s.maxTimer) } catch { /* ок */ }
    try { cancelAnimationFrame(s.raf) } catch { /* ок */ }
    try { s.processor.disconnect() } catch { /* ок */ }
    try { s.source.disconnect() } catch { /* ок */ }
    try { s.stream.getTracks().forEach((t) => t.stop()) } catch { /* ок */ }
    try { void s.ctx.close() } catch { /* ок */ }
  }, [])

  useEffect(() => () => teardown(), [teardown])

  const start = async () => {
    if (!ai?.feedAudio || !ai?.onSttFinal) return
    if (!status?.ready.stt) {
      setPhase('error')
      setError('STT не готов — сначала установите и активируйте модель в каталоге выше')
      return
    }
    setError(null)
    setPartial('')
    setFinals([])
    setElapsed(0)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      const Ctor: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctor({ sampleRate: 16000 })
      const source = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(2048, 1, 1)
      source.connect(processor)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      const buf = new Uint8Array(analyser.fftSize)
      const mute = ctx.createGain()
      mute.gain.value = 0
      processor.connect(mute)
      mute.connect(ctx.destination)

      const session = {
        ctx,
        processor,
        source,
        stream,
        mute,
        startedAt: Date.now(),
        maxTimer: setTimeout(() => void stop(), 10000),
        raf: 0,
        finals: [] as { text: string; ms: number }[],
      }
      sessionRef.current = session
      setPhase('recording')

      const gain = useAvcStore.getState().settings.micGain || 1
      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0)
        const int16 = new Int16Array(input.length)
        for (let i = 0; i < input.length; i++) {
          const a = Math.abs(input[i] * gain)
          const limited = a <= 0.7 ? input[i] * gain : Math.sign(input[i]) * (0.7 + 0.3 * (1 - Math.exp(-(a - 0.7) / 0.3)))
          int16[i] = Math.round(limited * 32767)
        }
        void ai.feedAudio!(int16).catch(() => undefined)
        if (sessionRef.current) {
          analyser.getByteTimeDomainData(buf)
          let peak = 0
          for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128)
          setLevel(peak)
        }
      }
      const tick = () => {
        if (!sessionRef.current) return
        setElapsed(Math.round((Date.now() - session.startedAt) / 100) / 10)
        sessionRef.current.raf = requestAnimationFrame(tick)
      }
      sessionRef.current.raf = requestAnimationFrame(tick)
    } catch (e) {
      setPhase('error')
      setError(e instanceof Error ? `Микрофон недоступен: ${e.message}` : 'Микрофон недоступен')
    }
  }

  const stop = async () => {
    const ai2 = getElectronBridge()?.ai
    if (!ai2) return
    setPhase('finishing')
    try { await ai2.flushStt?.() } catch { /* ок */ }
    // дать финалу дойти (событие stt-final приходит асинхронно)
    setTimeout(() => {
      teardown()
      setLevel(0)
      setPhase('done')
    }, 700)
  }

  // подписка на события STT ТОЛЬКО на время теста (у use-voice своя подписка всегда)
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'finishing') return
    const offP = ai?.onSttPartial?.((p) => {
      if (sessionRef.current) setPartial(p.text || '')
    })
    const offF = ai?.onSttFinal?.((p) => {
      if (!sessionRef.current || !p.text) return
      setFinals((prev) => {
        const next = [...prev, { text: p.text, ms: p.ms ?? 0 }]
        if (sessionRef.current) sessionRef.current.finals = next
        return next
      })
      setPartial('')
    })
    return () => {
      offP?.()
      offF?.()
    }
  }, [ai, phase])

  if (!ai?.feedAudio) return null // web-режим — тест не нужен

  const recording = phase === 'recording'
  return (
    <section className="rounded-lg border border-border bg-card/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <SectionTitle>Проверка распознавания голосом</SectionTitle>
          <p className="text-xs text-muted-foreground">
            Скажите команду (например, «Наруто двадцать серия») — увидите текст, который распознаёт активная модель.
          </p>
        </div>
        {recording || phase === 'finishing' ? (
          <Button variant="outline" size="sm" className="min-h-9 border-border px-3 text-xs" onClick={() => void stop()}>
            {phase === 'finishing' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-rose-500" aria-hidden />}
            Завершить
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="min-h-9 border-border px-3 text-xs" onClick={() => void start()}>
            <Mic className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Проверить
          </Button>
        )}
      </div>

      {(recording || phase === 'finishing') && (
        <div className="mt-2 space-y-1.5">
          <div className="flex items-center gap-2 text-xs text-sky-300">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-rose-500" aria-hidden />
            Слушаю… {elapsed.toFixed(1)} с (автостоп 10 с)
          </div>
          {/* уровень микрофона */}
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary" role="meter" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-emerald-400 transition-[width] duration-75" style={{ width: `${Math.min(100, Math.round(level * 140))}%` }} />
          </div>
          {partial && <p className="text-xs text-muted-foreground">{partial}…</p>}
        </div>
      )}

      {phase === 'done' && (
        <div className="mt-2 space-y-1">
          {finals.length === 0 ? (
            <p className="text-xs text-amber-400">Речь не распознана — проверьте микрофон и уровень сигнала, затем повторите.</p>
          ) : (
            finals.map((f, i) => (
              <p key={i} className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1 text-xs text-emerald-200">
                «{f.text}» <span className="text-[11px] text-muted-foreground">({f.ms} мс)</span>
              </p>
            ))
          )}
        </div>
      )}

      {phase === 'error' && error && (
        <div className="mt-2 rounded-md border border-rose-500/30 bg-rose-500/5 p-2 text-xs text-rose-300">✗ {error}</div>
      )}
    </section>
  )
}

/**
 * AiWorkerStatusCard — честный статус AI-воркера (УРОК РЕЛИЗА 1.0.12:
 * «я не вижу что происходит в приложении, оно зависло или работает»).
 * Живой ответ: воркер запущен/упал + ПРИЧИНА + кнопки перезапуска и логов.
 * Обновляется в реальном времени через onWorkerState.
 */
function AiWorkerStatusCard({
  status,
  onRestart,
}: {
  status: AiStatusSnapshot | null
  onRestart: () => void
}) {
  const ai = getElectronBridge()?.ai
  const [workerState, setWorkerState] = useState<{
    running: boolean
    error: string | null
    quarantine?: { modelId: string; reason: string; to?: string | null; at: string } | null
    safeMode?: { modelId: string; reason?: string; code?: number; at: string } | null
  } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!ai?.onWorkerState) return
    const off = ai.onWorkerState((p) => setWorkerState(p))
    return () => off()
  }, [ai])

  if (!ai?.restartWorker) return null // web-режим — карточка не нужна

  const running = workerState ? workerState.running : status?.worker === 'ok'
  const error = workerState?.error ?? status?.workerError ?? (status?.worker === 'failed' ? status.reason ?? null : null)
  // карантин/безопасный режим: из события воркера или из статуса (после перерисовки)
  const quarantine = workerState?.quarantine ?? status?.quarantine ?? null
  const safeMode = workerState?.safeMode ?? null
  const suspectModelId = quarantine?.modelId ?? safeMode?.modelId ?? null

  /** Переустановить модель-виновника: скачать заново → перезапустить воркер */
  const reinstallSuspect = async () => {
    if (!suspectModelId || !ai.install) return
    setBusy(true)
    try {
      await ai.install([`stt:${suspectModelId}`])
      await ai.restartWorker()
      toast({ description: `Модель ${suspectModelId} переустановлена — воркер перезапущен` })
      onRestart()
    } catch (e) {
      toast({ description: e instanceof Error ? e.message : 'Не удалось переустановить модель', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className={cn(
        'rounded-lg border p-3',
        running ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-rose-500/40 bg-rose-500/5',
      )}
      aria-live="polite"
    >
      {/* Баннер карантина/безопасного режима (урок 0xC0000409): не просто «воркер
          умер», а ЧТО случилось с моделью и ЧТО с этим делать — в один клик */}
      {(quarantine || safeMode) && suspectModelId && (
        <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs">
          <p className="font-medium text-amber-300">
            {quarantine ? 'Карантин модели' : 'Безопасный режим'}: {suspectModelId}
          </p>
          <p className="mt-1 leading-relaxed text-amber-200/90">
            {quarantine
              ? `Файлы модели повреждены (${quarantine.reason}). Модель отключена, голос работает на здоровой модели. Переустановите её, чтобы вернуть точность GigaAM.`
              : `Модель вызвала повторный нативный краш${safeMode?.code ? ` (код ${safeMode.code})` : ''} при целостных файлах. Работает запасная модель. Если краш повторится — сообщите логи в Issue.`}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 min-h-8 border-amber-500/40 px-2 text-[11px] text-amber-200"
            disabled={busy}
            onClick={() => void reinstallSuspect()}
          >
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden /> : null}
            Переустановить {suspectModelId}
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          {running ? (
            <>
              <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
              Голосовой AI-воркер работает
            </>
          ) : (
            <>
              <span className="h-2 w-2 rounded-full bg-rose-500" aria-hidden />
              Голосовой AI-воркер не запущен
            </>
          )}
        </span>
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="min-h-8 border-border px-2 text-[11px]"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                const res = await ai.restartWorker!()
                if (res.ok) toast({ description: 'AI-воркер перезапущен' })
                else toast({ description: `Не удалось запустить воркер: ${res.error ?? 'причина неизвестна'}`, variant: 'destructive' })
                onRestart()
              } catch (e) {
                toast({ description: e instanceof Error ? e.message : 'Ошибка перезапуска', variant: 'destructive' })
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden /> : null}
            Перезапустить
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-8 px-2 text-[11px] text-muted-foreground"
            onClick={() => void ai.openLogsFolder?.().catch(() => undefined)}
          >
            Открыть папку с логами
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {running
          ? `Движок: ${status?.engine === 'gigaam-offline' ? 'GigaAM (точный, офлайн)' : 'T-One Streaming (быстрый)'} · модель: ${status?.activeModel ?? '—'} · распознавание ${status?.ready.stt ? 'ГОТОВО' : 'не готово (модели не установлены?)'}${status?.modelFallback ? ' · запрошенная модель не установлена — работает fallback' : ''}`
          : error
            ? `Причина: ${error} — голосовые команды не работают; текстовые продолжают. Перезапустите воркер; если не помогает — откройте логи и посмотрите последнюю ошибку.`
            : 'Состояние уточняется…'}
      </p>
    </section>
  )
}
