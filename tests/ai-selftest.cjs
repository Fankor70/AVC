/**
 * ai-selftest — честная проверка STT-слоя на РЕАЛЬНЫХ моделях (без выдуманных результатов).
 *
 * Запуск:  AVC_MODELS_DIR=/path/to/models node tests/ai-selftest.cjs
 * Требует установленные модели (манифест electron-app/ai/models-manifest.json).
 * Если моделей нет — соответствующие кейсы честно помечаются NOT TESTED (не PASS).
 *
 * Кейсы:
 *   A. GigaAM v3 (дефолт): инициализация + декод test WAV → непустой текст.
 *   B. Integrity-гейт: усечённый encoder → движок ОТКАЗЫВАЕТ честно, процесс НЕ умирает
 *      (урок 0xC0000409: раньше битый ONNX валил процесс SIGABRT/0xC0000409).
 *   C. Карантин + авто-fallback: битый GigaAM + валидный T-One → VoicePipeline
 *      помещает битую модель в карантин и переключается на T-One, STT готов.
 *   D. T-One streaming (запасная): инициализация + декод 0.wav.
 *
 * Итог печатается в stdout в формате PASS/FAIL/SKIP + причина. Exit code ≠ 0 только
 * при FAIL (SKIP допустим — отсутствие моделей не ложный успех).
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const AI = path.join(__dirname, '..', 'electron-app', 'ai')
const MODELS_DIR = process.env.AVC_MODELS_DIR || ''

const results = []
function report(name, status, details) {
  results.push({ name, status, details })
  console.log(`[${status}] ${name}${details ? ` — ${details}` : ''}`)
}

function hasGigaam(dir) {
  const d = path.join(dir, 'stt', 'gigaam-v3-russian')
  return (
    fs.existsSync(path.join(d, 'encoder.int8.onnx')) &&
    fs.existsSync(path.join(d, 'tokens.txt'))
  )
}
function hasTone(dir) {
  return fs.existsSync(path.join(dir, 'stt', 't-one-russian', 'model.onnx'))
}

async function main() {
  console.log(`models dir: ${MODELS_DIR || '(не задан)'}`)

  // --- A. GigaAM валидный ---
  if (MODELS_DIR && hasGigaam(MODELS_DIR)) {
    const { GigaamOfflineEngine } = require(path.join(AI, 'stt-engines.cjs'))
    const eng = new GigaamOfflineEngine({ modelsDir: MODELS_DIR, modelId: 'gigaam-v3-russian', profile: 'balanced' })
    const state = await eng.initialize()
    if (state !== 'ready') {
      report('A: GigaAM init+decode', 'FAIL', `state=${state}, error=${eng.error}`)
    } else {
      const wav = path.join(MODELS_DIR, 'stt', 'gigaam-v3-russian', 'test_wavs', 'example.wav')
      if (!fs.existsSync(wav)) wav.replace(wav, path.join(MODELS_DIR, 'stt', 't-one-russian', '0.wav'))
      const r = eng.decodeFileForTest(fs.existsSync(wav) ? wav : path.join(MODELS_DIR, 'stt', 't-one-russian', '0.wav'))
      report(
        'A: GigaAM init+decode',
        r.text && r.text.length > 5 ? 'PASS' : 'FAIL',
        `load=${eng.metrics.modelLoadMs}мс, text="${(r.text || '').slice(0, 80)}"`,
      )
    }
    eng.shutdown()
  } else {
    report('A: GigaAM init+decode', 'SKIP', 'модели GigaAM нет в AVC_MODELS_DIR')
  }

  // --- B. Integrity-гейт: усечённый encoder не должен валить процесс ---
  if (MODELS_DIR && hasGigaam(MODELS_DIR)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avc-selftest-'))
    try {
      // минимальный каталог: битый gigaam + VAD
      fs.mkdirSync(path.join(tmp, 'stt', 'gigaam-v3-russian'), { recursive: true })
      fs.mkdirSync(path.join(tmp, 'vad', 'silero-vad'), { recursive: true })
      for (const f of ['decoder.onnx', 'joiner.onnx', 'tokens.txt']) {
        fs.copyFileSync(path.join(MODELS_DIR, 'stt', 'gigaam-v3-russian', f), path.join(tmp, 'stt', 'gigaam-v3-russian', f))
      }
      fs.copyFileSync(
        path.join(MODELS_DIR, 'vad', 'silero-vad', 'silero_vad.onnx'),
        path.join(tmp, 'vad', 'silero-vad', 'silero_vad.onnx'),
      )
      // усечённый encoder (50%)
      const encPath = path.join(MODELS_DIR, 'stt', 'gigaam-v3-russian', 'encoder.int8.onnx')
      const encSize = fs.statSync(encPath).size
      const head = Buffer.alloc(Math.floor(encSize * 0.5))
      const fd = fs.openSync(encPath, 'r')
      fs.readSync(fd, head, 0, head.length, 0)
      fs.closeSync(fd)
      fs.writeFileSync(path.join(tmp, 'stt', 'gigaam-v3-russian', 'encoder.int8.onnx'), head)

      // дочерний процесс: раньше здесь был SIGABRT (exit 134) из-за Ort::Exception
      const child = spawnSync(
        process.execPath,
        ['-e', `
          const { GigaamOfflineEngine } = require(${JSON.stringify(path.join(AI, 'stt-engines.cjs'))})
          const eng = new GigaamOfflineEngine({ modelsDir: ${JSON.stringify(tmp)}, modelId: 'gigaam-v3-russian' })
          eng.initialize().then((s) => {
            console.log('STATE=' + s + ' ERR=' + (eng.error || ''))
            process.exit(s === 'failed' ? 0 : 2)
          })
        `],
        { encoding: 'utf8', timeout: 120000 },
      )
      const survived = child.status === 0
      const honestError = /поврежд|усеч/i.test(child.stdout || '')
      report(
        'B: integrity-гейт (битый encoder)',
        survived && honestError ? 'PASS' : 'FAIL',
        survived
          ? `процесс жив (exit 0), честный отказ: ${(child.stdout || '').trim().slice(0, 120)}`
          : `процесс умер! exit=${child.status} signal=${child.signal} stderr=${(child.stderr || '').slice(0, 160)}`,
      )
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ок */ }
    }
  } else {
    report('B: integrity-гейт (битый encoder)', 'SKIP', 'модели GigaAM нет в AVC_MODELS_DIR')
  }

  // --- C. Карантин + авто-fallback (нужен валидный T-One как запаска) ---
  if (MODELS_DIR && hasGigaam(MODELS_DIR) && hasTone(MODELS_DIR)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avc-selftest-fb-'))
    try {
      fs.mkdirSync(path.join(tmp, 'stt', 'gigaam-v3-russian'), { recursive: true })
      fs.mkdirSync(path.join(tmp, 'stt', 't-one-russian'), { recursive: true })
      fs.mkdirSync(path.join(tmp, 'vad', 'silero-vad'), { recursive: true })
      for (const f of ['decoder.onnx', 'joiner.onnx', 'tokens.txt']) {
        fs.copyFileSync(path.join(MODELS_DIR, 'stt', 'gigaam-v3-russian', f), path.join(tmp, 'stt', 'gigaam-v3-russian', f))
      }
      // битый encoder — копия обрезанного файла
      const encPath = path.join(MODELS_DIR, 'stt', 'gigaam-v3-russian', 'encoder.int8.onnx')
      const head = Buffer.alloc(1024 * 1024)
      const fd = fs.openSync(encPath, 'r')
      fs.readSync(fd, head, 0, head.length, 0)
      fs.closeSync(fd)
      fs.writeFileSync(path.join(tmp, 'stt', 'gigaam-v3-russian', 'encoder.int8.onnx'), head)
      for (const f of ['model.onnx', 'tokens.txt', '0.wav']) {
        const src = path.join(MODELS_DIR, 'stt', 't-one-russian', f)
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, 'stt', 't-one-russian', f))
      }
      fs.copyFileSync(
        path.join(MODELS_DIR, 'vad', 'silero-vad', 'silero_vad.onnx'),
        path.join(tmp, 'vad', 'silero-vad', 'silero_vad.onnx'),
      )

      const { VoicePipeline } = require(path.join(AI, 'voice-pipeline.cjs'))
      const pipeline = new VoicePipeline({ modelsDir: tmp, modelId: 'gigaam-v3-russian' })
      await pipeline.initializeServices()
      const st = pipeline.getStatus()
      const quarantined = !!st.quarantine && st.quarantine.modelId === 'gigaam-v3-russian'
      const switched = st.activeModel === 't-one-russian'
      const ready = st.ready.stt === true
      report(
        'C: карантин + fallback на T-One',
        quarantined && switched && ready ? 'PASS' : 'FAIL',
        `quarantine=${quarantined}, активная=${st.activeModel}, ready=${st.ready.stt}`,
      )
      pipeline.shutdown()
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ок */ }
    }
  } else {
    report('C: карантин + fallback на T-One', 'SKIP', 'нужны BOTH модели в AVC_MODELS_DIR')
  }

  // --- D. T-One валидный ---
  if (MODELS_DIR && hasTone(MODELS_DIR)) {
    const { STTService } = require(path.join(AI, 'stt-service.cjs'))
    const svc = new STTService({ modelsDir: MODELS_DIR, profile: 'balanced' })
    const state = await svc.initialize()
    if (state !== 'ready') {
      report('D: T-One init+decode', 'FAIL', `state=${state}, error=${svc.error}`)
    } else {
      const r = svc.decodeFileForTest(path.join(MODELS_DIR, 'stt', 't-one-russian', '0.wav'))
      report('D: T-One init+decode', r.text && r.text.length > 3 ? 'PASS' : 'FAIL', `text="${(r.text || '').slice(0, 80)}"`)
    }
    svc.shutdown()
  } else {
    report('D: T-One init+decode', 'SKIP', 'модели T-One нет в AVC_MODELS_DIR')
  }

  const failed = results.filter((r) => r.status === 'FAIL').length
  const passed = results.filter((r) => r.status === 'PASS').length
  const skipped = results.filter((r) => r.status === 'SKIP').length
  console.log(`\nИТОГ: PASS=${passed} FAIL=${failed} SKIP=${skipped}`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('SELFTEST CRASH:', e)
  process.exit(1)
})
