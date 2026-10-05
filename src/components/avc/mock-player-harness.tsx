'use client'
/**
 * MockPlayerHarness — ДИАГНОСТИЧЕСКИЙ стенд автопропуска (/?mockplayer=1).
 *
 * Зачем: kodik/aksor — кросс-доменные iframe, их нельзя открыть в тестовой
 * среде напрямую. Стенд эмулирует ИХ postMessage-протокол один-в-один
 * (команды родителя + события плеера — см. player-bridge.ts) в same-origin
 * blob-iframe с УСКОРЕННЫМ временем (x20: 1 тик 100мс = +2 сек видео),
 * поэтому полный цикл виден за секунды:
 *
 *   старт серии → автопропуск опенинга (слайдер) → проигрывание →
 *   автопропуск эндинга (слайдер) → video_ended → автопереход → серия 2 → …
 *
 * Стенд подменяет только fetch('/api/site/anime/999001') на фиктивные 3 серии
 * (skips: null — сознательно, чтобы тестировались ИМЕННО слайдеры) и сеет
 * playback-контекст; вся остальная цепочка — РЕАЛЬНАЯ: Player, player-bridge,
 * executor (playEpisode/NextEpisode), настройки, persist /api/settings.
 * В продакшене недоступен без явного ?mockplayer=1 в адресе.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Play, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Player } from '@/components/avc/player'
import { executeCommand } from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import { VoiceCommandType } from '@/lib/avc/types'
import type { AnimeDetails } from '@/lib/avc/types'

const MOCK_ANIME_ID = 999001
const EPISODES = 3
/** Длительность «серии» в видео-секундах: ≥ 85 (OP) + 240 (защита) → OP-слайдер
 *  на 85 с и ED-слайдер на 30 с оба проходят порог защиты в player.tsx */
const MOCK_DURATION = 340
/** Ускорение: видео-секунд за тик (тик 100 мс → x20) */
const TICK_STEP = 2

/** HTML mock-плеера: канонический протокол из player-bridge.ts, время x20 */
function makeMockPlayerHtml(): string {
  return `<!doctype html><html><body style="background:#0b1626;color:#7dd3fc;font:12px sans-serif;display:flex;align-items:center;justify-content:center;height:100%;margin:0">MOCK PLAYER</body><script>
'use strict'
var DUR = ${MOCK_DURATION}
var STEP = ${TICK_STEP}
var t = 0
var playing = false
var started = false
function send(msg) { try { parent.postMessage(msg, '*') } catch (e) {} }
function finish() { playing = false; send({ key: 'kodik_player_video_ended' }) }
function seek(sec) {
  t = Math.max(0, Math.min(DUR, Number(sec) || 0))
  send({ key: 'kodik_player_seek', value: { time: t } })
  if (t >= DUR) finish()
}
setInterval(function () {
  if (!playing) return
  t += STEP
  if (t >= DUR) { t = DUR; send({ key: 'kodik_player_time_update', value: t }); finish(); return }
  send({ key: 'kodik_player_time_update', value: t })
}, 100)
window.addEventListener('message', function (e) {
  var d = e.data || {}
  var method = d.key === 'kodik_player_api' && d.value ? d.value.method : null
  if (d.key === 'player_play' || method === 'play') {
    if (!started) {
      started = true
      send({ key: 'player_video_started' })
      send({ key: 'kodik_player_duration_update', value: DUR })
    }
    playing = true
    send({ key: 'player_play' })
  } else if (d.key === 'player_pause' || method === 'pause') {
    playing = false
    send({ key: 'player_pause' })
  } else if (d.key === 'player_seek') {
    seek(d.value)
  } else if (method === 'seek') {
    seek(d.value && d.value.seconds)
  } else if (method === 'get_time') {
    send({ key: 'kodik_player_time', value: t })
  }
  // volume/mute/unmute/speed намеренно игнорируются — на автопропуск не влияют
})
</script></html>`
}

function buildMockDetails(urls: string[]): AnimeDetails {
  return {
    animeId: MOCK_ANIME_ID,
    slug: 'mock-autoskip',
    title: 'MOCK: тест автопропуска',
    poster: null,
    year: 2024,
    rating: null,
    status: null,
    type: 'ТВ-сериал',
    description: 'Диагностический стенд автопропуска (skips: null → работают слайдеры)',
    genres: [],
    studios: [],
    episodesAired: EPISODES,
    episodesTotal: EPISODES,
    dubs: [{ name: 'Mock Dub', shortName: 'MockDub', episodes: [1, 2, 3] }],
    videos: Array.from({ length: EPISODES }, (_, i) => ({
      videoId: i + 1,
      episode: i + 1,
      dubName: 'Mock Dub',
      playerName: 'Mock (протокол kodik, x20)',
      iframeUrl: urls[i],
      duration: MOCK_DURATION,
      skips: null,
    })),
    source: 'demo',
  }
}

export function MockPlayerHarness() {
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  /** blob-URL трёх mock-серий (стабильны между playEpisode внутри автоперехода) */
  const blobUrlsRef = useRef<string[]>([])
  const originalFetchRef = useRef<typeof fetch | null>(null)

  const pushLog = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-14), `${new Date().toLocaleTimeString()} — ${line}`])
  }, [])

  /** Подменить fetch деталей + создать blob-серии; идемпотентно */
  const installStubs = useCallback(() => {
    if (blobUrlsRef.current.length === 0) {
      const html = makeMockPlayerHtml()
      blobUrlsRef.current = Array.from({ length: EPISODES }, () =>
        URL.createObjectURL(new Blob([html], { type: 'text/html' })),
      )
    }
    if (!originalFetchRef.current) {
      originalFetchRef.current = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
        if (url.includes(`/api/site/anime/${MOCK_ANIME_ID}`)) {
          return new Response(JSON.stringify(buildMockDetails(blobUrlsRef.current)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return originalFetchRef.current(input, init)
      }
      pushLog('Стаб /api/site/anime установлен (3 mock-серии, skips: null)')
    }
  }, [pushLog])

  const reset = useCallback(() => {
    const st = useAvcStore.getState()
    st.setPlayer(null, null)
    st.patchPlayback({
      animeId: null,
      animeTitle: null,
      animeSlug: null,
      currentEpisode: null,
      currentDub: null,
      episodesAired: null,
      currentSkips: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
    })
    setRunning(false)
    pushLog('Сброс стенда')
  }, [pushLog])

  // Разборка при размонтировании: возвращаем fetch, освобождаем blob-URL
  useEffect(() => {
    return () => {
      if (originalFetchRef.current) window.fetch = originalFetchRef.current
      originalFetchRef.current = null
      blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u))
      blobUrlsRef.current = []
    }
  }, [])

  const start = useCallback(() => {
    installStubs()
    const st = useAvcStore.getState()
    st.patchPlayback({
      animeId: MOCK_ANIME_ID,
      animeTitle: 'MOCK: тест автопропуска',
      animeSlug: 'mock-autoskip',
      currentEpisode: null, // Play при animeId без серии → playEpisode(1) в executor
      currentDub: null,
      episodesAired: EPISODES,
    })
    setRunning(true)
    pushLog('Запуск: executeCommand(Play) → playEpisode(1) через реальный executor')
    void executeCommand({ type: VoiceCommandType.Play, params: {}, confidence: 1, label: 'Mock: запуск серии' })
  }, [installStubs, pushLog])

  const pb = useAvcStore((s) => s.playback)
  const settings = useAvcStore((s) => s.settings)

  return (
    <div className="min-h-screen bg-[#07111f] p-4 text-foreground">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
        <div className="glass rounded-xl border border-cyan-200/10 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-base font-semibold">Стенд автопропуска (?mockplayer=1)</h1>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Mock-плеер по протоколу kodik, время x20. Смотреть: автопропуск OP (~85 сек
                по слайдеру), ED (последние ~30 сек), конец серии → автопереход (если
                включён). Тайминги сайта выключены (skips: null) — работают СЛАЙДЕРЫ.
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" className="bg-sky-400 text-sky-950 hover:bg-sky-300" onClick={start} disabled={running}>
                <Play className="mr-1 h-4 w-4" /> Запустить серию 1
              </Button>
              <Button size="sm" variant="outline" onClick={reset}>
                <RotateCcw className="mr-1 h-4 w-4" /> Сброс
              </Button>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums text-muted-foreground sm:grid-cols-4">
            <span>серия: <b className="text-sky-300">{pb.currentEpisode ?? '—'}</b></span>
            <span>время: <b className="text-sky-300">{Math.floor(pb.currentTime)}с</b> / {Math.floor(pb.duration)}с</span>
            <span>авто-серия: <b className={settings.autoplayNext ? 'text-emerald-400' : 'text-rose-400'}>{settings.autoplayNext ? 'вкл' : 'выкл'}</b></span>
            <span>слайдеры: <b className="text-sky-300">OP {settings.autoSkipOpeningSec}с</b> / <b className="text-sky-300">ED {settings.autoSkipEndingSec}с</b> ({settings.autoSkipOpening ? 'вкл' : 'выкл'}/{settings.autoSkipEnding ? 'вкл' : 'выкл'})</span>
          </div>
        </div>

        <Player />

        <div className="glass rounded-xl border border-cyan-200/10 p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-sky-400/60">Журнал стенда</p>
          <div className="max-h-40 overflow-y-auto font-mono text-[11px] leading-relaxed text-muted-foreground">
            {log.length === 0 ? <p>— пусто —</p> : log.map((l, i) => <p key={i}>{l}</p>)}
          </div>
        </div>
      </div>
    </div>
  )
}
