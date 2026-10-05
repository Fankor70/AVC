/**
 * ASR API — Speech Recognition слой (мастер-промпт #9, #83).
 * Принимает base64 аудио (webm/opus из MediaRecorder, wav, mp3),
 * возвращает распознанный текст (ru).
 */
import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const audioBase64: string | undefined = body?.audio
    if (!audioBase64) {
      return NextResponse.json({ error: 'Поле audio (base64) обязательно' }, { status: 400 })
    }

    const clean = audioBase64.replace(/^data:[^;]+;base64,/, '')
    if (clean.length < 100) {
      return NextResponse.json({ error: 'Аудио слишком короткое' }, { status: 400 })
    }

    const zai = await ZAI.create()
    let text = ''
    // Одна повторная попытка при rate limit (429)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await zai.audio.asr.create({ file_base64: clean })
        text = (response?.text ?? '').trim()
        break
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('429') && attempt === 0) {
          await new Promise((r) => setTimeout(r, 2500))
          continue
        }
        if (msg.includes('429')) {
          return NextResponse.json(
            { error: 'Сервис распознавания речи перегружен. Попробуйте через несколько секунд.' },
            { status: 429 },
          )
        }
        throw e
      }
    }

    return NextResponse.json({ text, success: text.length > 0 })
  } catch (e) {
    console.error('[asr] error:', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Ошибка распознавания речи' },
      { status: 500 },
    )
  }
}
