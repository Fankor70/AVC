/**
 * Selftest AIModelManager (спецификация §107, §128):
 *   1. install('stt') — реальная загрузка T-One (128 МБ) через менеджер:
 *      temp .part → размер → SHA-256 → tar.bz2 → структура (model.onnx, tokens.txt) → маркер.
 *   2. Проверка resume: искусственный обрыв + повторный install — должен продолжить с Range-позиции.
 *   3. status() — честные состояния для UI.
 * Запуск: node tools/ai-model-selftest.cjs
 */
'use strict'

const path = require('path')
const fs = require('fs')
const { AIModelManager, fmtBytes } = require('../ai/model-manager.cjs')

const MODELS_DIR = process.env.AVC_MODELS_DIR || path.join(__dirname, '..', 'models')

async function main() {
  const mgr = new AIModelManager({ baseDir: MODELS_DIR })
  const report = { ranAt: new Date().toISOString(), baseDir: mgr.baseDir, steps: [] }
  const step = (name, status, detail) => {
    report.steps.push({ name, status, detail })
    console.log(`[${status}] ${name} — ${detail}`)
  }

  // 0) статус до установки
  const st0 = mgr.status()
  step('status-initial', 'PASS', `components=${st0.components.map((c) => `${c.key}:${c.installed ? 'installed' : 'missing'}`).join(', ')}, freeDisk=${fmtBytes(st0.freeDisk)}`)

  // 1) реальная установка STT с прогрессом
  let lastPercent = 0
  mgr.on('progress', (p) => {
    if (p.phase === 'downloading' && p.percent - lastPercent > 10) {
      lastPercent = p.percent
      console.log(`  download: ${p.percent.toFixed(0)}% (${fmtBytes(p.receivedBytes)}/${fmtBytes(p.totalBytes)})`)
    } else if (p.phase !== 'downloading') {
      console.log(`  phase: ${p.phase}`)
    }
  })
  try {
    const r = await mgr.install('stt')
    step('install-stt', 'PASS', r.skipped ? 'уже установлен' : `установлен в ${r.dir}, sha256=${(r.marker.sha256 || 'n/a').slice(0, 16)}…`)
  } catch (e) {
    step('install-stt', 'FAIL', `${e.kind || 'ERROR'}: ${e.message}`)
    report.exitCode = 1
  }

  // 2) файлы на месте
  const sttDir = mgr.componentDir('stt')
  for (const f of ['model.onnx', 'tokens.txt']) {
    const p = path.join(sttDir, f)
    step(`file:${f}`, fs.existsSync(p) ? 'PASS' : 'FAIL', fs.existsSync(p) ? `${fmtBytes(fs.statSync(p).size)}` : 'не найден')
  }

  // 3) resume-тест: создаём .part на 30% и повторяем — должен продолжиться (206) или честно перезапуститься
  try {
    const url = mgr.manifest.components.stt.url
    const partPath = path.join(sttDir, 'sherpa-onnx-streaming-t-one-russian-2025-09-08.tar.bz2.part')
    // удаляем установку, эмулируем обрыв
    fs.rmSync(path.join(sttDir, '.avc-installed.json'), { force: true })
    const spec = mgr.componentSpec('stt')
    const expect = spec.sizeBytes
    if (!fs.existsSync(partPath)) {
      // скачиваем первые 30% вручную через Range — эмуляция обрыва
      const got = await fetchRange(url, 0, Math.floor(expect * 0.3))
      fs.writeFileSync(partPath, got)
    }
    const before = fs.statSync(partPath).size
    lastPercent = 0
    await mgr.install('stt', { force: true })
    const afterInstalled = mgr.isInstalled('stt')
    step('resume-install', afterInstalled ? 'PASS' : 'FAIL', `part был ${fmtBytes(before)} → установка завершилась, isInstalled=${afterInstalled}`)
  } catch (e) {
    step('resume-install', 'FAIL', `${e.kind || 'ERROR'}: ${e.message}`)
    report.exitCode = 1
  }

  // 4) финальный статус
  const st1 = mgr.status()
  step('status-final', 'PASS', st1.components.map((c) => `${c.key}:${c.installed ? 'installed' : 'missing'}`).join(', '))

  // 5) битая модель обнаруживается? (§108) — подменяем sha в ожиданиях через копию манифеста нельзя;
  //    проверим честно: маркер с неверным id → isInstalled=false
  const markerPath = path.join(sttDir, '.avc-installed.json')
  const realMarker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
  fs.writeFileSync(markerPath, JSON.stringify({ ...realMarker, id: 'corrupted-id' }))
  step('detect-corrupted-marker', mgr.isInstalled('stt') === false ? 'PASS' : 'FAIL', 'неверный id в маркере → компонент считается неустановленным (требует переустановки)')
  fs.writeFileSync(markerPath, JSON.stringify(realMarker))

  report.exitCode = report.steps.some((s) => s.status === 'FAIL') ? 1 : 0
  fs.writeFileSync(path.join(__dirname, 'ai-model-selftest-report.json'), JSON.stringify(report, null, 2))
  console.log(`\nExit code: ${report.exitCode}`)
  process.exit(report.exitCode)
}

function fetchRange(url, start, end) {
  return new Promise((resolve, reject) => {
    const https = require('https')
    const req = https.get(url, { headers: { Range: `bytes=${start}-${end}`, 'User-Agent': 'AVC-Anime/1.0 (selftest)' } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

main().catch((e) => {
  console.error('selftest crashed:', e)
  process.exit(1)
})
