/**
 * ai-main-selftest — проверка ИНТЕГРАЦИИ AI-слоя с main-процессом без UI:
 * тот же путь инициализации, что в main.cjs (VoicePipeline + setup), но без Electron.
 * Запуск: node tools/ai-main-selftest.cjs
 */
'use strict'
const path = require('path')
const fs = require('fs')
const { VoicePipeline } = require('../ai/voice-pipeline.cjs')

const MODELS_DIR = process.env.AVC_MODELS_DIR || path.join(__dirname, '..', 'models')

async function main() {
  const pipeline = new VoicePipeline({ modelsDir: MODELS_DIR })
  const status = pipeline.getStatus()
  console.log('STATUS:', JSON.stringify({
    enabled: status.enabled,
    models: status.models.map((m) => `${m.key}:${m.installed ? 'installed' : 'missing'}`).join(','),
    ready: status.ready,
  }))
  const hw = await pipeline.getHardware()
  console.log('HARDWARE:', hw.cpu, '| RAM', hw.ramHuman, '| platform', hw.platform)
  const svc = await pipeline.initializeServices()
  console.log('SERVICES:', JSON.stringify(svc))
  pipeline.shutdown()
  const ok = svc.stt === 'ready' && svc.tts === 'ready' && svc.llm === 'ready'
  console.log('RESULT:', ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
}
main().catch((e) => { console.error('crash:', e); process.exit(1) })
