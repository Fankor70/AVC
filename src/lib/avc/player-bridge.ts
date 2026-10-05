'use client'
/**
 * Player Bridge — двусторонний postMessage-мост к iframe-плеерам YummyAnime.
 *
 * В iframe могут открываться плееры ДВУХ семейств (общий движок Kodik):
 *
 * 1) AKSOR (player.aksor.tv) — команды БЕЗ конверта:
 *      {key:'player_play'} | {key:'player_pause'}
 *      {key:'player_seek', value:<АБСОЛЮТНАЯ секунда>}
 *      {key:'player_set_volume', value:{volume?:0..1, muted?:boolean}}
 *
 * 2) KODIK (kodikplayer.com и прочие хосты с «kodik») — ВСЕ команды только
 *    через конверт 'kodik_player_api' (реверс бандла app.player_single.*.js +
 *    живая проверка postMessage'ями):
 *      {key:'kodik_player_api', value:{method:'play'}}
 *        — до загрузки плеера play запускает загрузку (fallback p() в их коде);
 *      {method:'pause'} | {method:'seek', seconds:<АБСОЛЮТНАЯ секунда>}
 *        — (проверено: seek 10/60/70 → время ровно 10/60/70);
 *      {method:'volume', volume:0..1} | {method:'mute'} | {method:'unmute'}
 *      {method:'speed', speed:0.25..2} | {method:'get_time'} → событие
 *      kodik_player_time со значением (без монотонного фильтра).
 *
 * ПОЧЕМУ «ПЕРЕМОТКА НЕ РАБОТАЛА В KODIK»: kodik молча игнорирует aksor-команды
 * ({key:'player_seek'} не проходит его валидатор — единственный принимаемый
 * ключ 'kodik_player_api'). Поэтому sendPlayerCommand шлёт КАЖДУЮ команду
 * СРАЗУ В ОБОИХ ФОРМАТАХ: свой плеер исполняет «свою» и игнорирует чужую
 * (двойное исполнение идемпотентно: те же play/seek/одинаковое volume).
 *
 * ГРОМКОСТЬ у обоих — шкала 0..1 (живой тест: aksor на set 0.7 рапортует
 * {volume:0.7}; kodik на set 0.5 — {volume:0.5}). Прежнее предположение
 * «0..2 с бустом до 200%» опровергнуто — конвертация /2 УДАЛЕНА (она занижала
 * громкость при синхронизации событий вдвое).
 *
 * СОБЫТИЯ (iframe → родитель, у обоих плееров, фильтр — e.source):
 *   player_play | player_pause | player_video_started (kodik шлёт и голое
 *   'video_started') | kodik_player_video_ended
 *   kodik_player_time_update{value:сек} — kodik шлёт ТОЛЬКО при УВЕЛИЧЕНИИ
 *   времени (после перемотки назад молчит, пока не догонит) — для живого
 *   таймлайна есть get_time-поллинг (requestPlayerTime);
 *   kodik_player_duration_update{value:сек}
 *   player_volume_change / kodik_player_volume_change {muted, volume:0..1}
 *   kodik_player_seek{value:{time}} — эхо перемотки из UI самого плеера.
 *
 * АВТОЗАПУСК ГОЛОСОМ (баг «серия не запускается сама»): топ-окно с «липкой»
 * user activation (клик по микрофону/Ctrl+Space) + allow="autoplay" на iframe
 * легализуют play() со звуком в кросс-доменном iframe без единого клика.
 */
import type { PlaybackContext } from './types'
import { useAvcStore } from './store'

// --- команды родитель → плеер ----------------------------------------------------

/** Общие (приложенческие) команды — мост сам переводит их в проводные форматы */
export type PlayerCommand =
  | { key: 'player_play' }
  | { key: 'player_pause' }
  | { key: 'player_seek'; value: number }
  | { key: 'player_set_volume'; value: { volume?: number; muted?: boolean } }

/** Активное окно iframe-плеера (регистрирует компонент Player) */
let activePlayerWindow: Window | null = null

export function registerPlayerWindow(win: Window | null): void {
  activePlayerWindow = win
}

export function playerWindowAvailable(): boolean {
  return activePlayerWindow !== null
}

// --- резервный клавиатурный канал (только EXE) ---------------------------------

/** iframe-элемент плеера: нужен, чтобы поставить фокус перед инжекцией клавиш */
let activePlayerElement: HTMLIFrameElement | null = null

export function registerPlayerElement(el: HTMLIFrameElement | null): void {
  activePlayerElement = el
}

/** Время последнего ЖИВОГО события от плеера (0 — событий ещё не было) */
let lastPlayerEventAt = 0

export function notePlayerActivity(): void {
  lastPlayerEventAt = Date.now()
}

interface ElectronKeyBridge {
  playerSendKey?: (keys: Array<{ keyCode: string }>) => Promise<boolean>
}

function electronKeyBridge(): ElectronKeyBridge['playerSendKey'] | null {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { avcElectron?: ElectronKeyBridge }).avcElectron
  return typeof api?.playerSendKey === 'function' ? api.playerSendKey : null
}

/** События плеера считаем свежими 6 с: если дольше тишины — postMessage-канал,
 *  вероятно, не работает (сменённый протокол/хост), и командуем клавишами. */
function playerEventsStale(): boolean {
  return lastPlayerEventAt === 0 || Date.now() - lastPlayerEventAt > 6000
}

async function sendKeysToPlayer(keys: string[]): Promise<void> {
  try {
    activePlayerElement?.focus({ preventScroll: true })
  } catch {
    /* кросс-доменный фокус может не удаться — не критично */
  }
  try {
    ;(activePlayerWindow as Window | null)?.focus?.()
  } catch {
    /* как выше */
  }
  const send = electronKeyBridge()
  if (!send) return
  await send(keys.map((keyCode) => ({ keyCode })))
}

function postToPlayer(msg: Record<string, unknown>): boolean {
  const win = activePlayerWindow
  if (!win) return false
  try {
    win.postMessage(msg, '*')
    return true
  } catch {
    return false
  }
}

/** Отправить команду в плеер: дублируем в обоих проводных форматах
 *  (aksor-ключи + конверт kodik_player_api). false — плеер не открыт. */
export function sendPlayerCommand(cmd: PlayerCommand): boolean {
  if (!activePlayerWindow) return false
  // Резервный канал: если события от плеера давно не приходили (протокол сменился,
  // посты не доходят) и мы в EXE — командуем настоящими нажатиями клавиш.
  // ОБА канала сразу не используем: двойной play/pause = отмена действия.
  const viaKeys = electronKeyBridge() !== null && playerEventsStale()
  switch (cmd.key) {
    case 'player_play':
    case 'player_pause':
      if (viaKeys) {
        void sendKeysToPlayer([' '])
        return true
      }
      return [
        postToPlayer({ key: cmd.key }),
        postToPlayer({ key: 'kodik_player_api', value: { method: cmd.key === 'player_play' ? 'play' : 'pause' } }),
      ].some(Boolean)
    case 'player_seek': {
      // оба движка понимают АБСОЛЮТНУЮ секунду (сами клампят к длительности)
      if (!Number.isFinite(cmd.value)) return false
      const sec = Math.max(0, cmd.value)
      if (viaKeys) {
        const pb = useAvcStore.getState().playback
        const delta = sec - (pb.currentTime || 0)
        const presses = Math.max(1, Math.min(16, Math.round(Math.abs(delta) / 10)))
        void sendKeysToPlayer(Array<string>(presses).fill(delta >= 0 ? 'ArrowRight' : 'ArrowLeft'))
        return true
      }
      return [
        postToPlayer({ key: 'player_seek', value: sec }),
        postToPlayer({ key: 'kodik_player_api', value: { method: 'seek', seconds: sec } }),
      ].some(Boolean)
    }
    case 'player_set_volume': {
      const { volume, muted } = cmd.value
      if (muted === true) {
        // aksor: {muted:true, volume:0}; kodik: метод mute
        return [
          postToPlayer({ key: 'player_set_volume', value: { muted: true, volume: 0 } }),
          postToPlayer({ key: 'kodik_player_api', value: { method: 'mute' } }),
        ].some(Boolean)
      }
      let sent = postToPlayer({
        key: 'player_set_volume',
        value: { ...(typeof volume === 'number' ? { volume } : {}), ...(muted !== undefined ? { muted } : {}) },
      })
      if (typeof volume === 'number' && Number.isFinite(volume)) {
        sent =
          postToPlayer({
            key: 'kodik_player_api',
            value: { method: 'volume', volume: Math.min(1, Math.max(0, volume)) },
          }) || sent
      }
      if (muted === false) {
        sent = postToPlayer({ key: 'kodik_player_api', value: { method: 'unmute' } }) || sent
      }
      return sent
    }
  }
}

/** Запросить у плеера точное время (ответ — событие kodik_player_time).
 *  Нужно для kodik: его time_update приходит только при увеличении времени,
 *  после перемотки назад таймлайн без поллинга замер бы до «догона». */
export function requestPlayerTime(): boolean {
  return postToPlayer({ key: 'kodik_player_api', value: { method: 'get_time' } })
}

// --- события плеер → родитель -----------------------------------------------------

export type PlayerEvent =
  | { key: 'player_play' | 'player_pause' | 'player_video_started' | 'kodik_player_video_ended' }
  | {
      key: 'kodik_player_time_update' | 'kodik_player_duration_update' | 'player_user_seek'
      value: number
    }
  | { key: 'player_volume_change'; value: { muted: boolean; volume: number } } // volume 0..1

type NumericEventKey = 'kodik_player_time_update' | 'kodik_player_duration_update' | 'player_user_seek'

function numEvent(key: NumericEventKey, value: unknown): PlayerEvent | null {
  return typeof value === 'number' && Number.isFinite(value) ? { key, value } : null
}

/** Строгий парсер входящих сообщений: принимает варианты ОБОИХ плееров. */
export function parsePlayerEvent(data: unknown): PlayerEvent | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (typeof d.key !== 'string') return null
  switch (d.key) {
    case 'player_play':
    case 'kodik_player_play':
      return { key: 'player_play' }
    case 'player_pause':
    case 'kodik_player_pause':
      return { key: 'player_pause' }
    case 'player_video_started':
    case 'kodik_player_video_started':
    case 'video_started': // kodik шлёт и без префикса
      return { key: 'player_video_started' }
    case 'kodik_player_video_ended':
    case 'video_ended':
      return { key: 'kodik_player_video_ended' }
    case 'kodik_player_time_update':
    case 'kodik_player_time': // ответ на get_time (без монотонного фильтра)
      return numEvent('kodik_player_time_update', d.value)
    case 'kodik_player_duration_update':
      return numEvent('kodik_player_duration_update', d.value)
    case 'player_volume_change':
    case 'kodik_player_volume_change': {
      // шкала 0..1 у обоих (живой тест); kodik иногда шлёт число вместо объекта
      const raw: unknown = d.value
      let muted = false
      let volume = 0
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        volume = raw
      } else if (typeof raw === 'object' && raw !== null) {
        const val = raw as Record<string, unknown>
        muted = val.muted === true
        if (typeof val.volume === 'number' && Number.isFinite(val.volume)) volume = val.volume
      }
      return { key: 'player_volume_change', value: { muted, volume: Math.min(1, Math.max(0, volume)) } }
    }
    case 'kodik_player_seek': {
      // эхо перемотки из UI самого плеера: {value:{time:сек}}
      const raw: unknown = d.value
      const t = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).time : raw
      return numEvent('player_user_seek', t)
    }
    default:
      // player-rendered, kodik_player_current_episode, speed_change, реклама и пр.
      return null
  }
}

// --- громкость: store 0..100 ↔ плеер 0..1 (у обоих семейств) ----------------------

export function storeToPlayerVolume(v100: number): number {
  return Math.min(1, Math.max(0, v100 / 100))
}

export function playerToStoreVolume(v01: number): number {
  return Math.round(Math.min(1, Math.max(0, v01)) * 100)
}

/**
 * Протолкнуть громкость приложения в плеер (+ снять его собственный persist-мьют).
 *
 * Баг «плеер стартует на Mute»: плееры хранят громкость/mute в СВОЁМ localStorage
 * и восстанавливают при каждом открытии серии — один заглохший старт мьютил все
 * последующие. pushPlayerVolume(volume>0) перезаписывает эту память:
 * {volume, muted:false}; при volume===0 (пользователь сам замьютил) уважает выбор.
 * Вызывать при старте серии по таймерам авто-старта (best-effort) и ГАРАНТИРОВАННО
 * по первому событию от плеера (см. player.tsx).
 */
export function pushPlayerVolume(volume100: number): boolean {
  return sendPlayerCommand({
    key: 'player_set_volume',
    value: {
      volume: storeToPlayerVolume(volume100),
      muted: volume100 <= 0,
    },
  })
}

// --- пользовательская активация ---------------------------------------------------

/**
 * Есть ли «липкая» активация документа? Она появляется после ЛЮБОГО клика /
 * нажатия клавиши (например, кнопки микрофона) и не сбрасывается — этого
 * достаточно для легального play() со звуком в iframe с allow="autoplay".
 *
 * ВНИМАНИЕ: в API UserActivation «липкое» свойство называется hasBeenActive
 * (isActive — транзиентное). Имя hasStickyActivation встречалось только в
 * старых черновиках — проверяем его как легаси-фолбэк (ранее из-за него
 * авто-старт молча не срабатывал ВООБЩЕ: свойство всегда было undefined).
 */
export function hasStickyActivation(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userActivation as
    | (UserActivation & { hasStickyActivation?: boolean })
    | undefined
  if (!ua) return false
  return ua.hasBeenActive === true || ua.hasStickyActivation === true
}

/** Типизированный доступ к playback-состоянию (для подсказок в сообщениях) */
export type PlaybackSnapshot = Pick<
  PlaybackContext,
  'isPlaying' | 'currentTime' | 'duration' | 'volume'
>
