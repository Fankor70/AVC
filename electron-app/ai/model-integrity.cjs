/**
 * model-integrity — пред-полётная проверка целостности AI-моделей БЕЗ нативного рантайма.
 *
 * УРОК ИНЦИДЕНТА v1.0.19 (GitHub issue #2, пользовательский EXE):
 *   повреждённый/недокачанный ONNX при загрузке в sherpa-onnx вызывает НЕОБРАБОТАННОЕ
 *   C++ исключение (Ort::Exception «Protobuf parsing failed» → std::terminate) —
 *   процесс умирает мгновенно: Windows 0xC0000409 (3221226505), Linux SIGABRT (134).
 *   JS try/catch это НЕ ловит, авто-ретраи воркера бессмысленны: файл не чинится.
 *
 *   Воспроизведено в песочнице: усечённый encoder.int8.onnx → «terminate called after
 *   throwing an instance of 'Ort::Exception'» → exit 134. Точная механика краша EXE
 *   пользователя подтверждена экспериментально.
 *
 * ЕДИНСТВЕННАЯ защита — не давать нативному рантайму битый файл. Проверка чистым Node:
 *   1. Файлы существуют и не пусты (проверка «установлена» = только существование —
 *      пропустила остатки оборванных установок старых версий).
 *   2. Санитарные минимумы размера (усечённый файл ловится почти всегда).
 *   3. ONNX-заголовок: не HTML-страница зеркала и не нулевой мусор.
 *   4. Маркер установки (.avc-installed.json): если в нём записаны размеры файлов —
 *      сверяем фактические размеры (расхождение вниз = повреждение).
 *
 * Модуль НЕ зависит от electron и от sherpa-onnx — безопасно вызывать откуда угодно.
 */

'use strict'

const fs = require('fs')
const path = require('path')

/** Санитарные минимумы размеров (байты) по файлам моделей каталога.
 *  Намеренно занижены относительно реальных (реальный encoder v3 = 224.5 МБ):
 *  ловим грубые повреждения/обрывы, не чиним валидные re-export'ы. */
const MIN_FILE_BYTES = {
  'tokens.txt': 32,
  'model.onnx': 50 * 1024 * 1024, // T-One streaming fp32 (~144 МБ реальный)
  'model.int8.onnx': 50 * 1024 * 1024, // GigaAM v2 CTC int8
  'encoder.int8.onnx': 50 * 1024 * 1024, // GigaAM v3 RNNT int8 (~224 МБ реальный)
  'encoder.onnx': 50 * 1024 * 1024,
  'decoder.onnx': 512 * 1024, // ~3.3 МБ реальный
  'decoder.int8.onnx': 512 * 1024,
  'joiner.onnx': 128 * 1024, // ~1.4 МБ реальный
  'joiner.int8.onnx': 128 * 1024,
  'silero_vad.onnx': 400 * 1024, // ~0.64 МБ реальный
}

/** Ожидаемые файлы моделей каталога (дублирует expectedFiles манифеста — проверка
 *  должна работать даже если манифест недоступен/повреждён) */
const CATALOG_FILES = {
  't-one-russian': ['model.onnx', 'tokens.txt'],
  'gigaam-v3-russian': ['encoder.int8.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'],
  'gigaam-v2-russian': ['model.int8.onnx', 'tokens.txt'],
}

function markerPath(dir) {
  return path.join(dir, '.avc-installed.json')
}

function readMarker(dir) {
  try {
    return JSON.parse(fs.readFileSync(markerPath(dir), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Быстрая проверка «файл выглядит как валидный ONNX»: не HTML-страница зеркала,
 * не JSON-ошибка CDN, не нулевой мусор. ONNX — protobuf: первый байт обычно 0x08.
 */
function onnxHeaderLooksSane(file) {
  let fd = null
  try {
    const size = fs.statSync(file).size
    if (size < 1024) return false
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(16)
    fs.readSync(fd, buf, 0, 16, 0)
    const head = buf.toString('latin1')
    if (head.startsWith('<')) return false // HTML/XML («<!DOCTYPE», «<?xml», error page)
    if (head.startsWith('{') || head.startsWith('[')) return false // JSON-ошибка
    // нулевой или заполненный одним байтом мусор
    if (buf[0] === 0 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0) return false
    if (buf.every((b) => b === buf[0])) return false
    return true
  } catch {
    return false
  } finally {
    try { if (fd !== null) fs.closeSync(fd) } catch { /* ок */ }
  }
}

function tokensLookSane(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8')
    if (!txt || txt.length < 4) return false
    if (!txt.includes('\n') && !txt.includes(' ')) return false // токен-файл всегда многострочный
    return true
  } catch {
    return false
  }
}

/**
 * Структурная проверка ONNX (protobuf-обход верхнего уровня, чистый Node, без чтения тела).
 *
 * УРОК: min-размер ловит только ГРУБОЕ усечение (файл < 50 МБ). Половинный encoder
 * (112 МБ из 224) проходит порог и убивает процесс SIGABRT — воспроизведено в selftest.
 * Обход полей ModelProto ловит ЛЮБОЕ усечение: последний длинный graph-филд «уезжает»
 * за конец файла → обход не сходится в EOF → файл повреждён.
 *
 * Дёшево: читаются только теги/длины (~десятки маленьких чтений), тело полей пропускается арифметически.
 */
function onnxProtobufWalkOk(file) {
  let fd = null
  try {
    const size = fs.statSync(file).size
    if (size < 64) return false
    fd = fs.openSync(file, 'r')
    const readBuf = (pos, n) => {
      if (pos + n > size) return null
      const b = Buffer.alloc(n)
      const r = fs.readSync(fd, b, 0, n, pos)
      return r === n ? b : null
    }
    const readVarint = (pos) => {
      let result = 0
      let shift = 0
      let p = pos
      for (let i = 0; i < 10; i++) {
        if (p >= size) return null
        const b = readBuf(p, 1)
        if (!b) return null
        const byte = b[0]
        result += (byte & 0x7f) * 2 ** shift
        shift += 7
        p += 1
        if (!(byte & 0x80)) return { value: result, pos: p }
      }
      return null // varint длиннее 10 байт — не protobuf
    }
    let pos = 0
    while (pos < size) {
      const tag = readVarint(pos)
      if (!tag) return false
      pos = tag.pos
      const wireType = tag.value & 7
      if (wireType === 0) {
        const v = readVarint(pos)
        if (!v) return false
        pos = v.pos
      } else if (wireType === 1) {
        pos += 8
      } else if (wireType === 5) {
        pos += 4
      } else if (wireType === 2) {
        const l = readVarint(pos)
        if (!l) return false
        pos = l.pos + l.value
      } else {
        return false // wire types 3/4 (группы) и 6/7 не используются в ONNX
      }
      if (pos > size) return false // длина поля уезжает за конец файла — усечён
    }
    return pos === size
  } catch {
    return false
  } finally {
    try { if (fd !== null) fs.closeSync(fd) } catch { /* ок */ }
  }
}

/**
 * Проверить целостность установленной модели каталога.
 * @returns {{ok:boolean, modelId:string, dir:string, problems:string[], markerFound:boolean}}
 */
function checkModelIntegrity(modelsDir, modelId) {
  const dir = path.join(modelsDir, 'stt', modelId)
  const problems = []
  const files = CATALOG_FILES[modelId]
  if (!files) return { ok: false, modelId, dir, problems: [`Неизвестная модель каталога: ${modelId}`], markerFound: false }
  if (!fs.existsSync(dir)) return { ok: false, modelId, dir, problems: ['Каталог модели отсутствует'], markerFound: false }

  const marker = readMarker(dir)
  const markerFiles = (marker && marker.files && typeof marker.files === 'object') ? marker.files : null

  for (const f of files) {
    const p = path.join(dir, f)
    let st = null
    try { st = fs.statSync(p) } catch { st = null }
    if (!st || !st.isFile()) {
      problems.push(`Файл отсутствует: ${f}`)
      continue
    }
    if (st.size === 0) {
      problems.push(`Файл пустой: ${f}`)
      continue
    }
    const min = MIN_FILE_BYTES[f] || 1024
    if (st.size < min) {
      problems.push(`Файл усечён: ${f} (${st.size} байт < ожидаемых ${min})`)
      continue
    }
    if (f.endsWith('.onnx') && !onnxHeaderLooksSane(p)) {
      problems.push(`Файл не похож на валидный ONNX (битый заголовок): ${f}`)
      continue
    }
    if (f.endsWith('.onnx') && !onnxProtobufWalkOk(p)) {
      problems.push(`Структура ONNX нарушена (файл усечён/повреждён): ${f}`)
      continue
    }
    if (f === 'tokens.txt' && !tokensLookSane(p)) {
      problems.push(`Файл токенов повреждён: ${f}`)
      continue
    }
    // сверка с маркером установки (записан при успешной установке)
    if (markerFiles && typeof markerFiles[f] === 'number' && st.size < markerFiles[f]) {
      problems.push(`Размер меньше зафиксированного при установке: ${f} (${st.size} < ${markerFiles[f]})`)
    }
  }

  return {
    ok: problems.length === 0,
    modelId,
    dir,
    problems,
    markerFound: !!marker,
  }
}

/** Целостность Silero VAD (общий для всех движков компонент) */
function checkVadIntegrity(modelsDir) {
  const p = path.join(modelsDir, 'vad', 'silero-vad', 'silero_vad.onnx')
  const problems = []
  let st = null
  try { st = fs.statSync(p) } catch { st = null }
  if (!st || !st.isFile()) problems.push('Silero VAD не установлен: vad/silero-vad/silero_vad.onnx')
  else if (st.size < (MIN_FILE_BYTES['silero_vad.onnx'] || 0)) problems.push(`Silero VAD усечён (${st.size} байт)`)
  else if (!onnxHeaderLooksSane(p)) problems.push('Silero VAD не похож на валидный ONNX')
  else if (!onnxProtobufWalkOk(p)) problems.push('Структура ONNX Silero VAD нарушена')
  return { ok: problems.length === 0, problems, file: p }
}

/**
 * Карантин: переименовать повреждённый каталог модели, чтобы он больше не
 * «выглядел установленным» и не убивал нативный рантайм. Обратимо: данные
 * не удаляются (пользователь может посмотреть/удалить сам).
 * @returns {{ok:boolean, to?:string, reason?:string}}
 */
function quarantineModel(modelsDir, modelId, reason) {
  const dir = path.join(modelsDir, 'stt', modelId)
  if (!fs.existsSync(dir)) return { ok: false, reason: 'Каталог модели отсутствует' }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const to = `${dir}.corrupt-${stamp}`
  try {
    fs.renameSync(dir, to)
    try {
      fs.writeFileSync(
        path.join(to, 'QUARANTINE.txt'),
        `AVC-Anime: модель ${modelId} помещена в карантин ${new Date().toISOString()}\nПричина: ${reason}\nЭто НЕ удаление: файлы сохранены здесь. Модель можно переустановить в Настройках → AI.\n`,
      )
    } catch { /* некритично */ }
    return { ok: true, to }
  } catch (e) {
    return { ok: false, reason: `Не удалось переместить: ${e.message}` }
  }
}

/** Все каталоги моделей в карантине (для диагностики/UI) */
function listQuarantined(modelsDir) {
  const sttDir = path.join(modelsDir, 'stt')
  const out = []
  try {
    for (const name of fs.readdirSync(sttDir)) {
      if (name.includes('.corrupt-')) out.push(name)
    }
  } catch { /* нет каталога */ }
  return out
}

/**
 * Первый ЗДОРОВЫЙ id модели из приоритетной цепочки.
 * preferred → gigaam-v3 → t-one → gigaam-v2; повреждённые пропускаются.
 * exclude — id, который нельзя выбирать (безопасный режим после нативного краша).
 */
function resolveHealthyModelId(modelsDir, preferred, exclude) {
  const chain = [preferred, 'gigaam-v3-russian', 't-one-russian', 'gigaam-v2-russian']
    .filter(Boolean)
    .filter((id, i, a) => a.indexOf(id) === i)
    .filter((id) => !exclude || id !== exclude)
  for (const id of chain) {
    if (checkModelIntegrity(modelsDir, id).ok) return id
  }
  return null
}

module.exports = {
  checkModelIntegrity,
  checkVadIntegrity,
  quarantineModel,
  listQuarantined,
  resolveHealthyModelId,
  onnxHeaderLooksSane,
  onnxProtobufWalkOk,
  CATALOG_FILES,
  MIN_FILE_BYTES,
}
