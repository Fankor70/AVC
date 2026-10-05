/**
 * ai-stt-selftest — РЕАЛЬНАЯ проверка локального STT (спецификация §5–§21):
 *   1. Инициализация T-One Streaming CTC (8 кГц) + Silero VAD (16 кГц), warm-up, метрики.
 *   2. Тестовые WAV: тестовый файл из пакета модели (реальная русская речь).
 *   3. Стриминговый путь: подача файла окнами 512 сэмплов через feed() → partial/final события
 *      (как будет работать живой микрофон через IPC).
 *   4. Регресс: VAD должен игнорировать тишину (нет final на тишине).
 *   5. Метрики задержек → tools/ai-stt-selftest-report.json.
 * Запуск: node tools/ai-stt-selftest.cjs
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { STTService, readWavAsFloat32, writeWavFromFloat32 } = require('../ai/stt-service.cjs')

const MODELS_DIR = process.env.AVC_MODELS_DIR || path.join(__dirname, '..', 'models')

function floatToWav(file, samples, rate) {
  writeWavFromFloat32(file, samples, rate)
}

async function main() {
  const report = { ranAt: new Date().toISOString(), tests: [] }
  const step = (name, status, detail) => {
    report.tests.push({ name, status, detail })
    console.log(`[${status}] ${name} — ${detail}`)
  }

  // 1) инициализация
  const svc = new STTService({ modelsDir: MODELS_DIR })
  const events = { partial: [], final: [] }
  svc.on('partial', (p) => events.partial.push(p))
  svc.on('final', (p) => events.final.push(p))
  await svc.initialize()
  step('initialize', svc.isReady() ? 'PASS' : 'FAIL', `state=${svc.state}, modelLoadMs=${svc.metrics.modelLoadMs}, warmupMs=${svc.metrics.warmupMs}, err=${svc.error || '—'}`)
  if (!svc.isReady()) return process.exit(1)

  // 2) тест из пакета модели (реальная русская речь)
  const pkgWav = path.join(MODELS_DIR, 'stt', 't-one-russian', '0.wav')
  const info = readWavAsFloat32(pkgWav)
  step('package-wav-format', 'PASS', `sampleRate=${info.sampleRate}, samples=${info.samples.length} (${(info.samples.length / info.sampleRate).toFixed(1)} с)`)
  const dec = svc.decodeFileForTest(pkgWav)
  const text = dec.text.toLowerCase()
  step('package-wav-decode', text.length > 3 ? 'PASS' : 'FAIL', `текст: «${dec.text}» (${dec.ms} мс)`)
  report.decodedText = dec.text

  // 3) стриминговый путь feed() (эмуляция живого микрофона: чанки по 512 сэмплов)
  //    подмешиваем тишину до и после, как в реальном разговоре
  const silence = new Float32Array(info.sampleRate) // 1 с тишины
  const stream = new Float32Array(silence.length + info.samples.length + silence.length)
  stream.set(silence, 0)
  stream.set(info.samples, silence.length)
  stream.set(silence, silence.length + info.samples.length)

  // VAD-путь принимает 16кГц: при необходимости ресемпл up x2 (линейный дубль сэмпла)
  let s16k = stream
  let rate16k = info.sampleRate
  if (info.sampleRate === 8000) {
    rate16k = 16000
    s16k = new Float32Array(stream.length * 2)
    for (let i = 0; i < stream.length; i++) {
      s16k[2 * i] = stream[i]
      s16k[2 * i + 1] = stream[i]
    }
  } else if (info.sampleRate === 24000) {
    rate16k = 16000
    s16k = new Float32Array(Math.floor(stream.length * 2 / 3))
    for (let i = 0; i < s16k.length; i++) s16k[i] = stream[Math.floor(i * 1.5)]
  }
  const int16 = Int16Array.from(s16k, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32768))))

  const t0 = Date.now()
  const CH = 512
  for (let off = 0; off + CH <= int16.length; off += CH) {
    svc.feed(int16.subarray(off, off + CH))
  }
  svc.flush()
  const streamMs = Date.now() - t0
  const finalEvents = events.final.filter((f) => f.text && f.text.trim().length > 0)
  step(
    'streaming-feed',
    finalEvents.length >= 1 ? 'PASS' : 'FAIL',
    `final=${finalEvents.length}, partial=${events.partial.length}, обработка ${streamMs} мс на ${(int16.length / rate16k).toFixed(1)} с аудио; текст: «${(finalEvents[0] || {}).text || '—'}»`,
  )
  report.streaming = { finals: finalEvents, partialCount: events.partial.length, streamMs }

  // 4) регресс: чистая тишина не должна давать final с текстом
  events.final.length = 0
  events.partial.length = 0
  svc.resetUtterance()
  const sil16 = new Int16Array(rate16k * 3) // 3 секунды тишины
  for (let off = 0; off + CH <= sil16.length; off += CH) svc.feed(sil16.subarray(off, off + CH))
  svc.flush()
  const silenceText = events.final.filter((f) => f.text && f.text.trim()).length
  step('silence-no-final', silenceText === 0 ? 'PASS' : 'FAIL', `final с текстом на тишине: ${silenceText} (должно быть 0)`)

  // 5) дедупликация (§14): final на одну фразу ровно один раз
  events.final.length = 0
  svc.resetUtterance()
  for (let off = 0; off + CH <= int16.length; off += CH) svc.feed(int16.subarray(off, off + CH))
  svc.flush()
  svc.flush() // повторный flush не должен дать второй final с текстом
  const dupFinals = events.final.filter((f) => f.text && f.text.trim()).length
  step('dedup-final', dupFinals <= 1 ? 'PASS' : 'FAIL', `final-событий с текстом: ${dupFinals} (допустимо ≤1)`)

  report.metrics = svc.getMetrics()
  fs.writeFileSync(path.join(__dirname, 'ai-stt-selftest-report.json'), JSON.stringify(report, null, 2))
  const failed = report.tests.filter((t) => t.status === 'FAIL').length
  console.log(`\nИтог: ${report.tests.length - failed}/${report.tests.length} PASS; exit=${failed ? 1 : 0}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('stt-selftest crashed:', e)
  process.exit(1)
})
