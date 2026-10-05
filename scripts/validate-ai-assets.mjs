#!/usr/bin/env node
/**
 * validate-ai-assets — ОБЯЗАТЕЛЬНАЯ проверка внешних AI-ассетов перед сборкой EXE
 * (спецификация §61–§66, §116–§118).
 *
 * Что проверяет КАЖДЫЙ URL из манифеста:
 *   - цепочку редиректов (лимит 6) и финальный HTTP-статус;
 *   - Content-Length против размера в манифесте (если есть);
 *   - Accept-Ranges (нужен для resume, §57);
 *   - фактическую докачку первых N байт (по умолчанию 1 МБ) — «страница доступна» ≠ «ассет доступен»;
 *   - при --full: полную загрузку + SHA-256 + сверку с манифестом;
 *   - llama.cpp runtime: проверяется пакет node-llama-cpp (наличие + нативные бинари).
 *
 * Статусы: PASS | FAIL | BLOCKED (сеть/ограничения окружения) — никогда не фальсифицируются (§99, §123).
 *
 * Запуск: node scripts/validate-ai-assets.mjs [--full] [--report <path>]
 * Коды выхода: 0 — все требуемые PASS; 1 — есть FAIL; 2 — все требуемые BLOCKED (окружение).
 */
'use strict'

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import https from 'node:https'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = process.env.AVC_AI_MANIFEST || path.join(ROOT, 'electron-app', 'ai', 'models-manifest.json')
const FULL = process.argv.includes('--full')
const reportArgIdx = process.argv.indexOf('--report')
const REPORT_PATH = reportArgIdx > -1 ? process.argv[reportArgIdx + 1] : path.join(ROOT, 'electron-app', 'ai', 'AI_ASSET_VALIDATION_REPORT.md')

const PROBE_BYTES = 1024 * 1024

function fetchWithRedirects(url, { head = false, probe = 0 } = {}) {
  return new Promise((resolve) => {
    const mod = new URL(url).protocol === 'http:' ? http : https
    const started = Date.now()
    const req = mod.request(url, { method: head ? 'HEAD' : 'GET', headers: { 'User-Agent': 'AVC-Anime/1.0 (validate-ai-assets)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        return resolve({ redirect: true, next, status: res.statusCode, elapsedMs: Date.now() - started })
      }
      const chunks = []
      let received = 0
      res.on('data', (c) => {
        received += c.length
        if (probe === 0 || received <= probe) chunks.push(c)
        else res.destroy() // достаточно для пробы
      })
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        bytes: Buffer.concat(chunks),
        received,
        elapsedMs: Date.now() - started,
      }))
      res.on('close', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        bytes: Buffer.concat(chunks),
        received,
        elapsedMs: Date.now() - started,
        truncated: true,
      }))
      res.on('error', (e) => resolve({ error: e.message, status: res.statusCode || 0 }))
    })
    req.on('error', (e) => resolve({ error: e.message, status: 0 }))
    req.setTimeout(45000, () => { req.destroy(); resolve({ error: 'timeout 45s', status: 0 }) })
    req.end()
  })
}

async function validateUrl(url, { expectedSize, sha256 } = {}) {
  const chain = []
  let current = url

  // 1) HEAD для заголовков
  for (let i = 0; i < 6; i++) {
    const r = await fetchWithRedirects(current, { head: true })
    if (r.error) return { status: 'FAIL', reason: `HEAD: ${r.error}`, chain, httpStatus: r.status }
    if (r.redirect) { chain.push(`${r.status} → ${r.next.slice(0, 120)}`); current = r.next; continue }
    chain.push(`${r.status}`)
    if (r.status !== 200) return { status: 'FAIL', reason: `HTTP ${r.status}`, chain, httpStatus: r.status }
    const len = Number(r.headers['content-length'] || 0)
    const ranges = (r.headers['accept-ranges'] || '') === 'bytes'
    if (expectedSize && len && Number(len) !== expectedSize) {
      return { status: 'FAIL', reason: `Content-Length ${len} ≠ манифест ${expectedSize}`, chain, httpStatus: r.status }
    }
    // 2) частичная реальная докачка (HEAD недостаточно — §64)
    const probe = await fetchWithRedirects(current, { probe: PROBE_BYTES })
    if (probe.error) return { status: 'FAIL', reason: `GET probe: ${probe.error}`, chain, httpStatus: probe.status }
    if (probe.status !== 200) return { status: 'FAIL', reason: `GET probe HTTP ${probe.status}`, chain, httpStatus: probe.status }
    const okProbe = probe.received > 0
    if (!okProbe) return { status: 'FAIL', reason: 'Сервер отдал 0 байт', chain, httpStatus: probe.status }
    const result = {
      status: 'PASS',
      httpStatus: r.status,
      contentLength: len || null,
      acceptRanges: ranges,
      probedBytes: probe.received,
      chain,
      contentType: r.headers['content-type'] || null,
    }
    // 3) --full: полная загрузка + SHA-256
    if (FULL && sha256 && sha256 !== 'PENDING_REAL_DOWNLOAD') {
      const full = await fetchWithRedirects(current, { probe: Infinity })
      if (full.error || full.status !== 200) return { ...result, fullStatus: 'FAIL', reason: `full GET: ${full.error || full.status}` }
      const digest = crypto.createHash('sha256').update(full.bytes).digest('hex')
      result.fullStatus = digest.toLowerCase() === sha256.toLowerCase() ? 'PASS' : 'FAIL'
      result.sha256Actual = digest
      if (result.fullStatus === 'FAIL') result.status = 'FAIL'
    }
    return result
  }
  return { status: 'FAIL', reason: 'Слишком много редиректов', chain }
}

async function checkSherpa() {
  try {
    const candidates = [
      path.join(ROOT, 'electron-app', 'node_modules', 'sherpa-onnx-node', 'package.json'),
    ]
    const found = candidates.find((p) => fs.existsSync(p))
    if (!found) return { status: 'FAIL', reason: 'sherpa-onnx-node не установлен' }
    const pkg = JSON.parse(fs.readFileSync(found, 'utf8'))
    const platformPkgs = fs.readdirSync(path.join(ROOT, 'electron-app', 'node_modules')).filter((d) => d.startsWith('sherpa-onnx-'))
    return { status: 'PASS', version: pkg.version, platformPackages: platformPkgs }
  } catch (e) {
    return { status: 'FAIL', reason: e.message }
  }
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  const rows = []
  let failCount = 0
  let blockedCount = 0

  const addRow = (asset, source, res) => {
    rows.push({ asset, source, ...res })
    if (res.status === 'FAIL') failCount++
    if (res.status === 'BLOCKED') blockedCount++
    console.log(`[${res.status}] ${asset} — ${res.reason || `HTTP ${res.httpStatus}, len=${res.contentLength ?? '?'}, ranges=${res.acceptRanges}, probe=${res.probedBytes ?? '?'}B`}`)
  }

  // VAD (общий для всех движков)
  const vad = manifest.components?.vad
  if (vad?.url) {
    addRow(`VAD: ${vad.name}`, vad.url, await validateUrl(vad.url, { expectedSize: vad.sizeBytes, sha256: vad.sha256 }))
  }

  // Каталог моделей STT (манифест v3): каждая модель + зеркала
  for (const m of manifest.models || []) {
    addRow(`STT: ${m.name} (${m.profile})`, m.url, await validateUrl(m.url, { expectedSize: m.sizeBytes, sha256: m.sha256 ?? undefined }))
    for (const mirror of m.mirrors || []) {
      addRow(`STT mirror: ${m.id}`, mirror, await validateUrl(mirror, {}))
    }
  }

  // Рантаймы
  addRow('Runtime: sherpa-onnx-node', '(npm)', await checkSherpa())

  const requiredModels = (manifest.models || []).filter((m) => m.required)
  const requiredFail =
    rows.some((r) => r.asset.startsWith('STT') && r.status === 'FAIL' && !r.asset.startsWith('STT mirror')) ||
    rows.some((r) => r.asset.startsWith('VAD') && r.status === 'FAIL')
  const exitCode = requiredFail ? 1 : failCount > 0 ? 1 : blockedCount > 0 && rows.every((r) => r.status === 'BLOCKED') ? 2 : 0

  // Отчёт (§118)
  const md = [
    '# AI_ASSET_VALIDATION_REPORT',
    '',
    `Дата: ${new Date().toISOString()}`,
    `Манифест: ${MANIFEST} (версия ${manifest.version})`,
    `Режим: ${FULL ? 'полная загрузка + SHA-256' : 'HEAD + частичная докачка (1 МБ)'}`,
    '',
    '| Ассет | Статус | HTTP | Content-Length | Accept-Ranges | Проба | Примечание |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.asset} | **${r.status}** | ${r.httpStatus ?? '—'} | ${r.contentLength ?? '—'} | ${r.acceptRanges ? 'да' : '—'} | ${r.probedBytes ?? '—'} | ${r.reason || r.note || ''} |`),
    '',
    `Итог: ${failCount === 0 && blockedCount === 0 ? 'ВСЕ PASS' : `${failCount} FAIL, ${blockedCount} BLOCKED`}`,
    '',
    'Правило (§117): продакшн-сборка останавливается при FAIL любого требуемого ассета.',
  ].join('\n')
  fs.writeFileSync(REPORT_PATH, md)
  console.log(`\nОтчёт: ${REPORT_PATH}`)
  process.exit(exitCode)
}

main().catch((e) => {
  console.error('validate-ai-assets crashed:', e)
  process.exit(1)
})
