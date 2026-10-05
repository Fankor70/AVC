#!/usr/bin/env node
/**
 * check-packaged-layout — страж упаковки EXE (урок v1.0.20).
 *
 * Баг v1.0.20: main.cjs пакуется в app.asar, а папка ai/ живёт рядом
 * (resources/ai — extraResources). «Голый» require('./ai/...') из asar-файла
 * работал в dev, но крашил EXE при старте («Cannot find module»).
 *
 * Проверки:
 *   1. Раскладка собранного EXE (dist/win-unpacked): ключевые файлы resources/ai/*
 *      существуют. В CI (env CI=1) отсутствие dist/win-unpacked = FAIL;
 *      локально (нет dist) — SKIP с предупреждением.
 *   2. Статический скан asar-пакованных файлов (main.cjs, preload.cjs,
 *      splash-preload.cjs, auth/*.cjs): НЕТ «голых» require('./ai/...') в РЕАЛЬНОМ
 *      коде. Парсим ЧЕСТНЫМ токенизатором acorn — самодельные stripper'ы ломаются
 *      на regex-литералах с кавычками (например redact(): /[^;\s"']+/).
 *
 * Запуск: node scripts/check-packaged-layout.mjs   (из корня репозитория)
 * Тест-оверрайд: AVC_APP_DIR=<dir> — проверить другой каталог приложения.
 */
'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = process.env.AVC_APP_DIR
  ? path.resolve(process.env.AVC_APP_DIR)
  : path.join(ROOT, 'electron-app')
const UNPACKED = path.join(APP, 'dist', 'win-unpacked')

let failed = false
const fail = (msg) => { console.error(`FAIL: ${msg}`); failed = true }

// --- 1) Раскладка собранного EXE -------------------------------------------
const REQUIRED_RESOURCES = [
  'resources/ai/model-integrity.cjs',
  'resources/ai/ai-worker.cjs',
  'resources/ai/models-manifest.json',
  'resources/ai/voice-pipeline.cjs',
]

if (fs.existsSync(UNPACKED)) {
  for (const rel of REQUIRED_RESOURCES) {
    if (!fs.existsSync(path.join(UNPACKED, rel))) fail(`в собранном EXE отсутствует ${rel}`)
  }
  if (!failed) console.log('OK: раскладка dist/win-unpacked/resources/ai полная')
} else if (process.env.CI) {
  fail('dist/win-unpacked не найден — в CI сборка обязана существовать')
} else {
  console.log('SKIP: dist/win-unpacked отсутствует (локальный запуск без сборки) — раскладка не проверялась')
}

// --- 2) «Голые» require('./ai/...') в asar-пакованных файлах (acorn) --------
const asarFiles = ['main.cjs', 'preload.cjs', 'splash-preload.cjs']
  .concat(fs.existsSync(path.join(APP, 'auth'))
    ? fs.readdirSync(path.join(APP, 'auth')).filter((f) => f.endsWith('.cjs')).map((f) => `auth/${f}`)
    : [])

const requireModuleName = createRequire(import.meta.url)('acorn')

for (const rel of asarFiles) {
  const abs = path.join(APP, rel)
  if (!fs.existsSync(abs)) continue
  const code = fs.readFileSync(abs, 'utf8')

  let tokens
  try {
    tokens = [...requireModuleName.tokenizer(code, { ecmaVersion: 'latest', sourceFile: rel })]
  } catch (e) {
    fail(`${rel}: acorn не смог токенизировать файл (${e.message}) — файл должен быть валидным JS`)
    continue
  }

  const hits = []
  for (let i = 0; i < tokens.length - 2; i++) {
    const t = tokens[i]
    // паттерн: require ( './ai/...' ) — только строковый литерал, только реальный код
    if (t.type.label === 'name' && t.value === 'require'
      && tokens[i + 1].type.label === '('
      && tokens[i + 2].type.label === 'string') {
      const arg = tokens[i + 2].value
      if (typeof arg === 'string' && arg.startsWith('./ai/')) {
        hits.push(arg)
      }
    }
  }
  if (hits.length) {
    fail(`${rel}: «голый» require('./ai/...') в коде (${hits.length}: ${hits.join(', ')}) — используй process.resourcesPath (см. startAiWorker)`)
  }
}
if (!failed) console.log('OK: «голых» require(./ai/...) в asar-файлах нет (скан acorn, комментарии/regex не мешают)')

process.exit(failed ? 1 : 0)
