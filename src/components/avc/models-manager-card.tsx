'use client'
/**
 * ModelsManagerCard — секция «AI-модели» в Настройках (фаза 5 аудита).
 *
 * Только для EXE (Electron-мост). Показывает:
 *  - каталог хранения моделей + занятое место;
 *  - список моделей: назначение/версия/размер/статус установки/обязательность;
 *  - действия: сменить каталог (безопасная миграция: копирование → сверка →
 *    конфиг → рестарт AI-воркера; старая папка не удаляется), открыть в проводнике,
 *    вернуть папку по умолчанию.
 */
import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, FolderInput, HardDriveDownload, Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getElectronBridge, type AiModelsDirConfig, type AiStatusSnapshot } from '@/lib/avc/api'
import { useAvcStore } from '@/lib/avc/store'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'

const PURPOSE_LABEL: Record<string, string> = {
  stt: 'Распознавание речи (STT)',
  vad: 'Детектор речи (VAD)',
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  let v = n
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v.toFixed(v >= 10 || u === 0 ? 0 : 1)} ${units[u]}`
}

export function ModelsManagerCard() {
  const bridge = getElectronBridge()
  const ai = bridge?.ai
  const [config, setConfig] = useState<AiModelsDirConfig | null>(null)
  const [status, setStatus] = useState<AiStatusSnapshot | null>(null)
  const [busy, setBusy] = useState<'pick' | 'open' | 'reset' | null>(null)

  const refresh = useCallback(async () => {
    if (!ai?.getModelsDirConfig) return
    try {
      const [cfg, st] = await Promise.all([
        ai.getModelsDirConfig!(),
        ai.getStatus().catch(() => null),
      ])
      setConfig(cfg)
      if (st) setStatus(st)
    } catch {
      /* мост мог пропасть — молча оставляем прошлое состояние */
    }
  }, [ai])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const changeDir = useCallback(async () => {
    if (!ai?.pickModelsDir || !ai?.setModelsDir) return
    setBusy('pick')
    try {
      const picked = await ai.pickModelsDir()
      if (!picked) return
      const res = await ai.setModelsDir(picked)
      if (res.ok) {
        toast({
          description: res.migrated
            ? `Модели перенесены: ${res.copiedFiles} файлов (${fmtBytes(res.copiedBytes)}). AI перезапущен.`
            : res.message || 'Каталог моделей обновлён',
        })
      } else {
        toast({ description: res.error || 'Не удалось сменить каталог', variant: 'destructive' })
      }
      await refresh()
    } finally {
      setBusy(null)
    }
  }, [ai, refresh])

  const resetDir = useCallback(async () => {
    if (!ai?.setModelsDir || !config) return
    setBusy('reset')
    try {
      const res = await ai.setModelsDir(config.defaultDir)
      if (res.ok) {
        toast({ description: 'Возвращён стандартный каталог: ' + config.defaultDir })
      } else {
        toast({ description: res.error || 'Не удалось вернуть каталог', variant: 'destructive' })
      }
      await refresh()
    } finally {
      setBusy(null)
    }
  }, [ai, config, refresh])

  const openDir = useCallback(async () => {
    if (!ai?.openModelsDir) return
    setBusy('open')
    try {
      const res = await ai.openModelsDir()
      if (!res.ok && res.error) toast({ description: res.error, variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }, [ai])

  if (!ai?.getModelsDirConfig) {
    // web-версия: модели живут на сервере приложения — управление каталогом недоступно
    return null
  }

  const models = status?.models ?? []

  return (
    <section aria-label="AI-модели и хранилище" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">AI-модели и хранилище</h3>
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />}
      </div>

      {/* Каталог хранения */}
      <div className="rounded-lg border border-border bg-card/50 p-3 text-xs">
        <div className="mb-1 flex items-center gap-1.5 font-medium">
          <HardDriveDownload className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          Каталог моделей
        </div>
        <p className="break-all text-muted-foreground" title={config?.currentDir}>
          {config?.currentDir ?? '…'}
        </p>
        <p className="mt-1 text-muted-foreground">
          Занято: {fmtBytes(config?.usedBytes)}
          {config?.configured ? ' · пользовательский каталог' : ' · по умолчанию'}
        </p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" className="h-8" onClick={() => void changeDir()} disabled={busy !== null}>
            <FolderInput className="h-3.5 w-3.5" aria-hidden />
            Изменить папку…
          </Button>
          <Button type="button" size="sm" variant="secondary" className="h-8" onClick={() => void openDir()} disabled={busy !== null}>
            <FolderOpen className="h-3.5 w-3.5" aria-hidden />
            Открыть в проводнике
          </Button>
          {config?.configured && (
            <Button type="button" size="sm" variant="ghost" className="h-8" onClick={() => void resetDir()} disabled={busy !== null}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              По умолчанию
            </Button>
          )}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          При смене папки модели копируются и проверяются; старая папка не удаляется.
        </p>
      </div>

      {/* Список моделей */}
      <div className="max-h-96 space-y-1.5 overflow-y-auto pr-1">
        {models.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {busy
              ? 'Загружаю…'
              : config?.workerError
                ? `AI-воркер не запущен: ${config.workerError} — перезапустите его в карточке выше`
                : 'AI-воркер не запущен — список моделей недоступен (перезапустите в карточке выше)'}
          </p>
        )}
        {models.map((m) => (
          <div
            key={m.key}
            className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card/50 px-3 py-2 text-xs"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 font-medium">
                <span className="truncate">{m.name}</span>
                {m.required ? (
                  <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
                    обязательная
                  </span>
                ) : (
                  <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
                    опциональная
                  </span>
                )}
              </div>
              <div className="text-muted-foreground">
                {PURPOSE_LABEL[m.key] ?? m.key} · {m.id} · {m.sizeHuman}
              </div>
            </div>
            <span
              className={cn(
                'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                m.installed
                  ? 'bg-emerald-500/15 text-emerald-500'
                  : 'bg-amber-500/15 text-amber-500',
              )}
            >
              {m.installed ? 'установлена' : 'не установлена'}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
