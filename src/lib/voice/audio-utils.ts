/**
 * Аудио-утилиты голосового слоя — чистые функции без React.
 * Вызываются только на клиенте (из хука useVoice), но сами React не знают.
 *
 * Используется хуком useVoice (src/lib/avc/use-voice.ts):
 *   - buildAudioConstraints / listMicDevices — захват и выбор микрофона из настроек;
 *   - createMicChain / rmsLevel / sensitivityToRms — обработка сигнала, VAD и индикатор уровня;
 *   - encodeWav16kMono / bufferToBase64 — конвертация записи в WAV 16 кГц mono
 *     для серверного ASR (качественнее, чем webm/opus с MediaRecorder).
 */
import type { AppSettings } from '../avc/types'

// ---------------------------------------------------------------------------
// Микрофон: constraints и список устройств
// ---------------------------------------------------------------------------

/**
 * MediaTrackConstraints из настроек пользователя.
 * deviceId передаётся как { ideal } — запрос не падает, если устройство отсутствует
 * (в отличие от { exact }, который кидает OverconstrainedError).
 */
export function buildAudioConstraints(
  settings: Pick<
    AppSettings,
    'echoCancellation' | 'noiseSuppression' | 'autoGainControl' | 'micDeviceId'
  >,
): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl,
  }
  if (settings.micDeviceId) {
    constraints.deviceId = { ideal: settings.micDeviceId }
  }
  return constraints
}

/**
 * Список микрофонов (navigator.mediaDevices.enumerateDevices, фильтр audioinput).
 * Без разрешения на микрофон браузер возвращает устройства с пустыми label —
 * в этом случае считаем список недоступным и возвращаем пустой массив.
 */
export async function listMicDevices(): Promise<MediaDeviceInfo[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return []
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    const mics = all.filter((d) => d.kind === 'audioinput')
    return mics.some((d) => d.label) ? mics : []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// VAD: порог тишины из чувствительности
// ---------------------------------------------------------------------------

const VAD_RMS_MAX = 0.06 // vadSensitivity = 0   (детектирует только громкую речь)
const VAD_RMS_MIN = 0.004 // vadSensitivity = 100 (детектирует очень тихую речь)

/**
 * vadSensitivity 0..100 → порог RMS 0.06..0.004 (лог-шкала; 50 ≈ 0.015 —
 * прежнее поведение по умолчанию). Выше чувствительность — ниже порог.
 */
export function sensitivityToRms(vadSensitivity: number): number {
  const s = Math.min(100, Math.max(0, vadSensitivity))
  return VAD_RMS_MAX * Math.pow(VAD_RMS_MIN / VAD_RMS_MAX, s / 100)
}

// ---------------------------------------------------------------------------
// WebAudio: обработка микрофона и уровень сигнала
// ---------------------------------------------------------------------------

export interface MicChain {
  ctx: AudioContext
  analyser: AnalyserNode
  /** Обработанный поток (после highpass → compressor → gain) — источник для MediaRecorder */
  destination: MediaStreamAudioDestinationNode
}

/**
 * WebAudio-цепочка обработки микрофона:
 *   source → BiquadFilter highpass 70 Гц (убирает гул/рокот) →
 *   → DynamicsCompressor (мягкий: threshold -24, knee 30, ratio 4) →
 *   → GainNode(gain) → analyser + MediaStreamDestination.
 *
 * Для записи используйте destination.stream — усиление (gain) реально
 * влияет на записанный сигнал; анализатор тишины висит на том же узле,
 * т.е. VAD тоже видит уже усиленный сигнал.
 */
export function createMicChain(stream: MediaStream, gain: number): MicChain {
  const Ctor: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ctx = new Ctor()

  const source = ctx.createMediaStreamSource(stream)

  const highpass = ctx.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.frequency.value = 70

  const compressor = ctx.createDynamicsCompressor()
  compressor.threshold.value = -24
  compressor.knee.value = 30
  compressor.ratio.value = 4
  compressor.attack.value = 0.003
  compressor.release.value = 0.25

  const gainNode = ctx.createGain()
  gainNode.gain.value = gain

  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024

  const destination = ctx.createMediaStreamDestination()

  source.connect(highpass)
  highpass.connect(compressor)
  compressor.connect(gainNode)
  gainNode.connect(analyser)
  gainNode.connect(destination)

  return { ctx, analyser, destination }
}

/** Текущий RMS сигнала анализатора 0..1 */
export function rmsLevel(analyser: AnalyserNode): number {
  const data = new Uint8Array(analyser.fftSize)
  analyser.getByteTimeDomainData(data)
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128
    sum += v * v
  }
  return Math.sqrt(sum / data.length)
}

// ---------------------------------------------------------------------------
// WAV 16 кГц mono + base64
// ---------------------------------------------------------------------------

/** Float32-семплы → WAV PCM 16-bit mono (корректный RIFF-заголовок) */
function encodeWavPcm16(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2
  const dataSize = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true) // размер файла минус 8 байт
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true) // размер fmt-чанка
  view.setUint16(20, 1, true) // формат PCM
  view.setUint16(22, 1, true) // каналов: mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true) // byte rate
  view.setUint16(32, bytesPerSample, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++, offset += bytesPerSample) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/**
 * Декодирует запись MediaRecorder (webm/opus и т.п.), применяет gain,
 * сводит в mono и ресемплирует в 16 кГц WAV PCM16.
 *
 * Если после усиления появляются пики > 0.98 (например, запись уже была
 * усилена в цепочке микрофона, а здесь gain применяется ещё раз) — семплы
 * мягко нормализуются: защита от клиппинга, который сильно ухудшает ASR.
 */
export async function encodeWav16kMono(blob: Blob, gain: number): Promise<Blob> {
  const Ctor: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext

  // 1. Декодируем исходный контейнер (контекст сразу закрываем)
  const decodeCtx = new Ctor()
  let decoded: AudioBuffer
  try {
    decoded = await decodeCtx.decodeAudioData(await blob.arrayBuffer())
  } finally {
    void decodeCtx.close().catch(() => undefined)
  }

  // 2. Офлайн-рендер: mono, 16 кГц, с применением gain
  const targetRate = 16000
  const frames = Math.max(1, Math.ceil(decoded.duration * targetRate))
  const offline = new OfflineAudioContext(1, frames, targetRate)
  const src = offline.createBufferSource()
  src.buffer = decoded
  const gainNode = offline.createGain()
  gainNode.gain.value = gain
  src.connect(gainNode)
  gainNode.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()

  // 3. Защита от клиппинга
  const samples = rendered.getChannelData(0)
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i])
    if (a > peak) peak = a
  }
  let out = samples
  if (peak > 0.98) {
    const k = 0.98 / peak
    out = new Float32Array(samples.length)
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] * k
  }

  return encodeWavPcm16(out, targetRate)
}

/** ArrayBuffer → base64 (чанками, чтобы не переполнить стек на больших файлах) */
export function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = Array.from(bytes.subarray(i, i + chunkSize))
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}
