/**
 * afterPack-хук electron-builder: прописывает иконку и VERSIONINFO в
 * win-unpacked/<Product>.exe БЕЗ wine (rcedit требует wine на Linux).
 *
 * Использует pure-JS resedit (PE-редактор) + sharp (PNG→256×256).
 * Запускается ПОСЛЕ копирования app в win-unpacked и ДО NSIS/portable-паковки,
 * поэтому портативный EXE получает уже правленный исполняемый файл.
 *
 * Подключение: "afterPack": "build/afterpack.cjs" в electron-builder.json
 */
'use strict'

const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

/** Собирает ICO-контейнер (одна PNG-запись 256×256, валидно для Vista+) */
async function buildIco(pngPath) {
  const png256 = await sharp(pngPath).resize(256, 256).png().toBuffer()
  const header = Buffer.alloc(6 + 16)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(1, 4) // count: 1
  const d = header.subarray(6)
  d.writeUInt8(0, 0) // width 256 → 0
  d.writeUInt8(0, 1) // height 256 → 0
  d.writeUInt8(0, 2) // палитра
  d.writeUInt8(0, 3) // reserved
  d.writeUInt16LE(1, 4) // planes
  d.writeUInt16LE(32, 6) // bpp
  d.writeUInt32LE(png256.length, 8) // размер данных
  d.writeUInt32LE(22, 12) // смещение данных (6 + 16)
  return Buffer.concat([header, png256])
}

exports.default = async function (context) {
  if (context.electronPlatformName !== 'win32') return
  const exeName = context.packager.appInfo.productFilename + '.exe'
  const exePath = path.join(context.appOutDir, exeName)
  if (!fs.existsSync(exePath)) {
    console.warn(`[afterpack] ${exeName} не найден в ${context.appOutDir} — пропуск`)
    return
  }

  // resedit — ESM-пакет: динамический import из CJS (v3: IconFile живёт в Data)
  const { Data, NtExecutable, NtExecutableResource, Resource } = await import('resedit')

  const ico = await buildIco(path.join(__dirname, 'icon.png'))
  const exe = NtExecutable.from(fs.readFileSync(exePath))
  const res = NtExecutableResource.from(exe)

  // Замена стандартной группы иконки Electron (id '1', lang 1033 en-US)
  const iconFile = Data.IconFile.from(ico)
  Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    '1',
    1033,
    iconFile.icons.map((i) => i.data),
  )

  // VERSIONINFO — как это делал бы rcedit
  const vi = new Resource.VersionInfo()
  vi.setFileVersion({ major: 1, minor: 0, patch: 0, build: 0 })
  vi.setProductVersion({ major: 1, minor: 0, patch: 0, build: 0 })
  vi.setStringValues(
    { lang: 0x0409, codepage: 1200 },
    {
      ProductName: 'AVC-Anime',
      FileDescription: 'AVC-Anime — Anime Voice Control (YummyAnime voice-controlled client)',
      CompanyName: 'AVC-Anime',
      LegalCopyright: 'MIT',
      ProductVersion: '1.0.0',
      FileVersion: '1.0.0',
      OriginalFilename: 'AVC-Anime.exe',
      InternalName: 'AVC-Anime',
    },
  )
  vi.outputToResourceEntries(res.entries)

  res.outputResource(exe)
  fs.writeFileSync(exePath, Buffer.from(exe.generate()))
  console.log(`[afterpack] иконка + VERSIONINFO прописаны в ${exePath}`)
}
