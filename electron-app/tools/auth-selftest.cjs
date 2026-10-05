/**
 * auth-selftest.cjs — CLI-обёртка диагностического прогона (секции 9/20/24).
 *
 * Запуск (Windows, из папки electron-app):
 *   npm run auth:test
 * (эквивалент: npx electron . --auth-selftest)
 *
 * Печатает безопасный JSON-отчёт (без cookie/токенов) и завершается:
 *   exit 0 — сайт доступен, тесты выполнены;
 *   exit 2 — сайт недоступен (BLOCKED — REAL SITE UNAVAILABLE).
 */
const { spawn } = require('child_process')
const path = require('path')

// require('electron') из Node возвращает ПУТЬ к бинарнику electron
const electronBin = require('electron')

const child = spawn(electronBin, [path.join(__dirname, '..'), '--auth-selftest'], {
  stdio: 'inherit',
  env: process.env,
})
child.on('exit', (code) => process.exit(code ?? 1))
