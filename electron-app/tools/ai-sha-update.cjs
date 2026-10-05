/**
 * ai-sha-update — однократная процедура (спецификация §55):
 * реально загружает компоненты и вносит ИХ НАСТОЯЩИЕ SHA-256 в models-manifest.json.
 * Никогда не выдумывает значения.
 *
 * Запуск: node tools/ai-sha-update.cjs [stt|tts|llm ...]   (без аргументов — все)
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { AIModelManager } = require('../ai/model-manager.cjs')

const MANIFEST_PATH = process.env.AVC_AI_MANIFEST || path.join(__dirname, '..', 'ai', 'models-manifest.json')
const MODELS_DIR = process.env.AVC_MODELS_DIR || path.join(__dirname, '..', 'models')

async function main() {
  const only = process.argv.slice(2)
  const want = (k) => only.length === 0 || only.includes(k)
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  const mgr = new AIModelManager({ baseDir: MODELS_DIR, manifest })

  const progressLine = (p) => {
    if (p.phase === 'downloading') {
      process.stdout.write(`\r  ${p.key} ${p.percent.toFixed(0)}% (${(p.receivedBytes / 1e6).toFixed(0)}/${(p.totalBytes / 1e6).toFixed(0)} MB)   `)
    } else process.stdout.write(`\n  ${p.key}: ${p.phase}\n`)
  }
  mgr.on('progress', progressLine)

  const markerOf = (dir) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, '.avc-installed.json'), 'utf8')) } catch { return null }
  }

  if (want('vad')) {
    console.log('== VAD Silero ==')
    const pending = manifest.components.vad.sha256 === 'PENDING_REAL_DOWNLOAD'
    let r
    try { r = await mgr.install('vad', { force: pending }) } catch (e) { r = null; console.error('  install error:', e.message) }
    const m = r && r.marker ? r.marker : markerOf(mgr.componentDir('vad'))
    if (m && m.sha256) { manifest.components.vad.sha256 = m.sha256; console.log(`\n  VAD sha256 = ${m.sha256}`) }
    else console.log('\n  VAD: sha недоступен')
  }
  if (want('stt')) {
    console.log('== STT T-One ==')
    const pending = manifest.components.stt.sha256 === 'PENDING_REAL_DOWNLOAD'
    let r
    try { r = await mgr.install('stt', { force: pending }) } catch (e) { r = null; console.error('  install error:', e.message) }
    const m = r && r.marker ? r.marker : markerOf(mgr.componentDir('stt'))
    if (m && m.sha256) { manifest.components.stt.sha256 = m.sha256; console.log(`\n  STT sha256 = ${m.sha256}`) }
    else console.log('\n  STT: sha недоступен (установка не удалась или маркер пуст)')
  }
  if (want('tts')) {
    for (const v of manifest.components.tts.voices) {
      console.log(`== TTS ${v.id} ==`)
      const pending = v.sha256 === 'PENDING_REAL_DOWNLOAD'
      let r
      try { r = await mgr.install('tts', { voiceId: v.id, force: pending }) } catch (e) { r = null; console.error('  install error:', e.message) }
      const m = r && r.marker ? r.marker : markerOf(mgr.componentDir('tts', v.id))
      if (m && m.sha256) { v.sha256 = m.sha256; console.log(`\n  TTS ${v.id} sha256 = ${m.sha256}`) }
      else console.log(`\n  TTS ${v.id}: sha недоступен`)
    }
  }
  if (want('llm')) {
    console.log('== LLM Qwen3-0.6B Q4_K_M ==')
    const pending = manifest.components.llm.sha256 === 'PENDING_REAL_DOWNLOAD'
    let r
    try { r = await mgr.install('llm', { force: pending }) } catch (e) { r = null; console.error('  install error:', e.message) }
    const m = r && r.marker ? r.marker : markerOf(mgr.componentDir('llm'))
    if (m && m.sha256) { manifest.components.llm.sha256 = m.sha256; console.log(`\n  LLM sha256 = ${m.sha256}`) }
    else console.log('\n  LLM: sha недоступен')
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`\nМанифест обновлён реальными SHA-256: ${MANIFEST_PATH}`)
}

main().catch((e) => {
  console.error('sha-update failed:', e.kind || '', e.message)
  process.exit(1)
})
