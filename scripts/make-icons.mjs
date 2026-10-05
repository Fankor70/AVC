#!/usr/bin/env node
/**
 * make-icons.mjs — генератор PNG-иконок PWA из inline-SVG (через sharp).
 *
 * Дизайн: тёмный скруглённый квадрат (#09090b), янтарный (amber #f59e0b)
 * треугольник-play по центру-влево, розовая (rose #fb7185) дуга-микрофон справа.
 *
 * Использование:
 *   bun scripts/make-icons.mjs            → icon-192.png + icon-512.png + icon-maskable-512.png
 *   bun scripts/make-icons.mjs 256 384    → icon-256.png + icon-384.png (+ maskable 512)
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'icons')
mkdirSync(outDir, { recursive: true })

const SIZE = 512

/**
 * SVG-артиwork 512×512.
 * @param {number} padPct внутренний отступ в % (для maskable — 10%)
 * @param {boolean} rounded скруглять углы фона (для maskable фон должен быть full-bleed)
 */
function artworkSvg(padPct = 0, rounded = true) {
  const pad = (SIZE * padPct) / 100
  const scale = (SIZE - 2 * pad) / SIZE
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" ${rounded ? 'rx="112"' : ''} fill="#09090b"/>
  <g transform="translate(${pad} ${pad}) scale(${scale})">
    <path d="M150 160 L295 256 L150 352 Z" fill="#f59e0b" stroke="#f59e0b" stroke-width="40" stroke-linejoin="round"/>
    <path d="M335 200 a72 72 0 0 1 0 112" fill="none" stroke="#fb7185" stroke-width="22" stroke-linecap="round"/>
    <path d="M368 170 a118 118 0 0 1 0 172" fill="none" stroke="#fb7185" stroke-width="26" stroke-linecap="round"/>
  </g>
</svg>`
}

async function render(svg, file, size) {
  await sharp(Buffer.from(svg))
    .resize(size, size)
    .png()
    .toFile(join(outDir, file))
  console.log(`✓ public/icons/${file}`)
}

async function main() {
  // Размеры из argv; без аргументов — стандартный набор PWA
  const sizes = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  const list = sizes.length > 0 ? sizes : [192, 512]

  for (const size of list) {
    await render(artworkSvg(0, true), `icon-${size}.png`, size)
  }
  // Maskable: safe zone — artwork с отступом 10%, фон full-bleed (без rx)
  await render(artworkSvg(10, false), 'icon-maskable-512.png', 512)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
