# 🔬 Análisis de Riesgos — Múltiples Formatos de Audio

Análisis profundo de todos los riesgos al implementar soporte multi-formato.

---

## ✅ Verificado: Codecs disponibles

### Docker (Alpine 3.20 + ffmpeg)
```
✅ libmp3lame    — MP3 encoding
✅ libvorbis     — OGG Vorbis encoding
✅ libopus       — Opus encoding
✅ aac           — AAC encoding
✅ flac          — FLAC encoding
```

### Windows (FFmpeg local)
```
✅ libmp3lame    — MP3 encoding
✅ libvorbis     — OGG Vorbis encoding
✅ libopus       — Opus encoding
✅ aac           — AAC encoding (via MediaFoundation)
✅ flac          — FLAC encoding
```

### Muxers (contenedores)
```
✅ mp3           — MP3 container
✅ ogg           — Ogg container (para Vorbis)
✅ opus          — Ogg Opus (container propio)
✅ adts          — ADTS AAC container
✅ flac          — FLAC container
```

**Resultado:** Todos los codecs y muxers están disponibles. Sin riesgo de codecs faltantes.

---

## 🔴 Riesgos Críticos

### R1: MIME Types incorrectos → Players no reproducen

Cada formato necesita un MIME type específico. Si uno está mal, los players no reconocen el codec.

| Formato | MIME correcto | MIME incorrecto | Consecuencia |
|---------|--------------|-----------------|--------------|
| MP3 | `audio/mpeg` | — | Ya funciona |
| OGG Vorbis | `audio/ogg; codecs=vorbis` | `audio/ogg` | Algunos players no decodifican |
| Opus | `audio/ogg; codecs=opus` | `audio/opus` | Chrome/Edge no reproducen |
| AAC | `audio/aac` | `audio/mp4` | Algunos players rechazan |
| FLAC | `audio/flac` | `audio/x-flac` | Algunos players no reconocen |

**Mitigación:** Crear un `FORMAT_CONFIG` con los MIME types exactos verificados.

**Testing:** Probar con: Chrome, Firefox, VLC, Winamp, Strawberry, radio-browser.info

---

### R2: AAC container format → FFmpeg rechaza `-f aac`

AAC necesita `-f adts` (no `-f aac`). Si se usa `-f aac`, FFmpeg falla silenciosamente o produce output corrupto.

**Verificado:**
```
✅ ffmpeg -f s16le -ar 48000 -ac 2 -i pipe:0 -acodec aac -f adts -  → Funciona
❌ ffmpeg -f s16le -ar 48000 -ac 2 -i pipe:0 -acodec aac -f aac -   → Falla
```

**Mitigación:** En FORMAT_CONFIG, el campo `muxer` mapea `aac → adts`.

---

### R3: Opus container format → `-f opus` (no `-f ogg`)

Opus usa su propio muxer `opus` que es un Ogg container pero con headers específicos.

**Verificado:**
```
✅ ffmpeg -f s16le -ar 48000 -ac 2 -i pipe:0 -acodec libopus -f opus -  → Funciona
⚠️ ffmpeg -f s16le -ar 48000 -ac 2 -i pipe:0 -acodec libopus -f ogg -   → Funciona pero sin Opus header
```

**Mitigación:** Usar `-f opus` siempre para Opus.

---

### R4: OGG Vorbis → `-f ogg` (no `-f vorbis`)

Vorbis usa el muxer `ogg`.

**Verificado:**
```
✅ ffmpeg -f s16le -ar 48000 -ac 2 -i pipe:0 -acodec libvorbis -f ogg -  → Funciona
❌ ffmpeg -f s16le -ar 48000 -ac 2 -i pipe:0 -acodec libvorbis -f vorbis - → Falla
```

**Mitigación:** En FORMAT_CONFIG, `vorbis → ogg`.

---

## 🟡 Riesgos Importantes

### R5: Bitrate config inapropiado por formato

Cada formato tiene rangos de bitrate válidos:

| Formato | Bitrate válido | Default | Riesgo si se usa 320k |
|---------|---------------|---------|----------------------|
| MP3 | 32–320 kbps | 320 | OK |
| OGG Vorbis | usa `-q:a` (0–10) | q=6 (~128k) | `320k` no es válido para `-q:a` |
| Opus | 6–510 kbps | 128 | OK |
| AAC | 32–320 kbps | 128 | OK |
| FLAC | 0–8 (compression) | 5 | Bitrate no aplica |

**Mitigación:** FORMAT_CONFIG debe tener args específicos por formato:
```typescript
mp3:  ["-ab", `${bitrate}k`]
ogg:  ["-q:a", "6"]           // Ignora bitrate, usa quality
opus: ["-b:a", `${bitrate}k`]
aac:  ["-ab", `${bitrate}k`]
flac: ["-compression_level", "5"]  // Bitrate no aplica
```

---

### R6: Native LAME mode incompatible con no-MP3

Si `STREAM_FORMAT=ogg` pero `USE_NATIVE_LAME=true`, el encoder nativo (LAME FFI) produce MP3, no OGG.

**Mitigación:** 
```typescript
function startMasterEncoder() {
  // Solo usar nativo si el formato es MP3
  if (config.streamFormat === "mp3" && config.useNativeLame !== "false" && isNativeLameAvailable()) {
    // ... native path
  } else {
    startFfmpegMasterEncoder();
  }
}
```

---

### R7: BitrateDetector MP3-only

El detector actual parsea headers MP3. Para otros formatos, falla o da datos incorrectos.

**Mitigación:**
```typescript
feed(chunk: Uint8Array): void {
  if (this.done) return;
  
  // Para formatos no-MP3, usar bitrate de config directamente
  if (config.streamFormat !== "mp3") {
    this.done = true;
    this.onDetected({ 
      bitrateKbps: config.fallbackBitrateKbps, 
      sampleRate: 48000 
    });
    return;
  }
  
  // ... parser MP3 existente
}
```

---

### R8: Metadata (título/artista) injection

Insertar metadata en el stream varía por formato:

| Formato | Método | FFmpeg arg |
|---------|--------|-----------|
| MP3 | ID3 frames | `-metadata title="..."` |
| OGG | Vorbis comments | `-metadata title="..."` |
| Opus | Opus tags | `-metadata title="..."` |
| AAC | iTMF | `-metadata title="..."` |
| FLAC | Vorbis comments | `-metadata title="..."` |

**Buenas noticias:** FFmpeg usa `-metadata` para todos los formatos. La interfaz es uniforme.

**Riesgo bajo:** No se está implementando metadata injection en esta fase.

---

## 🟢 Riesgos Bajos

### R9: Pre-buffer con formato nuevo

El pre-buffer almacena bytes codificados. Cuando un listener nuevo conecta, recibe chunks del formato actual. Si el formato cambia en runtime, el pre-buffer tiene chunks del formato viejo.

**Mitigación:** El pre-buffer se limpia automáticamente cuando cambia de source (RTMP → fallback o viceversa). No hay riesgo real.

---

### R10: Crossfade entre formatos diferentes

Si la música de fallback es MP3 y el output es OGG, FFmpeg decodifica a PCM y re-codifica. El crossfade opera en PCM, no en el formato codificado.

**Mitigación:** No hay riesgo. El pipeline siempre pasa por PCM intermedio.

---

### R11: Admin panel (HTML embebido)

El panel DJ usa `<audio src="/stream">`. Los browsers modernos soportan MP3, OGG, y AAC nativamente. FLAC y Opus dependen del browser.

| Browser | MP3 | OGG | AAC | FLAC | Opus |
|---------|-----|-----|-----|------|------|
| Chrome | ✅ | ✅ | ✅ | ✅ | ✅ |
| Firefox | ✅ | ✅ | ✅ | ✅ | ✅ |
| Safari | ✅ | ❌ | ✅ | ✅ | ✅ |
| Edge | ✅ | ✅ | ✅ | ✅ | ✅ |

**Mitigación:** El admin panel es para el DJ, no para oyentes. Si usa Safari, usar MP3 o AAC.

---

### R12: Prometheus metrics

El endpoint `/metrics` no reporta el formato actual. Podría agregarse como label.

**Riesgo:** Cosmético. No afecta funcionalidad.

---

### R13: SSE events

Los eventos SSE no incluyen el formato. Podría agregarse al state.

**Riesgo:** Cosmético. No afecta funcionalidad.

---

## 📊 Matriz de Riesgos

| # | Riesgo | Severidad | Probabilidad | Impacto | Mitigación |
|---|--------|-----------|-------------|---------|------------|
| R1 | MIME types incorrectos | 🔴 Alta | Alta | Players no reproducen | FORMAT_CONFIG con MIMEs verificados |
| R2 | AAC container `-f aac` | 🔴 Alta | Alta | FFmpeg falla | Usar `-f adts` |
| R3 | Opus container `-f ogg` | 🔴 Alta | Media | Output corrupto | Usar `-f opus` |
| R4 | Vorbis container `-f vorbis` | 🔴 Alta | Media | FFmpeg falla | Usar `-f ogg` |
| R5 | Bitrate inapropiado | 🟡 Media | Alta | Calidad mala o FFmpeg error | Args específicos por formato |
| R6 | Native LAME + no-MP3 | 🟡 Media | Alta | Encoder produce MP3 | Check format antes de usar nativo |
| R7 | BitrateDetector MP3-only | 🟡 Media | Alta | Datos incorrectos | Return config bitrate para no-MP3 |
| R8 | Metadata injection | 🟢 Baja | Baja | Sin metadata | No implementar en fase 1 |
| R9 | Pre-buffer stale | 🟢 Baja | Baja | Audio viejo breve | Auto-cleanup |
| R10 | Crossfade format mismatch | 🟢 Baja | Baja | — | PCM intermedio |
| R11 | Admin panel compat | 🟢 Baja | Media | Safari no soporta OGG | Usar MP3/AAC en admin |
| R12 | Metrics sin formato | 🟢 Baja | Baja | — | Agregar después |
| R13 | SSE sin formato | 🟢 Baja | Baja | — | Agregar después |

---

## 🧪 Plan de Testing

### Fase 1: Unit tests (FFmpeg)
```bash
# Para cada formato, verificar que FFmpeg produce output válido
for fmt in mp3 ogg opus adts flac; do
  ffmpeg -f s16le -ar 48000 -ac 2 -i pipe:0 \
    -acodec $CODEC $ARGS -f $FMT -t 5 - 2>&1 | grep -i error
done
```

### Fase 2: Stream test
```bash
# Iniciar con cada formato y verificar /stream responde
for fmt in mp3 ogg opus aac flac; do
  STREAM_FORMAT=$fmt ./bunradio &
  curl -s -o /dev/null -w "HTTP %{http_code} Content-Type: %{content_type}\n" http://localhost:8080/stream
  kill %1
done
```

### Fase 3: Player test
```bash
# Probar cada formato en:
# - Chrome (Windows/Linux)
# - Firefox (Windows/Linux)
# - Safari (macOS)
# - VLC
# - Strawberry
```

### Fase 4: Load test
```bash
# Verificar que el formato no afecta rendimiento
# Medir: RAM, CPU, tiempo de respuesta con 10/50/100 listeners
```

---

## 🛡️ Estrategia de Fallback

Si el formato configurado falla, fallback automático a MP3:

```typescript
function startMasterEncoder() {
  const fmt = config.streamFormat;
  
  // Verificar que FFmpeg tiene el codec
  if (!isCodecAvailable(fmt)) {
    rtmpLog.warn(`Codec para ${fmt} no disponible, fallback a MP3`);
    config.streamFormat = "mp3";
  }
  
  // ... resto del encoder
}

function isCodecAvailable(format: string): boolean {
  const codecs: Record<string, string> = {
    mp3: "libmp3lame", ogg: "libvorbis", opus: "libopus",
    aac: "aac", flac: "flac"
  };
  try {
    const proc = Bun.spawnSync(["ffmpeg", "-encoders"], { stdout: "pipe" });
    const output = new TextDecoder().decode(proc.stdout);
    return output.includes(codecs[format]);
  } catch {
    return false;
  }
}
```

---

## 📋 Checklist de implementación

- [ ] Crear `src/format-config.ts` con FORMAT_CONFIG
- [ ] Agregar `streamFormat` a Config interface
- [ ] Actualizar `startMasterEncoder()` para formato dinámico
- [ ] Actualizar `startFfmpegMasterEncoder()` con args por formato
- [ ] Actualizar Content-Type en http-server.ts
- [ ] Actualizar bitrate-detector.ts para no-MP3
- [ ] Agregar `isCodecAvailable()` check al iniciar
- [ ] Agregar fallback automático a MP3
- [ ] Actualizar .env.example
- [ ] Actualizar README.md
- [ ] Testing por formato
- [ ] Testing por player
