'use client'
/**
 * Player — iframe-плеер с overlay-управлением: prev/-30/-10/play/+10/+30/next,
 * таймлайн (реальный, из событий плеера), громкость + mute, полный экран.
 *
 * Особенности:
 *  - Один и тот же iframe сохраняется при переходе в fullscreen (меняются только
 *    CSS-классы контейнера).
 *  - РЕАЛЬНЫЙ протокол управления (player-bridge.ts): команды player_play/pause/
 *    seek/set_volume внутрь iframe + события плеера (время, длительность,
 *    громкость, старт/пауза) обратно в store. Таймлайн и isPlaying — не выдумка,
 *    а фактическое состояние плеера.
 *  - АВТО-ЗАПУСК СЕРИИ: после открытия новой серии, если у документа есть
 *    «липкая» user activation (голосовая сессия всегда даёт её — клик по кнопке
 *    микрофона или Ctrl+Space), шлём player_play автоматически через 0.7с/2с.
 *    Серия стартует БЕЗ единого клика; при успехе плеер присылает player_play
 *    и оверлей снимается сам.
 *  - Overlay «Скажите „запусти“ или нажмите»: показывается, пока плеер не
 *    подтвердил старт. Снимается ТРЕМЯ способами: (1) голосом — «запусти»;
 *    (2) кликом (традиционный путь); (3) автоматически, когда пришло событие
 *    старта от плеера. Если активации ещё нет — голосовой запуск подскажет
 *    кликнуть один раз (тост), после чего весь оставшийся сеанс — без рук.
 */
import { useEffect, useRef, useState } from 'react'
import {
  Loader2,
  Maximize,
  Mic,
  Minimize,
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
import { toast } from '@/hooks/use-toast'
import { executeCommand } from '@/lib/avc/executor'
import { AutoSkipControls } from '@/components/avc/auto-skip-panel'
import { avcApi } from '@/lib/avc/api'
import { enabledTypes } from '@/lib/avc/skip/core'
import { resolveSkipSegments } from '@/lib/avc/skip/resolver'
import {
  hasStickyActivation,
  parsePlayerEvent,
  playerToStoreVolume,
  pushPlayerVolume,
  notePlayerActivity,
  registerPlayerElement,
  registerPlayerWindow,
  requestPlayerTime,
  sendPlayerCommand,
  storeToPlayerVolume,
} from '@/lib/avc/player-bridge'
import { useAvcStore } from '@/lib/avc/store'
import { VoiceCommandType } from '@/lib/avc/types'
import { cn } from '@/lib/utils'

/** Секунды → «мм:сс» / «ч:мм:сс»; неизвестное значение → «--:--» */
function fmtTime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '--:--'
  const total = Math.floor(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`
  return `${m}:${ss}`
}

export function Player() {
  const url = useAvcStore((s) => s.playerIframeUrl)
  const playerName = useAvcStore((s) => s.playerPlayerName)
  const fullscreen = useAvcStore((s) => s.playerFullscreen)
  const setFullscreen = useAvcStore((s) => s.setPlayerFullscreen)
  const isPlaying = useAvcStore((s) => s.playback.isPlaying)
  const volume = useAvcStore((s) => s.playback.volume)
  const currentTime = useAvcStore((s) => s.playback.currentTime)
  const duration = useAvcStore((s) => s.playback.duration)
  const executing = useAvcStore((s) => s.voiceStatus === 'executing')
  const settings = useAvcStore((s) => s.settings)
  const skipSegments = useAvcStore((s) => s.skipSegments)
  const skipMarksVersion = useAvcStore((s) => s.skipMarksVersion)

  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  /** URL серии, для которой старт-оверлей уже снят (голосом/кликом/событием плеера).
   *  Новый url → dismissedUrl !== url → оверлей появляется сам, без эффекта. */
  const [dismissedUrl, setDismissedUrl] = useState<string | null>(null)
  const startOverlay = Boolean(url) && url !== dismissedUrl
  /** Подтверждён ли старт (событие от плеера) — для авто-попыток */
  const startedRef = useRef(false)
  /** URL серии, для которой громкость уже протолкнута по событию плеера
   *  (гарантия снятия persist-мьюта плеера — см. pushPlayerVolume) */
  const volumePushedRef = useRef<string | null>(null)
  /** Окно синхронизации громкости: открыто с момента смены серии до первого
   *  проталкивания громкости приложения. Входящие player_volume_change в это
   *  окно игнорируются: плеер при загрузке восстанавливает СВОЙ persist-мьют
   *  и шлёт volume_change{muted:true, volume:0} — если его принять, store
   *  станет 0, и наша же логика «уважать volume 0» закрепит чужой мьют.
   *  После нашего push окно закрывается — реальные изменения громкости
   *  пользователем в UI плеера принимаются как обычно. */
  const volumeSyncOpenRef = useRef(true)
  /** Дожим авто-старта: kodik может грузиться дольше наших таймеров 0.7с/2с —
   *  первое ЖИВОЕ событие от плеера означает, что его диспетчер существует,
   *  и play стоит повторить (ограничено счётчиком попыток). */
  const autoRetryCountRef = useRef(0)
  const autoRetryTimerRef = useRef<number | null>(null)
  /** URL серий, для которых auto-skip уже сработал (opening/ending отдельно) */
  const skippedOpeningRef = useRef<string | null>(null)
  const skippedEndingRef = useRef<string | null>(null)
  /** Таймер автоперехода к следующей серии (autoplayNext) */
  const autoNextTimerRef = useRef<number | null>(null)

  /** Гарантированное снятие собственного мьюта плеера: по первому событию
   *  (в этот момент его видео-элемент u уже создан и команда не будет потеряна) */
  const ensureVolumePushed = (): void => {
    const st = useAvcStore.getState()
    const currentUrl = st.playerIframeUrl
    if (!currentUrl || volumePushedRef.current === currentUrl) return
    volumePushedRef.current = currentUrl
    pushPlayerVolume(st.playback.volume)
    volumeSyncOpenRef.current = false
  }

  /** Повтор play по первому событию плеера (см. autoRetryCountRef) */
  const retryAutoStart = (): void => {
    if (startedRef.current || autoRetryCountRef.current >= 5) return
    autoRetryCountRef.current += 1
    if (autoRetryTimerRef.current !== null) window.clearTimeout(autoRetryTimerRef.current)
    autoRetryTimerRef.current = window.setTimeout(() => {
      autoRetryTimerRef.current = null
      if (startedRef.current || !hasStickyActivation()) return
      pushPlayerVolume(useAvcStore.getState().playback.volume)
      sendPlayerCommand({ key: 'player_play' })
    }, 400)
  }

  /**
   * АВТОПРОПУСК опенинга/эндинга — три источника (приоритет у данных resolver'a):
   *  1. Сегменты SkipResolver (site/aniskip/user): автопропуск только в режиме
   *     «auto», при confidence ≥ порога и включённом типе (skipOp/skipEd);
   *  2. skips из /api/anime/{id}/videos (settings.autoSkipIntros; формат {time,length}
   *     проверен живым API) — если включены и есть у серии;
   *  3. РУЧНЫЕ СЛАЙДЕРЫ у плеера (settings.autoSkipOpening/autoSkipOpeningSec —
   *     «первые N секунд», autoSkipEnding/autoSkipEndingSec — «последние N секунд») —
   *     работают на ЛЮБОЙ серии, даже без таймингов сайта (как на других сайтах).
   * Защита от ложных срабатываний: серия короче (порог + 4 мин) не трогается,
   * срабатывание — ОДИН раз на серию по каждому сегменту.
   */
  const handleAutoSkip = (t: number): void => {
    const st = useAvcStore.getState()
    const url = st.playerIframeUrl
    if (!url) return
    const dur = st.playback.duration
    const apiSkips = st.settings.autoSkipIntros ? st.playback.currentSkips : null
    const MANUAL_MARGIN = 240 // сек: не трогаем видео короче порога + 4 мин
    const autoSegments =
      st.settings.skipMode === 'auto' ? st.skipSegments.filter((s) => s.source !== 'fallback') : []

    // --- ОПЕНИНГ ---
    if (skippedOpeningRef.current !== url) {
      let target: number | null = null
      const opSeg = autoSegments.find((s) => s.type === 'op')
      if (opSeg && st.settings.skipOp && opSeg.confidence >= st.settings.skipConfidence) {
        // задержка автопропуска: не дёргаемся в первые секунды сегмента
        if (t >= opSeg.start + st.settings.skipAutoDelaySec && t < opSeg.end - 1) target = opSeg.end
      } else if (apiSkips?.opening) {
        const end = apiSkips.opening.time + apiSkips.opening.length
        if (t >= apiSkips.opening.time && t < end - 1) target = end
      } else if (st.settings.autoSkipOpening) {
        const sec = st.settings.autoSkipOpeningSec
        if (sec >= 5 && (dur === 0 || dur >= sec + MANUAL_MARGIN) && t >= 0.8 && t < sec - 0.5) {
          target = sec
        }
      }
      if (target !== null) {
        skippedOpeningRef.current = url
        sendPlayerCommand({ key: 'player_seek', value: target })
        st.patchPlayback({ currentTime: target })
        toast({ description: 'Опенинг пропущен' })
      }
    }

    // --- ЭНДИНГ ---
    if (skippedEndingRef.current !== url) {
      let target: number | null = null
      const edSeg = autoSegments.find((s) => s.type === 'ed')
      if (edSeg && st.settings.skipEd && edSeg.confidence >= st.settings.skipConfidence) {
        if (t >= edSeg.start + st.settings.skipAutoDelaySec && t < edSeg.end - 1) target = edSeg.end
      } else if (apiSkips?.ending) {
        const end = apiSkips.ending.time + apiSkips.ending.length
        if (t >= apiSkips.ending.time && t < end - 1) target = end
      } else if (st.settings.autoSkipEnding && dur > 0) {
        const sec = st.settings.autoSkipEndingSec
        // добиваем до самого конца (останется ~0.5с — плеер сам пришлёт video_ended,
        // что честно включает автопереход/концовку как при обычном досмотре)
        if (sec >= 5 && dur >= sec + MANUAL_MARGIN && t >= dur - sec && t < dur - 0.75) {
          target = dur - 0.5
        }
      }
      if (target !== null) {
        skippedEndingRef.current = url
        sendPlayerCommand({ key: 'player_seek', value: target })
        st.patchPlayback({ currentTime: target })
        toast({ description: 'Эндинг пропущен' })
      }
    }
  }

  /** АВТОПЕРЕХОД к следующей серии (kodik_player_video_ended + settings.autoplayNext) */
  const scheduleAutoNext = (): void => {
    if (!useAvcStore.getState().settings.autoplayNext) return
    if (autoNextTimerRef.current !== null) window.clearTimeout(autoNextTimerRef.current)
    autoNextTimerRef.current = window.setTimeout(() => {
      autoNextTimerRef.current = null
      void executeCommand({
        type: VoiceCommandType.NextEpisode,
        params: {},
        confidence: 1,
        label: 'Автопереход: следующая серия',
      })
    }, 1500)
  }

  /** Снять оверлей для текущей серии */
  const dismissOverlay = (why: 'click' | 'player-event'): void => {
    setDismissedUrl(useAvcStore.getState().playerIframeUrl)
    if (why === 'click') {
      // реальный клик даёт активацию → play() со звуком разрешён
      sendPlayerCommand({ key: 'player_play' })
    }
  }

  // Регистрируем окно плеера в мосту (executor шлёт команды через мост);
  // элемент iframe — для фокуса в резервном клавиатурном канале.
  useEffect(() => {
    if (iframeRef.current?.contentWindow) {
      registerPlayerWindow(iframeRef.current.contentWindow)
    }
    registerPlayerElement(iframeRef.current)
    return () => {
      registerPlayerWindow(null)
      registerPlayerElement(null)
    }
  }, [url])

  // SkipResolver: сегменты пропуска для текущей серии (кнопка + голос + автопропуск).
  // Смена серии/озвучки/длительности/настроек/отметок — переразрешение; устаревшие
  // ответы отбрасываются (resolver считает по requestId, здесь — по url).
  useEffect(() => {
    if (!url) return
    useAvcStore.getState().setSkipSegments([])
    const st = useAvcStore.getState()
    if (st.settings.skipMode === 'off') return
    const acc = st.yummyAccount.state === 'loggedIn' ? st.yummyAccount.user?.userId : null
    const accountKey = acc && /^[A-Za-z0-9_-]{1,64}$/.test(acc) ? acc : 'anon'
    let cancelled = false
    void avcApi
      .skipMarksList(accountKey, st.playback.animeId ?? undefined)
      .then((marks) => {
        if (cancelled) return null
        const live = useAvcStore.getState()
        return resolveSkipSegments({
          malId: live.playback.malId,
          episode: live.playback.currentEpisode ?? 1,
          dubId: live.playback.currentDub,
          durationSec: live.playback.duration,
          siteSkips: live.playback.currentSkips,
          userMarks: marks,
          sources: {
            site: live.settings.skipSourceSite,
            aniskip: live.settings.skipSourceAniskip,
          },
          fallback: {
            openingSec: live.settings.autoSkipOpeningSec,
            endingSec: live.settings.autoSkipEndingSec,
            openingEnabled: live.settings.autoSkipOpening,
            endingEnabled: live.settings.autoSkipEnding,
          },
          types: enabledTypes(live.settings),
        })
      })
      .then((res) => {
        if (cancelled || !res) return
        // серия уже сменилась — ответ неактуален
        if (useAvcStore.getState().playerIframeUrl !== url) return
        useAvcStore.getState().setSkipSegments(res.segments)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [url, duration, skipMarksVersion, settings])

  // РЕАЛЬНЫЕ события плеера → store (время, длительность, громкость, старт/пауза)
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      // только сообщения именно от нашего iframe (не от рекламных и т.п.)
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return
      notePlayerActivity() // живой постMessage-канал — резерв клавиш не нужен
      const ev = parsePlayerEvent(e.data)
      if (!ev) return
      const st = useAvcStore.getState()
      // плеер мог загрузиться позже таймеров авто-старта — первое живое событие
      // гарантирует существование его диспетчера: дожимаем play
      if (!startedRef.current) retryAutoStart()
      switch (ev.key) {
        case 'player_play':
        case 'player_video_started':
          startedRef.current = true
          st.patchPlayback({ isPlaying: true })
          setDismissedUrl(st.playerIframeUrl) // старт подтверждён — оверлей снимается сам
          ensureVolumePushed() // снимаем persist-мьют плеера (если ещё не снят)
          break
        case 'player_pause':
          st.patchPlayback({ isPlaying: false })
          break
        case 'kodik_player_video_ended':
          startedRef.current = true
          st.patchPlayback({ isPlaying: false })
          setDismissedUrl(st.playerIframeUrl)
          // settings.autoplayNext — ранее нигде не читался (аудит §3 п.3):
          // теперь реально включает автопереход к следующей серии
          scheduleAutoNext()
          break
        case 'kodik_player_time_update':
          st.patchPlayback({ currentTime: ev.value })
          // страховка: если события play были пропущены (перезагрузка страницы,
          // медленная инициализация) — первый timeupdate тоже гарантирует,
          // что видео-элемент существует и громкость можно применить
          ensureVolumePushed()
          handleAutoSkip(ev.value)
          break
        case 'kodik_player_duration_update':
          st.patchPlayback({ duration: ev.value })
          break
        case 'player_user_seek':
          // пользователь перемотал в UI самого плеера — синхронизируем таймлайн
          st.patchPlayback({ currentTime: ev.value })
          break
        case 'player_volume_change':
          // в окне синхронизации старта серии игнорируем: это не выбор
          // пользователя, а восстановление persist-мьюта плеера
          if (volumeSyncOpenRef.current) break
          st.patchPlayback({ volume: playerToStoreVolume(ev.value.volume) })
          break
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // Новая серия → АВТО-ЗАПУСК (без клика, если активация уже есть)
  useEffect(() => {
    startedRef.current = false
    volumePushedRef.current = null
    volumeSyncOpenRef.current = true
    autoRetryCountRef.current = 0
    skippedOpeningRef.current = null
    skippedEndingRef.current = null
    if (autoRetryTimerRef.current !== null) {
      window.clearTimeout(autoRetryTimerRef.current)
      autoRetryTimerRef.current = null
    }
    if (autoNextTimerRef.current !== null) {
      window.clearTimeout(autoNextTimerRef.current)
      autoNextTimerRef.current = null
    }
    if (!url) return
    // Голосовая сессия всегда даёт «липкую» активацию (клик по микрофону /
    // Ctrl+Space / «Разрешить») → play() со звуком в iframe легален без клика.
    const tryAutoStart = () => {
      if (startedRef.current) return
      if (!hasStickyActivation()) return // нет активации — ждём оверлей/голос
      // громкость — best-effort (плеер может быть ещё не готов), гарантия —
      // ensureVolumePushed() по первому событию плеера
      pushPlayerVolume(useAvcStore.getState().playback.volume)
      sendPlayerCommand({ key: 'player_play' })
    }
    // Seek-kick для KODIK: его state machine может не создать видео-элемент
    // от одного play() (эмпирика: до первого seek метод get_time отвечает
    // undefined, а ПЕРВЫЙ же seek мгновенно даёт video_started). Если к 3.8с
    // старт так и не подтверждён — толкаем микро-seek (+0.2с) и play ещё раз.
    // У aksor безвредно: там startedRef давно true, и kick не выполняется.
    const tryKickStart = () => {
      if (startedRef.current) return
      if (!hasStickyActivation()) return
      const pb = useAvcStore.getState().playback
      sendPlayerCommand({ key: 'player_seek', value: Math.max(0, pb.currentTime) + 0.2 })
      sendPlayerCommand({ key: 'player_play' })
    }
    const t1 = window.setTimeout(tryAutoStart, 700) // плеер успел инициализироваться
    const t2 = window.setTimeout(tryAutoStart, 2000) // страховка (медленная загрузка)
    const t3 = window.setTimeout(tryKickStart, 3800) // kodik: создать видео и стартовать
    const t4 = window.setTimeout(tryKickStart, 5500) // kodik: страховка kick'а
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
      window.clearTimeout(t3)
      window.clearTimeout(t4)
    }
  }, [url])

  // Esc — выход из полного экрана
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen, setFullscreen])

  // Поллинг точного времени (get_time → kodik_player_time): kodik шлёт
  // time_update только при увеличении времени — после перемотки назад его
  // таймлайн без поллинга «замер» бы до догната. Для aksor безвредно.
  useEffect(() => {
    if (!url || !isPlaying) return
    const id = window.setInterval(() => {
      requestPlayerTime()
    }, 1000)
    return () => window.clearInterval(id)
  }, [url, isPlaying])

  /** Кнопки управления: одна точка входа — executor (он шлёт команды через мост) */
  const ctrl = (type: VoiceCommandType, params: Record<string, string | number | boolean> = {}): void => {
    void executeCommand({ type, params, confidence: 1, label: '' })
  }

  const iconBtn =
    'h-11 w-11 rounded-full text-foreground hover:bg-accent hover:text-sky-300 focus-visible:ring-ring/60'
  /** Кнопка ±30: иконка с маленьким бейджем «30» в углу */
  const seekBtn = cn(iconBtn, 'relative')

  // Активный СЕЙЧАС сегмент пропуска: кнопка видна, пока start ≤ t < end − 3
  const activeSkipSeg = (() => {
    if (settings.skipMode === 'off' || !url || startOverlay) return null
    const typeOn = (t: string) =>
      t === 'op' ? settings.skipOp : t === 'ed' ? settings.skipEd : settings.skipRecap
    return (
      skipSegments.find(
        (s) => currentTime >= s.start && currentTime < s.end - 3 && typeOn(s.type),
      ) ?? null
    )
  })()
  const SKIP_LABELS: Record<string, string> = {
    op: 'Пропустить опенинг',
    ed: 'Пропустить эндинг',
    recap: 'Пропустить рекап',
  }

  return (
    <div
      className={cn(
        'flex flex-col bg-black',
        fullscreen
          ? 'fixed inset-0 z-50'
          : 'mx-auto w-full max-w-4xl overflow-hidden rounded-xl border border-border shadow-[0_0_30px_rgba(0,0,0,0.5)]',
      )}
      role="region"
      aria-label="Видеоплеер"
    >
      <div
        className={cn(
          'relative flex w-full items-center justify-center',
          fullscreen ? 'min-h-0 flex-1' : 'aspect-video',
        )}
      >
        {url ? (
          <iframe
            ref={iframeRef}
            src={url}
            title={`Плеер${playerName ? ` — ${playerName}` : ''}`}
            className={cn('h-full w-full', fullscreen ? '' : 'aspect-video')}
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        ) : (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <Play className="h-10 w-10" aria-hidden />
            <p className="max-w-xs px-4 text-center text-sm">
              Выберите серию — плеер появится здесь
            </p>
          </div>
        )}

        {/* Overlay запуска: виден, пока плеер не подтвердил старт. Снимается
            голосом («запусти» → player_play → событие player_play от плеера),
            кликом или автоматически при успешном авто-старте. iframe НЕ
            перезагружается ни в одном из вариантов. */}
        {url && startOverlay && (
          <div
            className="absolute inset-0 z-10 flex cursor-pointer flex-col items-center justify-center gap-4 bg-black/60 backdrop-blur-sm"
            onClick={() => dismissOverlay('click')}
            role="button"
            tabIndex={0}
            aria-label="Запустить серию"
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                dismissOverlay('click')
              }
            }}
          >
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              className={cn(
                'flex items-center justify-center rounded-full bg-sky-400 text-sky-950 shadow-[0_0_40px_rgba(56, 189, 248,0.55)] transition-transform hover:scale-105',
                fullscreen ? 'h-28 w-28' : 'h-[88px] w-[88px]',
              )}
            >
              <Play className={fullscreen ? 'h-14 w-14' : 'h-11 w-11'} aria-hidden />
            </button>
            <div className="px-6 text-center">
              <p className="text-base font-semibold text-foreground sm:text-lg">
                Скажите «запусти» или нажмите
              </p>
              <p className="mt-1 flex items-center justify-center gap-1.5 text-xs text-muted-foreground sm:text-sm">
                <Mic className="h-3.5 w-3.5 text-sky-300" aria-hidden />
                {hasStickyActivation()
                  ? 'Голосовой запуск активен — серия стартует автоматически'
                  : 'Один клик (или старт микрофона) включает голосовое управление'}
              </p>
            </div>
          </div>
        )}

        {/* Кнопка пропуска сегмента (Skip Segments): крупная, доступна с дивана и
            с клавиатуры; работает в fullscreen — fullscreen приложения СВОЙ
            (fixed inset-0 поверх UI), панель хоста не исчезает как в нативном */}
        {activeSkipSeg && (
          <div className="absolute bottom-4 right-4 z-20">
            <Button
              size="sm"
              onClick={() => ctrl(VoiceCommandType.SkipSegment, { type: activeSkipSeg.type })}
              className="min-h-11 gap-2 rounded-lg bg-sky-400 px-4 text-sm font-semibold text-sky-950 shadow-[0_2px_16px_rgba(0,0,0,0.6)] hover:bg-sky-300"
              aria-label={`${SKIP_LABELS[activeSkipSeg.type]} (осталось ${Math.max(0, Math.ceil(activeSkipSeg.end - currentTime))} с)`}
            >
              <SkipForward className="h-4 w-4" aria-hidden />
              {SKIP_LABELS[activeSkipSeg.type]}
              <span className="tabular-nums opacity-80">
                {Math.max(0, Math.ceil(activeSkipSeg.end - currentTime))} с
              </span>
            </Button>
          </div>
        )}
      </div>

      <div
        className={cn(
          'flex flex-wrap items-center gap-1.5 px-3 py-2',
          fullscreen ? 'border-t border-border bg-background/95' : 'bg-background/95',
        )}
      >
        <Button variant="ghost" size="icon" aria-label="Предыдущая серия" className={iconBtn} onClick={() => ctrl(VoiceCommandType.PreviousEpisode)}>
          <SkipBack className="h-5 w-5" />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Назад на 30 секунд" title="Назад на 30 секунд" className={seekBtn} onClick={() => ctrl(VoiceCommandType.SeekBackward, { seconds: 30 })}>
          <RotateCcw className="h-5 w-5" />
          <span className="absolute bottom-0 right-0.5 text-[9px] font-bold leading-none text-muted-foreground" aria-hidden>
            30
          </span>
        </Button>
        <Button variant="ghost" size="icon" aria-label="Назад на 10 секунд" title="Назад на 10 секунд" className={iconBtn} onClick={() => ctrl(VoiceCommandType.SeekBackward, { seconds: 10 })}>
          <RotateCcw className="h-5 w-5" />
        </Button>
        <Button
          size="icon"
          aria-label={isPlaying ? 'Пауза' : 'Воспроизведение'}
          className="h-12 w-12 rounded-full bg-sky-400 text-sky-950 shadow-[0_0_18px_rgba(56, 189, 248,0.4)] hover:bg-sky-300"
          onClick={() => ctrl(VoiceCommandType.TogglePlayPause)}
        >
          {executing ? (
            <Loader2 className="h-6 w-6 animate-spin" />
          ) : isPlaying ? (
            <Pause className="h-6 w-6" />
          ) : (
            <Play className="h-6 w-6" />
          )}
        </Button>
        <Button variant="ghost" size="icon" aria-label="Вперёд на 10 секунд" title="Вперёд на 10 секунд" className={iconBtn} onClick={() => ctrl(VoiceCommandType.SeekForward, { seconds: 10 })}>
          <RotateCw className="h-5 w-5" />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Вперёд на 30 секунд" title="Вперёд на 30 секунд" className={seekBtn} onClick={() => ctrl(VoiceCommandType.SeekForward, { seconds: 30 })}>
          <RotateCw className="h-5 w-5" />
          <span className="absolute bottom-0 right-0.5 text-[9px] font-bold leading-none text-muted-foreground" aria-hidden>
            30
          </span>
        </Button>
        <Button variant="ghost" size="icon" aria-label="Следующая серия" className={iconBtn} onClick={() => ctrl(VoiceCommandType.NextEpisode)}>
          <SkipForward className="h-5 w-5" />
        </Button>

        {/* Реальный таймлайн из событий плеера (kodik_player_time_update/duration_update) */}
        <div className="ml-1 hidden items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground md:flex">
          <span className="text-foreground">{fmtTime(currentTime)}</span>
          <span className="text-muted-foreground">/</span>
          <span>{fmtTime(duration > 0 ? duration : null)}</span>
        </div>

        <div className="ml-1 hidden min-w-0 items-center gap-2 sm:flex sm:w-32">
          <Button
            variant="ghost"
            size="icon"
            aria-label={volume > 0 ? 'Выключить звук' : 'Включить звук'}
            title={volume > 0 ? 'Выключить звук' : 'Включить звук'}
            className="h-9 w-9 shrink-0 rounded-full text-muted-foreground hover:bg-accent hover:text-sky-300"
            onClick={() => ctrl(volume > 0 ? VoiceCommandType.Mute : VoiceCommandType.Unmute)}
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
                useAvcStore.getState().patchPlayback({ volume: val })
                // реальная громкость в плеер (0..2); mute сбрасываем
                sendPlayerCommand({
                  key: 'player_set_volume',
                  value: { volume: storeToPlayerVolume(val), muted: false },
                })
              }
            }}
            className="w-full [&_[data-slot=slider-range]]:bg-sky-400 [&_[data-slot=slider-thumb]]:border-sky-400"
          />
        </div>

        <div className="flex-1" />
        <AutoSkipControls />
        <Button
          variant="ghost"
          size="icon"
          aria-label={fullscreen ? 'Выйти из полного экрана' : 'Полный экран'}
          className={iconBtn}
          onClick={() => setFullscreen(!fullscreen)}
        >
          {fullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
        </Button>
      </div>
    </div>
  )
}
