'use client'
/**
 * Глобальные клавиатурные хоткеи плеера (Task 9-a).
 *
 *  Space      — пауза/воспроизведение
 *  ←/→        — перемотка назад/вперёд (с Shift — 30 с, без — 10 с)
 *  ↑/↓        — громкость +/-
 *  N / P      — следующая/предыдущая серия
 *  F          — полноэкранный режим
 *  M          — mute/unmute
 *
 * Игнорируются нажатия в полях ввода (input/textarea/select/contenteditable)
 * и сочетания с Ctrl/Meta (Ctrl+Space push-to-talk обрабатывается в page.tsx).
 * Команды идут через executeCommand — пайплайн/история/тосты работают как для голоса.
 */
import { useEffect } from 'react'
import { executeCommand } from '@/lib/avc/executor'
import { useAvcStore } from '@/lib/avc/store'
import { VoiceCommandType } from '@/lib/avc/types'

function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  )
}

export function Hotkeys(): null {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      if (e.ctrlKey || e.metaKey) return
      if (e.repeat && e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return

      const st = useAvcStore.getState()
      switch (e.code) {
        case 'Space': {
          e.preventDefault()
          void executeCommand({
            type: VoiceCommandType.TogglePlayPause,
            params: {},
            confidence: 1,
            label: 'Пауза/воспроизведение',
          })
          break
        }
        case 'ArrowLeft': {
          e.preventDefault()
          void executeCommand({
            type: VoiceCommandType.SeekBackward,
            params: { seconds: e.shiftKey ? 30 : 10 },
            confidence: 1,
            label: 'Назад',
          })
          break
        }
        case 'ArrowRight': {
          e.preventDefault()
          void executeCommand({
            type: VoiceCommandType.SeekForward,
            params: { seconds: e.shiftKey ? 30 : 10 },
            confidence: 1,
            label: 'Вперёд',
          })
          break
        }
        case 'ArrowUp': {
          e.preventDefault()
          void executeCommand({
            type: VoiceCommandType.VolumeUp,
            params: {},
            confidence: 1,
            label: 'Громче',
          })
          break
        }
        case 'ArrowDown': {
          e.preventDefault()
          void executeCommand({
            type: VoiceCommandType.VolumeDown,
            params: {},
            confidence: 1,
            label: 'Тише',
          })
          break
        }
        case 'KeyN': {
          void executeCommand({
            type: VoiceCommandType.NextEpisode,
            params: {},
            confidence: 1,
            label: 'Следующая серия',
          })
          break
        }
        case 'KeyP': {
          void executeCommand({
            type: VoiceCommandType.PreviousEpisode,
            params: {},
            confidence: 1,
            label: 'Предыдущая серия',
          })
          break
        }
        case 'KeyF': {
          e.preventDefault()
          st.setPlayerFullscreen(!st.playerFullscreen)
          break
        }
        case 'KeyM': {
          void executeCommand(
            st.playback.volume > 0
              ? { type: VoiceCommandType.Mute, params: {}, confidence: 1, label: 'Без звука' }
              : { type: VoiceCommandType.Unmute, params: {}, confidence: 1, label: 'Со звуком' },
          )
          break
        }
        default:
          break
      }
    }
    // capture — чтобы перехватить раньше скролла/кнопок фокуса
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  return null
}
