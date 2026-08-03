import fs from "fs";
import { config } from "./config";
import { rtmpLog } from "./logger";
import { state } from "./state";
import { broadcast } from "./broadcaster";
import { bitrateDetector } from "./bitrate-detector";
import { LameEncoder, isNativeLameAvailable } from "./lame-ffi";
import { NativeDecoder, isNativeDecodeAvailable } from "./decode-ffi";
import { DspChain } from "./dsp";
import { FORMAT_CONFIG } from "./format-config";

// =============================================================
// 1. CLASE BUFFER FIFO DE AUDIO PCM
// =============================================================
// Diseño "cero allocaciones": un deck secundario solo necesita la
// ventana de crossfade de audio bufferizada (el resto de la canción se
// descarta al llenarse el FIFO). Antes se bufferizaba la canción
// completa (~46MB por tema a 192KB/s) y esa memoria quedaba retenida
// hasta que el deck moría. pullInto() escribe en un buffer del pool PCM
// (reutilizable) en vez de alocar uno nuevo por chunk.
// 192KB/s = 48000Hz × 2ch × 2bytes.
const DECK_BUFFER_CAP_BYTES = (config.crossfadeSeconds + 1) * 192_000;

class AudioStreamBuffer {
  private queue: Uint8Array[] = [];
  private totalBytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes = 0) {
    this.maxBytes = maxBytes;
  }

  push(chunk: Uint8Array) {
    if (this.maxBytes > 0 && this.totalBytes >= this.maxBytes) return;
    this.queue.push(chunk);
    this.totalBytes += chunk.byteLength;
    if (this.maxBytes > 0) {
      while (this.totalBytes > this.maxBytes && this.queue.length > 1) {
        const removed = this.queue.shift()!;
        this.totalBytes -= removed.byteLength;
      }
    }
  }

  // Copia del FIFO hacia `target` (un buffer del pool PCM, reutilizable).
  // Devuelve los bytes escritos; el mezclador solo procesa esa región.
  pullInto(target: Uint8Array): number {
    let bytesWritten = 0;
    while (bytesWritten < target.length && this.queue.length > 0) {
      const chunk = this.queue[0]!;
      const remaining = target.length - bytesWritten;

      if (chunk.byteLength <= remaining) {
        target.set(chunk, bytesWritten);
        bytesWritten += chunk.byteLength;
        this.queue.shift();
        this.totalBytes -= chunk.byteLength;
      } else {
        target.set(chunk.subarray(0, remaining), bytesWritten);
        this.queue[0] = chunk.subarray(remaining);
        this.totalBytes -= remaining;
        bytesWritten += remaining;
      }
    }
    return bytesWritten;
  }

  clear() {
    this.queue = [];
    this.totalBytes = 0;
  }

  get length() {
    return this.totalBytes;
  }
}

// =============================================================
// 2. ESTRUCTURA DE DECKS (REPRODUCTORES DE AUDIO)
// =============================================================
interface Deck {
  id: "A" | "B";
  buffer: AudioStreamBuffer;
  process: any | null;
  currentTrackFile: string | null;
}

export const deckA: Deck = {
  id: "A",
  buffer: new AudioStreamBuffer(DECK_BUFFER_CAP_BYTES),
  process: null,
  currentTrackFile: null,
};

export const deckB: Deck = {
  id: "B",
  buffer: new AudioStreamBuffer(DECK_BUFFER_CAP_BYTES),
  process: null,
  currentTrackFile: null,
};

export let fallbackPlaylist: string[] = [];
export let currentPlaylistIndex = 0;
let isPlaylistInitialized = false;

// Variables de Control de Transición
export let activeDeck: "A" | "B" = "A";
export let transitionStarted = false;
let crossfadeStartTime = 0;

let isLiveTransitionActive = false;
let liveTransitionStartTime = 0;

let isFallbackFadeInActive = false;
let fallbackFadeInStartTime = 0;

export let isStoppingFallback = false;

// Encoder nativo (LAME-FFI + DSP Bun). Si está activo, reemplaza
// el proceso master ffmpeg. Si es null, se usa el path ffmpeg.
let nativeEncoder: { encoder: LameEncoder; dsp: DspChain | null } | null = null;
let nativeDecodeAnnounced = false;

function shuffle(array: string[]) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = array[i]!;
    array[i] = array[j]!;
    array[j] = temp;
  }
}

// =============================================================
// 3. POOL DE BUFFERS PCM (evita allocations en hot path)
// =============================================================
// mixWithBuffer y applyVolume son llamadas ~48 veces/segundo durante
// crossfades/fades. Antes allocateaban un ArrayBuffer nuevo por
// llamada, presionando el GC. Este pool rota N ArrayBuffers
// pre-asignados al tamaño máximo visto. Después de writeToMaster()
// (write + flush síncronos al pipe kernel) el buffer es seguro de
// reutilizar.
const PCM_POOL_SIZE = 4;
const pcmPool: (ArrayBuffer | null)[] = new Array(PCM_POOL_SIZE).fill(null);
let pcmPoolIdx = 0;
let pcmMaxBytes = 0;

function acquirePcmBuffer(byteLength: number): ArrayBuffer {
  if (byteLength > pcmMaxBytes) {
    pcmMaxBytes = byteLength;
    for (let i = 0; i < PCM_POOL_SIZE; i++) {
      pcmPool[i] = new ArrayBuffer(pcmMaxBytes);
    }
  }
  const buf = pcmPool[pcmPoolIdx]!;
  pcmPoolIdx = (pcmPoolIdx + 1) % PCM_POOL_SIZE;
  return buf;
}

// =============================================================
// 4. CACHÉ PERSISTENTE DE METADATOS FFPROBE
// =============================================================
// Evita spawmear ffprobe por cada canción nueva, especialmente en
// loops de playlist corta donde la misma canción se repite. La
// clave es la ruta absoluta del archivo; se invalida por mtime.
const META_CACHE_FILE = ".meta-cache.json";
const metaCache = new Map<string, { title: string; artist: string; duration: number; mtime: number }>();
let metaCacheDirty = false;
let metaCacheLoaded = false;

function loadMetaCache() {
  if (metaCacheLoaded) return;
  metaCacheLoaded = true;
  try {
    const raw = fs.readFileSync(META_CACHE_FILE, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === "object" && typeof (v as any).mtime === "number") {
          metaCache.set(k, v as any);
        }
      }
      rtmpLog.info(`[Meta Cache] Cargados ${metaCache.size} metadatos en caché desde ${META_CACHE_FILE}.`);
    }
  } catch {
    // No existe o inválido - empezar vacío
  }
}

function persistMetaCache() {
  if (!metaCacheDirty) return;
  try {
    const obj: Record<string, { title: string; artist: string; duration: number; mtime: number }> = {};
    for (const [k, v] of metaCache) obj[k] = v;
    fs.writeFileSync(META_CACHE_FILE, JSON.stringify(obj));
    metaCacheDirty = false;
  } catch {
    // noop
  }
}

// =============================================================
// 5. MEZCLADORES MATEMÁTICOS DE PCM (TypedArrays)
// =============================================================
// Mezcla un chunk A (volA) con el FIFO de un deck (volB) escribiendo
// DIRECTAMENTE en un buffer del pool PCM. Cero allocaciones en el hot
// path: pullInto() escribe B sobre el buffer de salida y la mezcla es
// in-place. Devuelve una vista del pool (válida hasta el siguiente
// acquirePcmBuffer; writeToMaster la consume síncronamente).
function mixWithBuffer(chunkA: Uint8Array, volA: number, source: AudioStreamBuffer, volB: number): Uint8Array {
  const outBuffer = acquirePcmBuffer(chunkA.byteLength);
  const out = new Uint8Array(outBuffer, 0, chunkA.byteLength);
  const outSamples = new Int16Array(outBuffer, 0, chunkA.byteLength / 2);
  const pulled = source.pullInto(out);

  const samplesA = new Int16Array(chunkA.buffer, chunkA.byteOffset, chunkA.byteLength / 2);
  const minLen = Math.min(samplesA.length, pulled / 2);
  for (let i = 0; i < minLen; i++) {
    let mixed = (samplesA[i]! * volA) + (outSamples[i]! * volB);
    if (mixed > 32767) mixed = 32767;
    else if (mixed < -32768) mixed = -32768;
    outSamples[i] = mixed;
  }
  // Cola del stream A (sin mezclar, solo volumen)
  for (let i = minLen; i < samplesA.length; i++) {
    outSamples[i] = samplesA[i]! * volA;
  }

  return out;
}

// Aplica volumen a un chunk escribiendo en un buffer del pool PCM
// (cero allocaciones; antes alocaba un Uint8Array nuevo por chunk).
function applyVolume(chunk: Uint8Array, volume: number): Uint8Array {
  if (volume === 1.0) return chunk;

  const byteLength = chunk.byteLength;
  const outBuffer = acquirePcmBuffer(byteLength);
  const out = new Uint8Array(outBuffer, 0, byteLength);
  const outSamples = new Int16Array(outBuffer, 0, byteLength / 2);

  if (volume === 0.0) {
    outSamples.fill(0); // pool reutilizado: hay que poner ceros explícitos
    return out;
  }

  const inSamples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
  for (let i = 0; i < outSamples.length; i++) {
    const scaled = Math.round(inSamples[i]! * volume);
    outSamples[i] = Math.max(-32768, Math.min(32767, scaled));
  }
  return out;
}

function writeToMaster(chunk: Uint8Array) {
  if (nativeEncoder) {
    // --- Modo nativo: DSP + LAME FFI (sin ffmpeg) ---
    const frameBytes = 4; // stereo s16le = 4 bytes por frame
    const alignedLen = Math.floor(chunk.byteLength / frameBytes) * frameBytes;
    if (alignedLen === 0) return;

    const pcm = new Int16Array(
      chunk.buffer,
      chunk.byteOffset,
      alignedLen / 2,
    );

    const processed = nativeEncoder.dsp
      ? nativeEncoder.dsp.process(pcm)
      : pcm;

    const mp3 = nativeEncoder.encoder.encode(processed);
    if (mp3.length > 0) {
      bitrateDetector.feed(mp3);
      broadcast(mp3);
    }
  } else if (state.masterProcess?.stdin) {
    // --- Modo ffmpeg (fallback) ---
    try {
      state.masterProcess.stdin.write(chunk);
      state.masterProcess.stdin.flush();
    } catch {
      /* noop */
    }
  }
}

export function broadcastSse(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of state.sseClients) {
    try {
      client.enqueue(payload);
    } catch {
      state.sseClients.delete(client);
    }
  }
}

export function reshufflePlaylist() {
  shuffle(fallbackPlaylist);
  currentPlaylistIndex = 0;
  rtmpLog.info("[Fallback Playlist] Playlist remezclada bajo petición de la API.");
  broadcastSse("playlist-updated", { playlist: fallbackPlaylist });
  if ((deckA.process || deckB.process) && !state.isBroadcasting) {
    stopFallback();
  }
}

async function getFileMetadata(file: string) {
  const isUrl = /^(https?|rtmp):\/\//i.test(file);
  if (isUrl) {
    const urlName = file.split("/").pop() || "Stream Externo";
    return {
      title: urlName.substring(0, 60),
      artist: "Transmisión Web",
      duration: 0,
    };
  }

  loadMetaCache();

  // Cache lookup: si tenemos el metadato y el mtime coincide, devolverlo sin ffprobe
  let mtime = 0;
  try {
    const stat = fs.statSync(file);
    mtime = stat.mtimeMs;
    const cached = metaCache.get(file);
    if (cached && cached.mtime === mtime) {
      return { title: cached.title, artist: cached.artist, duration: cached.duration };
    }
  } catch {
    // Si stat falla, no podemos usar la caché pero intentamos ffprobe igual
  }

  try {
    const proc = Bun.spawn([
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format_tags=title,artist:format=duration",
      "-of",
      "json",
      file,
    ]);
    const text = await new Response(proc.stdout).text();
    const data = JSON.parse(text);
    const tags = data.format?.tags || {};
    const duration = Number(data.format?.duration) || 0;
    const meta = {
      title: tags.title || tags.TITLE || "",
      artist: tags.artist || tags.ARTIST || "",
      duration,
    };

    // Guardar en caché persistente
    if (mtime > 0) {
      metaCache.set(file, { ...meta, mtime });
      metaCacheDirty = true;
      persistMetaCache();
    }

    return meta;
  } catch (err) {
    rtmpLog.error("Error leyendo metadatos con ffprobe:", (err as Error).message);
    return { title: "", artist: "", duration: 0 };
  }
}

function getAudioFilesRecursive(dir: string): string[] {
  let results: string[] = [];
  try {
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const filePath = `${dir}/${file}`;
      const stat = fs.statSync(filePath);
      if (stat && stat.isDirectory()) {
        results = results.concat(getAudioFilesRecursive(filePath));
      } else if (/\.(mp3|flac|wav|m4a|aac|ogg)$/i.test(file)) {
        results.push(filePath);
      }
    }
  } catch (err) {
    // Si hay un error leyendo una subcarpeta (por ejemplo, permisos), lo ignoramos para continuar con el resto
  }
  return results;
}

function initializeFallbackSource() {
  if (!config.fallbackSource) return;

  try {
    const stat = fs.statSync(config.fallbackSource);
    if (stat.isDirectory()) {
      const audioFiles = getAudioFilesRecursive(config.fallbackSource);

      if (audioFiles.length === 0) {
        rtmpLog.warn(`La carpeta de fallback "${config.fallbackSource}" no contiene archivos de audio válidos.`);
        fallbackPlaylist = [];
        return;
      }

      fallbackPlaylist = audioFiles;
      shuffle(fallbackPlaylist);
      currentPlaylistIndex = 0;
      isPlaylistInitialized = true;
      rtmpLog.info(`Inicializada carpeta de fallback con ${audioFiles.length} canciones recursivamente y mezcladas aleatoriamente.`);
    } else {
      fallbackPlaylist = [config.fallbackSource];
      currentPlaylistIndex = 0;
      isPlaylistInitialized = true;
      rtmpLog.info(`Inicializado archivo de fallback único: ${config.fallbackSource}`);
    }
  } catch (err) {
    rtmpLog.error(`Error al acceder a FALLBACK_SOURCE "${config.fallbackSource}":`, (err as Error).message);
    fallbackPlaylist = [];
  }
}

// =============================================================
// 3b. FILE WATCHER — Detección en caliente de cambios en la carpeta fallback
// =============================================================
let playlistWatcher: fs.FSWatcher | null = null;
let rescanDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let pollingTimer: ReturnType<typeof setInterval> | null = null;
let lastKnownFiles: string[] = [];
const RESCAN_DEBOUNCE_MS = 500;
const POLL_INTERVAL_MS = 5000;

/**
 * Compara la lista actual de archivos con la caché y dispara rescan si hay cambios.
 */
function pollForChanges() {
  if (!config.fallbackSource || !isPlaylistInitialized) return;

  try {
    const stat = fs.statSync(config.fallbackSource);
    if (!stat.isDirectory()) return;

    const currentFiles = getAudioFilesRecursive(config.fallbackSource);
    const prevFiles = lastKnownFiles;

    if (prevFiles.length === 0) {
      lastKnownFiles = currentFiles;
      return;
    }

    // Comparación rápida por longitud y contenido
    const sameLength = currentFiles.length === prevFiles.length;
    const sameContent = sameLength && currentFiles.every((f, i) => f === prevFiles[i]);

    if (!sameContent) {
      lastKnownFiles = currentFiles;
      // Debounce para evitar múltiples rescans si el watcher también detecta
      if (rescanDebounceTimer) clearTimeout(rescanDebounceTimer);
      rescanDebounceTimer = setTimeout(() => {
        rescanPlaylist();
        rescanDebounceTimer = null;
      }, RESCAN_DEBOUNCE_MS);
    }
  } catch {
    // Silenciar errores de polling
  }
}

/**
 * Re-escanea la carpeta de fallback y reconstruye la playlist.
 * Preserva el orden relativo de las canciones que siguen existentes
 * y ajusta el índice actual para no perder la posición.
 */
function rescanPlaylist() {
  if (!config.fallbackSource || !isPlaylistInitialized) return;

  try {
    const stat = fs.statSync(config.fallbackSource);
    if (!stat.isDirectory()) return;

    const newFiles = getAudioFilesRecursive(config.fallbackSource);
    lastKnownFiles = newFiles; // Actualizar caché

    const oldFiles = new Set(fallbackPlaylist);

    // Detectar cambios
    const added = newFiles.filter((f) => !oldFiles.has(f));
    const removed = fallbackPlaylist.filter((f) => !newFiles.includes(f));

    if (added.length === 0 && removed.length === 0) return; // Sin cambios reales

    // Loggear cambios
    for (const f of added) {
      rtmpLog.info(`[Playlist Watch] + Canción añadida: ${f.split("/").pop()}`);
    }
    for (const f of removed) {
      rtmpLog.info(`[Playlist Watch] - Canción eliminada: ${f.split("/").pop()}`);
    }

    // Determinar la canción que está sonando ahora mismo para preservar posición
    const currentFile = state.currentTrack?.file;
    const oldIndex = currentPlaylistIndex > 0 ? currentPlaylistIndex - 1 : 0;
    const fileAtIndex = fallbackPlaylist[oldIndex];

    // Reconstruir playlist: mantener orden relativo de las que siguen, añadir nuevas al final
    const existingInOrder = fallbackPlaylist.filter((f) => newFiles.includes(f));
    const trulyNew = added; // Ya están en newFiles pero no en oldFiles
    fallbackPlaylist.length = 0;
    fallbackPlaylist.push(...existingInOrder, ...trulyNew);

    // Reconstruir índice: apuntar a la siguiente canción después de la que estaba sonando
    if (currentFile && newFiles.includes(currentFile)) {
      const idx = fallbackPlaylist.indexOf(currentFile);
      currentPlaylistIndex = (idx + 1) % fallbackPlaylist.length;
    } else if (fileAtIndex && newFiles.includes(fileAtIndex)) {
      const idx = fallbackPlaylist.indexOf(fileAtIndex);
      currentPlaylistIndex = (idx + 1) % fallbackPlaylist.length;
    } else {
      // La canción de referencia ya no existe, ajustar índice
      if (currentPlaylistIndex > fallbackPlaylist.length) {
        currentPlaylistIndex = 0;
      }
    }

    rtmpLog.info(
      `[Playlist Watch] Playlist reconstruida: ${removed.length} eliminada(s), ${added.length} añadida(s). Total: ${fallbackPlaylist.length} canciones.`,
    );
    broadcastSse("playlist-updated", { playlist: fallbackPlaylist });
  } catch (err) {
    rtmpLog.error("[Playlist Watch] Error al re-escanear carpeta:", (err as Error).message);
  }
}

/**
 * Inicia el file watcher en la carpeta de fallback.
 * Estrategia híbrida:
 *  1. fs.watch() para cambios instantáneos (funciona en la mayoría de sistemas)
 *  2. Polling cada 5s como safety net (necesario en Docker Windows→Linux)
 */
function startPlaylistWatcher() {
  if (playlistWatcher || !config.fallbackSource) return;

  try {
    const stat = fs.statSync(config.fallbackSource);
    if (!stat.isDirectory()) return;

    // Cachear archivos iniciales para el polling
    lastKnownFiles = getAudioFilesRecursive(config.fallbackSource);

    // 1. fs.watch() — notificación instantánea
    try {
      playlistWatcher = fs.watch(config.fallbackSource, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        if (!/\.(mp3|flac|wav|m4a|aac|ogg)$/i.test(filename)) return;

        if (rescanDebounceTimer) clearTimeout(rescanDebounceTimer);
        rescanDebounceTimer = setTimeout(() => {
          rescanPlaylist();
          rescanDebounceTimer = null;
        }, RESCAN_DEBOUNCE_MS);
      });
      rtmpLog.info(`[Playlist Watch] fs.watch() activo en: ${config.fallbackSource}`);
    } catch {
      rtmpLog.warn("[Playlist Watch] fs.watch() no disponible, usando solo polling.");
    }

    // 2. Polling — safety net cada 5s (necesario en Docker/Windows)
    pollingTimer = setInterval(pollForChanges, POLL_INTERVAL_MS);
    rtmpLog.info(`[Playlist Watch] Polling activo cada ${POLL_INTERVAL_MS / 1000}s.`);
  } catch (err) {
    rtmpLog.warn(`[Playlist Watch] No se pudo monitorear la carpeta: ${(err as Error).message}`);
  }
}

/**
 * Detiene el file watcher y el polling (llamado en shutdown).
 */
export function stopPlaylistWatcher() {
  if (rescanDebounceTimer) {
    clearTimeout(rescanDebounceTimer);
    rescanDebounceTimer = null;
  }
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
  if (playlistWatcher) {
    playlistWatcher.close();
    playlistWatcher = null;
  }
  rtmpLog.info("[Playlist Watch] Watcher y polling detenidos.");
}

export function startMasterEncoder() {
  if (state.masterProcess || nativeEncoder) return;

  // --- Intentar modo nativo (LAME-FFI + DSP Bun) solo para MP3 ---
  if (config.streamFormat === "mp3" && config.useNativeLame !== "false" && isNativeLameAvailable()) {
    try {
      const encoder = new LameEncoder(
        48000,
        2,
        config.fallbackBitrateKbps,
        2, // quality 2 = buena calidad (0=mejor, 9=más rápido)
      );
      const dsp = config.audioProcessing ? new DspChain() : null;
      nativeEncoder = { encoder, dsp };
      rtmpLog.info(
        `[Master Encoder] Modo nativo activo (LAME-FFI${dsp ? " + DSP Bun" : ""}) a ${config.fallbackBitrateKbps}kbps. Sin proceso ffmpeg.`,
      );
      return;
    } catch (err) {
      rtmpLog.error(
        "[Master Encoder] Error iniciando LAME nativo, fallback a ffmpeg:",
        (err as Error).message,
      );
    }
  }

  // --- Fallback: FFmpeg master encoder ---
  startFfmpegMasterEncoder();
}

function startFfmpegMasterEncoder() {
  const fmt = FORMAT_CONFIG[config.streamFormat];
  rtmpLog.info(`Iniciando Codificador Maestro FFmpeg [${config.streamFormat.toUpperCase()}] a ${config.fallbackBitrateKbps}kbps...`);

  const args = [
    "-loglevel", "warning",
    "-fflags", "nobuffer",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "-i", "pipe:0",
    ...(config.audioProcessing
      ? ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11,compand=attacks=0:decays=1:points=-90/-90|-20/-20|0/-10"]
      : []),
    "-acodec", fmt.codec,
    ...fmt.args(config.fallbackBitrateKbps),
    "-flush_packets", "1",
    "-f", fmt.muxer,
    "-"
  ];

  try {
    state.masterProcess = Bun.spawn(["ffmpeg", ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });

    const reader = state.masterProcess.stdout.getReader();
    
    const processInstance = state.masterProcess;
    processInstance.exited.then((exitCode: number) => {
      if (state.masterProcess === processInstance) {
        rtmpLog.warn(`[Master Encoder] El proceso del Codificador Maestro terminó (exitCode: ${exitCode}). Limpiando.`);
        try {
          reader.cancel();
        } catch {
          /* noop */
        }
        state.masterProcess = null;
      }
    }).catch(() => {});

    pipeMaster(reader);
  } catch (err) {
    rtmpLog.error("Error al iniciar Codificador Maestro FFmpeg:", (err as Error).message);
  }
}

async function pipeMaster(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        rtmpLog.info("Flujo de salida del Codificador Maestro cerrado.");
        break;
      }
      bitrateDetector.feed(value);
      broadcast(value);
    }
  } catch (err) {
    if (!state.shuttingDown) {
      rtmpLog.error("Error leyendo salida del Codificador Maestro:", (err as Error).message);
    }
  }
}

export function stopMasterEncoder() {
  // --- Modo nativo ---
  if (nativeEncoder) {
    rtmpLog.info("Deteniendo Codificador Maestro Nativo...");
    const flushed = nativeEncoder.encoder.flush();
    if (flushed.length > 0) {
      bitrateDetector.feed(flushed);
      broadcast(flushed);
    }
    nativeEncoder.encoder.close();
    nativeEncoder = null;
    return;
  }

  // --- Modo ffmpeg ---
  if (!state.masterProcess) return;
  rtmpLog.info("Deteniendo Codificador Maestro FFmpeg...");
  try {
    state.masterProcess.stdin.end();
    state.masterProcess.kill();
  } catch {
    /* noop */
  }
  state.masterProcess = null;
}

export function startFallback() {
  if (!config.fallbackSource) {
    rtmpLog.warn("No hay archivo de fallback configurado (FALLBACK_SOURCE vacío).");
    return;
  }

  let currentDeck = activeDeck === "A" ? deckA : deckB;
  if (currentDeck.process) {
    // Si el deck activo ya está reproduciendo, cargamos en el deck inactivo (para crossfade)
    currentDeck = activeDeck === "A" ? deckB : deckA;
  }
  if (currentDeck.process) return;

  if (state.fallbackPaused) {
    state.currentTrack = null;
    broadcastSse("track-changed", null);
    return;
  }

  if (!isPlaylistInitialized) {
    initializeFallbackSource();
    startPlaylistWatcher();
  }

  startMasterEncoder();

  let fileToPlay = "";
  if (state.fallbackQueue.length > 0) {
    fileToPlay = state.fallbackQueue.shift()!;
    broadcastSse("queue-updated", { queue: state.fallbackQueue });
  } else {
    if (fallbackPlaylist.length === 0) {
      rtmpLog.warn("La lista de reproducción de fallback está vacía.");
      return;
    }
    fileToPlay = fallbackPlaylist[currentPlaylistIndex]!;
    currentPlaylistIndex++;
    if (currentPlaylistIndex >= fallbackPlaylist.length) {
      rtmpLog.info("[Fallback Playlist] Fin de lista. Mezclando de nuevo de forma aleatoria...");
      shuffle(fallbackPlaylist);
      currentPlaylistIndex = 0;
    }
  }

  const cleanName = fileToPlay.split("/").pop() || "Desconocido";
  rtmpLog.info(`[Deck ${currentDeck.id}] Cargando canción: ${cleanName}`);

  currentDeck.currentTrackFile = fileToPlay;

  getFileMetadata(fileToPlay).then((meta) => {
    state.currentTrack = {
      file: fileToPlay,
      title: meta.title || cleanName.replace(/\.[^/.]+$/, ""),
      artist: meta.artist || "Artista Desconocido",
      duration: meta.duration,
      startedAt: Date.now(),
    };
    broadcastSse("track-changed", state.currentTrack);
  });

  const args = [
    "-loglevel", "warning",
    "-fflags", "nobuffer",
    "-re",
    "-i", fileToPlay,
    "-vn",
    // Forzar chunks de salida GRANDES (1 por segundo, ~192KB):
    // ffmpeg por defecto emite ~4.6KB cada 24ms → ~46 allocaciones
    // pequeñas/s que quedan retenidas en los segmentos del allocator
    // (la causa de la RSS creciente a 1.3GB). Con asetnsamples los
    // chunks pasan a 192KB, que mimalloc asigna vía mmap y devuelve
    // al OS al liberarlos.
    "-af", "asetnsamples=n=48000",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "-"
  ];

  try {
    // --- Modo nativo: decode in-process (libavcodec FFI), sin proceso ffmpeg ---
    if (config.useNativeDecode !== "false" && isNativeDecodeAvailable()) {
      try {
        const decoder = new NativeDecoder(fileToPlay);
        currentDeck.process = decoder as unknown as any;
        // El tipo del reader nativo difiere del de Bun.spawn (node:stream/web
        // vs bun); la interfaz runtime es idéntica ({read, cancel}).
        const reader = decoder.stdout.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>;
        pipeFallback(currentDeck, reader);
        if (!nativeDecodeAnnounced) {
          nativeDecodeAnnounced = true;
          rtmpLog.info("[Deck] Decode nativo activo (libavcodec FFI). Decks sin proceso ffmpeg.");
        }
        return;
      } catch (err) {
        rtmpLog.warn(
          `[Deck ${currentDeck.id}] Decode nativo falló para "${cleanName}", usando ffmpeg: ${(err as Error).message}`,
        );
      }
    }

    currentDeck.process = Bun.spawn(["ffmpeg", ...args], {
      stdout: "pipe",
      stderr: "inherit",
    });

    const reader = currentDeck.process.stdout.getReader();
    pipeFallback(currentDeck, reader);
  } catch (err) {
    rtmpLog.error(`Error al iniciar FFmpeg en Deck ${currentDeck.id}:`, (err as Error).message);
  }
}

// =============================================================
// 4. BUCLE DE INGESTA DE FALLBACK (RELOJ CONDUCIDO POR EVENTOS)
// =============================================================
async function pipeFallback(deck: Deck, reader: ReadableStreamDefaultReader<Uint8Array>) {
  const processInstance = deck.process;
  if (processInstance) {
    processInstance.exited.then((exitCode: number) => {
      if (deck.process === processInstance && !transitionStarted) {
        rtmpLog.info(`[Deck ${deck.id}] El proceso terminó (exitCode: ${exitCode}). Cancelando lector.`);
        try {
          reader.cancel();
        } catch {
          /* noop */
        }
      }
    }).catch(() => {});
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Si este deck es el secundario, simplemente almacenamos en búfer y no escribimos al maestro.
      // El deck primario (reloj) consumirá este búfer en sus fundidos.
      if (activeDeck !== deck.id) {
        deck.buffer.push(value);
        continue;
      }

      // Si este deck es el primario (conductor del reloj de ingesta):
      if (!state.isBroadcasting) {
        if (transitionStarted) {
          // Fundido cruzado activo entre Deck A y Deck B
          const elapsed = Date.now() - crossfadeStartTime;
          const progress = Math.min(1.0, elapsed / (config.crossfadeSeconds * 1000));
          
          const volOut = 1.0 - progress;
          const volIn = progress;

          const nextDeck = deck.id === "A" ? deckB : deckA;
          const mixed = mixWithBuffer(value, volOut, nextDeck.buffer, volIn);

          writeToMaster(mixed);

          if (progress >= 1.0) {
            transitionStarted = false;
            // Detener el deck saliente (este deck)
            const oldDeck = deck;
            activeDeck = nextDeck.id; // El nuevo deck pasa a ser el primario
            
            setTimeout(() => {
              if (oldDeck.process) {
                try { oldDeck.process.kill(); } catch {}
                oldDeck.process = null;
                oldDeck.currentTrackFile = null;
                oldDeck.buffer.clear();
              }
            }, 50);
          }
        } else if (isFallbackFadeInActive) {
          // Fundido de entrada suave (después de desconexión de OBS)
          const elapsed = Date.now() - fallbackFadeInStartTime;
          const progress = Math.min(1.0, elapsed / (config.crossfadeSeconds * 1000));

          const faded = applyVolume(value, progress);
          writeToMaster(faded);

          if (progress >= 1.0) {
            isFallbackFadeInActive = false;
          }
        } else {
          // Reproducción normal al 100% de volumen
          writeToMaster(value);

          // Monitorear final de tema para disparar crossfade
          if (state.currentTrack && state.currentTrack.duration > 0) {
            const elapsed = (Date.now() - state.currentTrack.startedAt) / 1000;
            const remaining = state.currentTrack.duration - elapsed;

            if (remaining <= config.crossfadeSeconds && !transitionStarted) {
              transitionStarted = true;
              crossfadeStartTime = Date.now();
              rtmpLog.info(`[Crossfade] Fin de tema. Solapando desde Deck ${deck.id}.`);
              
              // Iniciar el siguiente en el deck inactivo
              startFallback();
            }
          }
        }
      }
    }
  } catch (err) {
    if (!isStoppingFallback) {
      rtmpLog.error(`Error leyendo flujo de Deck ${deck.id}:`, (err as Error).message);
    }
  } finally {
    const wasIntentionallyStopped = deck.process === null;
    deck.process = null;
    deck.currentTrackFile = null;
    deck.buffer.clear();

    if (!state.isBroadcasting && !state.shuttingDown && !wasIntentionallyStopped) {
      if (activeDeck === deck.id && !transitionStarted) {
        // Caso normal: deck terminó sin crossfade activo
        activeDeck = activeDeck === "A" ? "B" : "A";
        startFallback();
      } else if (activeDeck === deck.id && transitionStarted) {
        // FIX: Deck terminó durante un crossfade — completar la transición
        rtmpLog.info(`[Deck ${deck.id}] Proceso terminó durante crossfade. Completando transición.`);
        transitionStarted = false;
        activeDeck = deck.id === "A" ? "B" : "A";
        const newDeck = activeDeck === "A" ? deckA : deckB;
        newDeck.buffer.clear();
        if (!newDeck.process) {
          startFallback();
        }
      }
    }
  }
}

export function stopFallback() {
  isStoppingFallback = true;
  if (deckA.process) {
    try { deckA.process.kill(); } catch {}
    deckA.process = null;
  }
  if (deckB.process) {
    try { deckB.process.kill(); } catch {}
    deckB.process = null;
  }
  deckA.buffer.clear();
  deckB.buffer.clear();
  
  state.currentTrack = null;
  broadcastSse("track-changed", null);
  
  isStoppingFallback = false;
}

export function actionSkipFallback() {
  rtmpLog.info("[API] Solicitud de Skip recibida.");
  stopFallback();
  transitionStarted = false;
  isFallbackFadeInActive = false;

  setTimeout(() => {
    if (!state.isBroadcasting && !state.shuttingDown) {
      activeDeck = activeDeck === "A" ? "B" : "A";
      startFallback();
    }
  }, 100);
}

// =============================================================
// 5. BUCLE DE EN VIVO DE OBS (RELOJ CONDUCIDO POR RED RTMP)
// =============================================================
export async function runRtmpListener() {
  startMasterEncoder();

  // Detección de flaps: si RTMP se desconecta muchas veces en poco tiempo,
  // se ignora la fuente durante un periodo de enfriamiento para no romper
  // el audio de respaldo con idas y venidas continuas.
  const flapWindowMs = 30000;
  const flapMaxCount = 3;
  const flapCooldownMs = 60000;
  let disconnectTimestamps: number[] = [];
  let rtmpCooldownUntil = 0;

  while (true) {
    if (state.shuttingDown) break;

    if (Date.now() < rtmpCooldownUntil) {
      rtmpLog.warn(`[RTMP] En enfriamiento por flaps. Ignorando conexiones hasta ${new Date(rtmpCooldownUntil).toISOString()}`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    rtmpLog.info(`Esperando conexión RTMP de OBS en rtmp://${config.host}:${config.rtmpPort}/live/${config.rtmpStreamKey}`);

    const args = [
      "-loglevel", "warning",
      "-fflags", "nobuffer",
      "-listen", "1",
      "-i", `rtmp://${config.host}:${config.rtmpPort}/live/${config.rtmpStreamKey}`,
      "-vn",
      // Mismo motivo que en los decks: chunks grandes (1/s) en vez de
      // ~46 allocaciones pequeñas/s retenidas por el allocator.
      "-af", "asetnsamples=n=48000",
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "-"
    ];

    // Watchdog de conexión silenciosa (visible en el finally de abajo)
    let silentWatchdog: ReturnType<typeof setInterval> | null = null;

    try {
      state.sourceProcess = Bun.spawn(["ffmpeg", ...args], {
        stdout: "pipe",
        stderr: "inherit",
      });

      state.sourceConnected = true;
      const reader = state.sourceProcess.stdout.getReader();

      const processInstance = state.sourceProcess;
      processInstance.exited.then((exitCode: number) => {
        if (state.sourceProcess === processInstance) {
          rtmpLog.info(`[RTMP Listener] El proceso de receptor RTMP terminó (exitCode: ${exitCode}). Cancelando lector.`);
          try {
            reader.cancel();
          } catch {
            /* noop */
          }
        }
      }).catch(() => {});

      // No pasar a "vivo" hasta recibir audio de forma sostenida. Esto filtra
      // conexiones breves/sondas que provocan cortes en el respaldo.
      // Watchdog: si la conexión aceptada no envía audio, el ffmpeg -listen
      // queda colgado indefinidamente (OBS conectado pero mudo/silencioso).
      // Cada 120s sin nuevos bytes se mata el proceso; el cleanup y el bucle
      // externo reintentan la escucha.
      let lastAudioBytes = state.totalBytesReceived;
      silentWatchdog = setInterval(() => {
        if (state.sourceProcess !== processInstance) return;
        if (state.totalBytesReceived === lastAudioBytes) {
          rtmpLog.warn("[RTMP] Conexión sin audio durante 120s. Reiniciando receptor...");
          try {
            processInstance.kill();
          } catch {
            /* noop */
          }
        }
        lastAudioBytes = state.totalBytesReceived;
      }, 120_000);

      let firstAudioAt = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value.byteLength > 0) {
          state.totalBytesReceived += value.byteLength;
          if (firstAudioAt === 0) firstAudioAt = Date.now();
          const sustained = (Date.now() - firstAudioAt) >= config.rtmpMinLiveSeconds * 1000;

          if (!state.isBroadcasting && sustained) {
            state.isBroadcasting = true;
            liveTransitionStartTime = Date.now();
            isLiveTransitionActive = config.crossfadeSeconds > 0;

            rtmpLog.info(`¡Conexión RTMP establecida y transmitiendo audio en VIVO! (tras ${config.rtmpMinLiveSeconds}s de audio sostenido)`);

            state.currentTrack = null;
            broadcastSse("track-changed", null);
            broadcastSse("state-updated", { broadcasting: true, sourceConnected: true });
          }
        } else {
          firstAudioAt = 0; // Reiniciar conteo si hay un vacío de audio
        }

        if (state.isBroadcasting) {
          if (isLiveTransitionActive) {
            // Fundido cruzado de entrada (Música de fondo -> En Vivo)
            const elapsed = Date.now() - liveTransitionStartTime;
            const progress = Math.min(1.0, elapsed / (config.crossfadeSeconds * 1000));

            const currentMusicDeck = activeDeck === "A" ? deckA : deckB;
            const mixed = mixWithBuffer(value, progress, currentMusicDeck.buffer, 1.0 - progress);
            writeToMaster(mixed);

            if (progress >= 1.0) {
              isLiveTransitionActive = false;
              stopFallback(); // Apagar procesos físicos de fallback de fondo
            }
          } else {
            // Emisión directa
            writeToMaster(value);
          }
        }
      }
    } catch (err) {
      rtmpLog.error("Error en proceso FFmpeg RTMP:", (err as Error).message);
    } finally {
      rtmpLog.info("Fuente RTMP desconectada. Limpiando...");
      if (silentWatchdog) clearInterval(silentWatchdog);
      state.isBroadcasting = false;
      state.sourceConnected = false;
      state.detectedBitrateKbps = null;
      state.detectedSampleRate = null;
      bitrateDetector.reset();

      if (state.sourceProcess) {
        try {
          state.sourceProcess.kill();
        } catch {
          /* noop */
        }
        state.sourceProcess = null;
      }

      broadcastSse("state-updated", { broadcasting: false, sourceConnected: false });

      // Detección de flaps
      const now = Date.now();
      disconnectTimestamps = disconnectTimestamps.filter((t) => now - t < flapWindowMs);
      disconnectTimestamps.push(now);
      if (disconnectTimestamps.length > flapMaxCount) {
        rtmpCooldownUntil = now + flapCooldownMs;
        rtmpLog.warn(`[RTMP] Demasiadas desconexiones rápidas (${disconnectTimestamps.length} en ${flapWindowMs / 1000}s). Entrando en enfriamiento ${flapCooldownMs / 1000}s.`);
        disconnectTimestamps = [];
      }

      if (!state.shuttingDown) {
        stopFallback();
        // Iniciar rampa de volumen de subida para el fallback
        isFallbackFadeInActive = config.crossfadeSeconds > 0;
        fallbackFadeInStartTime = Date.now();
        startFallback();
      }
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
}
