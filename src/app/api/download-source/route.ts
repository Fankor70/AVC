import { NextResponse } from 'next/server'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFile, mkdtemp, rm, stat, readFile } from 'fs/promises'
import path from 'path'
import os from 'os'

const execFileAsync = promisify(execFile)

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/download-source
 *
 * Собирает и отдаёт zip-архив ИСХОДНИКОВ проекта (без node_modules, .next,
 * .git, логов, базы и секретов). Пользователь скачивает архив одной кнопкой
 * из шапки приложения и загружает на GitHub вручную.
 *
 * Безопасность: .env*, *.db, *.log, ключи — ИСКЛЮЧЕНЫ из архива.
 */

const PROJECT_ROOT = process.cwd()

const EXCLUDES = [
  'node_modules/*',
  '.next/*',
  '.git/*',
  'skills/*',
  'upload/*',
  'tool-results/*',
  'download/*',
  '.zscripts/*',
  '.z-ai-config*',
  '.claude/*',
  '.env*',
  '*.log',
  'db/*.db',
  'db/*.db-*',
  '*.zip',
  'prompt*',
  'test/*',
]

async function dirSize(dir: string): Promise<string> {
  try {
    const s = await stat(dir)
    return `${(s.size / 1024).toFixed(1)} KB`
  } catch {
    return 'n/a'
  }
}

export async function GET() {
  const tmpDir: string | null = await mkdtemp(path.join(os.tmpdir(), 'avc-export-'))
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
    const zipPath = path.join(tmpDir, 'avc-anime-source.zip')
    const manifestPath = path.join(tmpDir, 'EXPORT_MANIFEST.txt')

    // 1. Собираем zip исходников (без тяжёлых/секретных файлов; .gitignore включён)
    await execFileAsync('zip', ['-rq', zipPath, '.', ...EXCLUDES.map((e) => `-x${e}`)], {
      cwd: PROJECT_ROOT,
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    })

    // 2. Манифест экспорта — что внутри и что исключено
    const manifest = [
      'AVC-Anime — экспорт исходников',
      `Дата: ${new Date().toISOString()}`,
      '',
      'ВКЛЮЧЕНО:',
      '  - src/            (всё веб-приложение AVC-Anime)',
      '  - prisma/         (схема БД)',
      '  - scripts/, mini-services/, examples/',
      '  - public/, package.json, конфиги, README.md, worklog.md, .gitignore',
      '',
      'ИСКЛЮЧЕНО (безопасность/мусор):',
      '  - node_modules, .next, .git',
      '  - .env* (секреты), *.db (данные), *.log',
      '  - skills/, upload/, tool-results/, download/, .zscripts/ (платформенные)',
      '',
      `Размер src/: ${await dirSize(path.join(PROJECT_ROOT, 'src'))}`,
      `Размер public/: ${await dirSize(path.join(PROJECT_ROOT, 'public'))}`,
      '',
      'КАК ЗАГРУЗИТЬ НА GITHUB:',
      '  1. Распакуйте архив.',
      '  2. Через web-интерфейс GitHub: Add file → Upload files → перетащите ВСЁ содержимое.',
      '     Либо через git: git init && git add . && git commit -m "AVC-Anime sources" && git push.',
      '',
      'ВНИМАНИЕ: electron-app/ (обёртка EXE) в этой среде отсутствует и в архив не попал.',
    ].join('\n')
    await writeFile(manifestPath, manifest, 'utf8')

    // 3. Добавляем манифест в корень архива (-j junk paths)
    await execFileAsync('zip', ['-qj', zipPath, manifestPath], { timeout: 30_000 })

    const info = await stat(zipPath)
    const buf = await readFile(zipPath)

    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(info.size),
        'Content-Disposition': `attachment; filename="avc-anime-source-${stamp}.zip"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error('[download-source] export failed:', err)
    return NextResponse.json(
      { error: 'Не удалось собрать архив исходников', detail: String(err) },
      { status: 500 },
    )
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}
