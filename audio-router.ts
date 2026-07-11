import fs from "fs";
import { config } from "./config";
import { rtmpLog } from "./logger";
import { state } from "./state";
import { broadcast } from "./broadcaster";
import { bitrateDetector } from "./bitrate-detector";

// =============================================================
// 1. CLASE BUFFER FIFO DE AUDIO PCM
// =============================================================
class AudioStreamBuffer {
  private queue: Uint8Array[] = [];
  private totalBytes = 0;

  push(chunk: Uint8Array) {
    this.queue.push(chunk);
    this.totalBytes += chunk.byteLength;
  }

  pull(bytesNeeded: number): Uint8Array {
    const out = new Uint8Array(bytesNeeded);
    if (this.totalBytes === 0) {
      return out; // Retornar silencio
    }

    let bytesWritten = 0;
    while (bytesWritten < bytesNeeded && this.queue.length > 0) {
      const chunk = this.queue[0]!;
      const remaining = bytesNeeded - bytesWritten;

      if (chunk.byteLength <= remaining) {
        out.set(chunk, bytesWritten);
        bytesWritten += chunk.byteLength;
        this.queue.shift();
        this.totalBytes -= chunk.byteLength;
      } else {
        out.set(chunk.subarray(0, remaining), bytesWritten);
        this.queue[0] = chunk.subarray(remaining);
        this.totalBytes -= remaining;
        bytesWritten += remaining;
      }
    }
    return out;
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
  buffer: new AudioStreamBuffer(),
  process: null,
  currentTrackFile: null,
};

export const deckB: Deck = {
  id: "B",
  buffer: new AudioStreamBuffer(),
  process: null,
  currentTrackFile: null,
};

const liveDeck = {
  buffer: new AudioStreamBuffer(),
  process: null as any | null,
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

function shuffle(array: string[]) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = array[i]!;
    array[i] = array[j]!;
    array[j] = temp;
  }
}

// =============================================================
// 3. MEZCLADORES MATEMÁTICOS DE PCM (TypedArrays)
// =============================================================
function mixSamples(chunkA: Uint8Array, volA: number, chunkB: Uint8Array, volB: number): Uint8Array {
  const samplesA = new Int16Array(chunkA.buffer, chunkA.byteOffset, chunkA.byteLength / 2);
  const samplesB = new Int16Array(chunkB.buffer, chunkB.byteOffset, chunkB.byteLength / 2);
  
  const length = Math.max(samplesA.length, samplesB.length);
  const outBuffer = new ArrayBuffer(length * 2);
  const outSamples = new Int16Array(outBuffer);

  for (let i = 0; i < length; i++) {
    const sA = (samplesA[i] ?? 0) * volA;
    const sB = (samplesB[i] ?? 0) * volB;

    let mixed = sA + sB;
    if (mixed > 32767) mixed = 32767;
    if (mixed < -32768) mixed = -32768;
    outSamples[i] = mixed;
  }
  return new Uint8Array(outBuffer);
}

function applyVolume(chunk: Uint8Array, volume: number): Uint8Array {
  if (volume === 1.0) return chunk;
  if (volume === 0.0) return new Uint8Array(chunk.length);

  const buffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
  const samples = new Int16Array(buffer);

  for (let i = 0; i < samples.length; i++) {
    const scaled = Math.round(samples[i]! * volume);
    samples[i] = Math.max(-32768, Math.min(32767, scaled));
  }
  return new Uint8Array(buffer);
}

function writeToMaster(chunk: Uint8Array) {
  if (state.masterProcess?.stdin) {
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
    return {
      title: tags.title || tags.TITLE || "",
      artist: tags.artist || tags.ARTIST || "",
      duration,
    };
  } catch (err) {
    rtmpLog.error("Error leyendo metadatos con ffprobe:", (err as Error).message);
    return { title: "", artist: "", duration: 0 };
  }
}

function initializeFallbackSource() {
  if (!config.fallbackSource) return;

  try {
    const stat = fs.statSync(config.fallbackSource);
    if (stat.isDirectory()) {
      const files = fs.readdirSync(config.fallbackSource);
      const audioFiles = files
        .filter((f) => /\.(mp3|flac|wav|m4a|aac|ogg)$/i.test(f))
        .map((f) => `${config.fallbackSource}/${f}`);

      if (audioFiles.length === 0) {
        rtmpLog.warn(`La carpeta de fallback "${config.fallbackSource}" no contiene archivos de audio válidos.`);
        fallbackPlaylist = [];
        return;
      }

      fallbackPlaylist = audioFiles;
      shuffle(fallbackPlaylist);
      currentPlaylistIndex = 0;
      isPlaylistInitialized = true;
      rtmpLog.info(`Inicializada carpeta de fallback con ${audioFiles.length} canciones mezcladas aleatoriamente.`);
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

export function startMasterEncoder() {
  if (state.masterProcess) return;

  rtmpLog.info(`Iniciando Codificador Maestro a ${config.fallbackBitrateKbps}kbps...`);

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
    "-acodec", "libmp3lame",
    "-ab", `${config.fallbackBitrateKbps}k`,
    "-flush_packets", "1",
    "-f", "mp3",
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
    processInstance.exited.then((exitCode) => {
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
  if (!state.masterProcess) return;
  rtmpLog.info("Deteniendo Codificador Maestro...");
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
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "-"
  ];

  try {
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
    processInstance.exited.then((exitCode) => {
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
          const otherChunk = nextDeck.buffer.pull(value.length);
          const mixed = mixSamples(value, volOut, otherChunk, volIn);

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

    // Si terminó abruptamente sin activar el crossfade (ej. tema corto) y no fue detenido intencionalmente
    if (!state.isBroadcasting && !state.shuttingDown && !wasIntentionallyStopped) {
      if (activeDeck === deck.id && !transitionStarted) {
        activeDeck = activeDeck === "A" ? "B" : "A";
        startFallback();
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

  while (true) {
    if (state.shuttingDown) break;

    rtmpLog.info(`Esperando conexión RTMP de OBS en rtmp://0.0.0.0:${config.rtmpPort}/live/${config.rtmpStreamKey}`);

    const args = [
      "-loglevel", "warning",
      "-fflags", "nobuffer",
      "-listen", "1",
      "-i", `rtmp://0.0.0.0:${config.rtmpPort}/live/${config.rtmpStreamKey}`,
      "-vn",
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "-"
    ];

    try {
      state.sourceProcess = Bun.spawn(["ffmpeg", ...args], {
        stdout: "pipe",
        stderr: "inherit",
      });

      state.sourceConnected = true;
      const reader = state.sourceProcess.stdout.getReader();

      const processInstance = state.sourceProcess;
      processInstance.exited.then((exitCode) => {
        if (state.sourceProcess === processInstance) {
          rtmpLog.info(`[RTMP Listener] El proceso de receptor RTMP terminó (exitCode: ${exitCode}). Cancelando lector.`);
          try {
            reader.cancel();
          } catch {
            /* noop */
          }
        }
      }).catch(() => {});

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (!state.isBroadcasting && value.byteLength > 0) {
          state.isBroadcasting = true;
          liveTransitionStartTime = Date.now();
          isLiveTransitionActive = config.crossfadeSeconds > 0;
          
          rtmpLog.info("¡Conexión RTMP establecida y transmitiendo audio en VIVO!");
          
          state.currentTrack = null;
          broadcastSse("track-changed", null);
          broadcastSse("state-updated", { broadcasting: true, sourceConnected: true });
        }

        if (isLiveTransitionActive) {
          // Fundido cruzado de entrada (Música de fondo -> En Vivo)
          const elapsed = Date.now() - liveTransitionStartTime;
          const progress = Math.min(1.0, elapsed / (config.crossfadeSeconds * 1000));

          const currentMusicDeck = activeDeck === "A" ? deckA : deckB;
          const fallbackChunk = currentMusicDeck.buffer.pull(value.length);

          const mixed = mixSamples(value, progress, fallbackChunk, 1.0 - progress);
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
    } catch (err) {
      rtmpLog.error("Error en proceso FFmpeg RTMP:", (err as Error).message);
    } finally {
      rtmpLog.info("Fuente RTMP desconectada. Limpiando...");
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
