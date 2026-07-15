# Análisis: Soporte de Múltiples Formatos de Audio

## Pipeline actual (solo MP3)

```
RTMP (OBS) → FFmpeg decode → s16le 48kHz stereo → DSP → LAME/FFmpeg encode → MP3 → HTTP
```

## Pipeline con múltiples formatos

```
RTMP (OBS) → FFmpeg decode → s16le 48kHz stereo → DSP → FFmpeg encode → [MP3/OGG/AAC/FLAC/Opus] → HTTP
```

**El punto clave:** El intermediate format (s16le 48kHz stereo) ya es el "bus" del sistema. Solo necesitamos cambiar el encoder de salida.

---

## Touchpoints que cambian

| Archivo | Cambio necesario |
|---------|-----------------|
| `config.ts` | Nuevo campo `streamFormat` |
| `audio-router.ts` | FFmpeg encoder dinámico según formato |
| `http-server.ts` | Content-Type dinámico |
| `bitrate-detector.ts` | Hacer format-agnostic (o ignorar para no-MP3) |

## Archivos que NO cambian

| Archivo | Razón |
|---------|-------|
| `dsp.ts` | Opera en PCM, no le importa el codec de salida |
| `broadcaster.ts` | Solo hace fan-out de bytes |
| `pre-buffer.ts` | Solo buffera bytes |
| `lame-ffi.ts` | Solo se usa para MP3 nativo (se mantiene) |
| `mcp-server.ts` | No tiene relación con audio |

---

## Diseño de configuración

```bash
# .env — Configuración ultra simple
STREAM_FORMAT=mp3      # mp3 | ogg | aac | flac | opus
STREAM_BITRATE_KBPS=320
```

### Formatos soportados

| Formato | MIME Type | FFmpeg codec | Default bitrate | Notas |
|---------|-----------|-------------|-----------------|-------|
| `mp3` | `audio/mpeg` | `libmp3lame` | 320 | Máxima compatibilidad |
| `ogg` | `audio/ogg` | `libvorbis` | 128 | Open source, buena calidad |
| `aac` | `audio/aac` | `aac` | 128 | Mejor calidad que MP3 a mismo bitrate |
| `flac` | `audio/flac` | `flac` | 0 (lossless) | Sin pérdida, archivo grande |
| `opus` | `audio/opus` | `libopus` | 128 | Mejor codec moderno, bajo latency |

### Configuración por defecto por formato

```typescript
const FORMAT_CONFIG = {
  mp3:  { codec: "libmp3lame", mime: "audio/mpeg",       args: ["-ab", `${bitrate}k`], defaultBitrate: 320 },
  ogg:  { codec: "libvorbis",  mime: "audio/ogg",        args: ["-q:a", "6"],           defaultBitrate: 128 },
  aac:  { codec: "aac",        mime: "audio/aac",        args: ["-ab", `${bitrate}k`], defaultBitrate: 128 },
  flac: { codec: "flac",       mime: "audio/flac",       args: [],                      defaultBitrate: 0 },
  opus: { codec: "libopus",    mime: "audio/opus",       args: ["-b:a", `${bitrate}k`], defaultBitrate: 128 },
};
```

---

## Cambios por archivo

### 1. `config.ts`

```typescript
export type StreamFormat = "mp3" | "ogg" | "aac" | "flac" | "opus";

export interface Config {
  // ... existente ...
  streamFormat: StreamFormat;
}

// En loadConfig():
streamFormat: (process.env.STREAM_FORMAT as StreamFormat) || "mp3",
```

### 2. `audio-router.ts` — Encoder dinámico

```typescript
function getFfmpegEncoderArgs(): string[] {
  const fmt = FORMAT_CONFIG[config.streamFormat];
  return [
    "-loglevel", "warning",
    "-fflags", "nobuffer",
    "-f", "s16le", "-ar", "48000", "-ac", "2",
    "-i", "pipe:0",
    ...(config.audioProcessing ? ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11,compand=..."] : []),
    "-acodec", fmt.codec,
    ...fmt.args,
    "-flush_packets", "1",
    "-f", config.streamFormat === "aac" ? "adts" : config.streamFormat,
    "-"
  ];
}
```

**Nota:** Para AAC, el container format es `adts` (no `aac`). Para FLAC es `flac`. Para Opus es `ogg`.

### 3. `http-server.ts` — Content-Type dinámico

```typescript
import { FORMAT_CONFIG } from "./format-config";

// En el handler de /stream:
const streamHeaders = {
  "Content-Type": FORMAT_CONFIG[config.streamFormat].mime,
  // ... resto igual
};
```

### 4. `bitrate-detector.ts` — Hacer format-agnostic

Opción A (simple): Para formatos no-MP3, usar el bitrate configurado sin detectar.
Opción B (completa): Agregar parsers para OGG/Opus headers.

**Decisión: Opción A** — El bitrate detector solo funciona para MP3. Para otros formatos, se usa el bitrate de config directamente.

```typescript
feed(chunk: Uint8Array): void {
  if (this.done) return;
  if (config.streamFormat !== "mp3") {
    // Para formatos no-MP3, usar bitrate de config
    this.done = true;
    this.onDetected({ bitrateKbps: config.fallbackBitrateKbps, sampleRate: 48000 });
    return;
  }
  // ... parser MP3 existente ...
}
```

---

## El ultra fácil: Ejemplos de uso

### Cambiar a OGG (1 línea)
```bash
STREAM_FORMAT=ogg bunradio
```

### Cambiar a AAC (1 línea)
```bash
STREAM_FORMAT=aac bunradio
```

### Cambiar a Opus (1 línea)
```bash
STREAM_FORMAT=opus bunradio
```

### Cambiar a FLAC lossless (1 línea)
```bash
STREAM_FORMAT=flac bunradio
```

### Docker
```bash
docker run -e STREAM_FORMAT=ogg -p 8080:8080 -p 1935:1935 \
  -v ./musica:/app/musica ghcr.io/srsergi0/buncaster:latest
```

---

## Native mode (LAME FFI) — Qué pasa?

El modo nativo con LAME FFI **solo funciona para MP3**. Para otros formatos, se usa FFmpeg automáticamente.

El flujo de decisión:
```
¿streamFormat es "mp3"?
  ├─ SÍ → ¿useNativeLame no es "false"?
  │        ├─ SÍ → ¿libmp3lame disponible?
  │        │        ├─ SÍ → Modo nativo (LAME FFI)
  │        │        └─ NO → FFmpeg con libmp3lame
  │        └─ NO → FFmpeg con libmp3lame
  └─ NO → FFmpeg con codec del formato
```

---

## Complejidad estimada

| Archivo | Líneas a cambiar | Dificultad |
|---------|-----------------|------------|
| `config.ts` | ~5 | Fácil |
| `audio-router.ts` | ~30 | Media |
| `http-server.ts` | ~5 | Fácil |
| `bitrate-detector.ts` | ~10 | Fácil |
| Nuevo: `format-config.ts` | ~30 | Fácil |
| **Total** | **~80 líneas** | **1-2 horas** |

---

## Testing

```bash
# Probar cada formato
for fmt in mp3 ogg aac flac opus; do
  STREAM_FORMAT=$fmt ./bunradio &
  sleep 2
  curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://localhost:8080/stream
  kill %1
done
```

---

## Riesgos

| Riesgo | Mitigación |
|--------|-----------|
| FFmpeg no tiene `libvorbis`/`libopus` | Verificar codecs disponibles al iniciar, fallback a MP3 |
| AAC container format (`adts` vs `aac`) | Mapear correctamente en FORMAT_CONFIG |
| FLAC archivo muy grande | Documentar que es lossless, bitrate=0 |
| Opus compatibility con players viejos | MP3 sigue siendo el default |
| Bitrate detector solo funciona para MP3 | Usar bitrate de config para otros formatos |
