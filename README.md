# 🎙️ BunRadio

**Tu radio en un solo binario. Sin Node, sin npm, sin Docker.**

Servidor de radio profesional built con **Bun** y **FFmpeg**. Acepta streaming en vivo desde OBS Studio via RTMP, genera una stream MP3 continua y gapless para oyentes, con sistema de fallback musical y panel de DJ web.

---

## ⚡ Empieza en 3 segundos

### Opción 1: Binario standalone (recomendado)

```bash
# Linux/macOS
chmod +x bunradio-linux-x64
./bunradio-linux-x64

# Windows
.\bunradio-windows-x64.exe
```

**Eso es todo.** No necesitas Node, npm, Docker, ni configurar nada.

### Opción 2: Docker

```bash
docker run -p 808:808 -p 1935:1935 -v ./musica:/app/musica bunradio:latest
```

### Opción 3: Desde código fuente

```bash
bun install
bun run start
```

---

## 🎯 Zero Config

BunRadio funciona **sin configuración**. Ejecuta el binario y:

| Aspecto | Comportamiento automático |
|---------|---------------------------|
| **Puerto HTTP** | 808 (o el siguiente disponible) |
| **Puerto RTMP** | 1935 (o el siguiente disponible) |
| **Stream Key** | Se genera automáticamente (ej: `a1b2c3d4e5f6...`) |
| **Música fallback** | Auto-detecta carpetas `musica/`, `music/`, `audio/`, `songs/` |
| **Procesamiento de audio** | Activado por defecto (limiter + compressor) |
| **Crossfade** | 2 segundos entre canciones |
| **Panel admin** | Sin contraseña (acceso abierto) |

### Configuración opcional

Solo edita lo que quieras cambiar via variables de entorno o archivo `.env`:

```bash
# Ejemplo: cambiar puerto y poner contraseña al admin
PORT=9090
ADMIN_USER=dj
ADMIN_PASSWORD=mipassword
```

Ver `.env.example` para todas las opciones.

---

## 🖥️ Panel de DJ Web

Accede a `http://localhost:808/admin` para controlar tu radio:

- **Now Playing**: Info de la canción actual con barra de progreso
- **Controles**: Saltar canción, pausar/reanudar fallback, re-shuffle
- **Cola de reproducción**: Agregar, eliminar, reordenar canciones
- **Biblioteca**: Explorar y reproducir archivos de música
- **Métricas**: Oyentes conectados, bytes enviados, bitrate detectado

---

## 📡 OBS Studio Configuration

1. Abre **OBS Studio**
2. Ve a **Settings** → **Stream**
3. **Service**: `Custom...`
4. **Server**: `rtmp://localhost:1935/live`
5. **Stream Key**: (la que aparece en la consola al iniciar)
6. Click **"Start Streaming"**

---

## 🔌 API REST

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `GET /stream` | GET | Stream de audio MP3 |
| `GET /health` | GET | Health check con diagnósticos |
| `GET /status` | GET | Estado de la estación (JSON) |
| `GET /metrics` | GET | Métricas Prometheus |
| `GET /admin` | GET | Panel DJ web |
| `GET /admin/api/events` | GET | Server-Sent Events |
| `GET /admin/api/current` | GET | Pista actual |
| `GET /admin/api/files` | GET | Biblioteca de audio |
| `GET /admin/api/queue` | GET | Cola de reproducción |
| `POST /admin/api/queue/push` | POST | Agregar a la cola |
| `POST /admin/api/queue/remove` | POST | Eliminar de la cola |
| `POST /admin/api/queue/clear` | POST | Limpiar cola |
| `POST /admin/api/queue/move` | POST | Reordenar cola |
| `POST /admin/api/skip` | POST | Saltar pista actual |
| `POST /admin/api/playlist/shuffle` | POST | Re-shuffle playlist |
| `POST /admin/api/fallback/toggle` | POST | Pausar/reanudar fallback |

---

## 🏥 Health Check

El endpoint `/health` retorna diagnósticos completos:

```json
{
  "status": "ok",
  "uptime": 120,
  "memory": { "rss": 72, "heapTotal": 2, "heapUsed": 42, "external": 41 },
  "processes": { "masterEncoder": false, "rtmpSource": true },
  "broadcasting": false,
  "fallback": { "active": true, "currentTrack": "I'm on My Way" },
  "listeners": 0
}
```

Docker incluye `HEALTHCHECK` automático cada 30 segundos.

---

## 🔨 Build para todas las plataformas

Compila binarios para Linux, Windows y macOS:

```bash
# Con Docker (cross-compile para todas las plataformas)
bash build.sh

# Solo para tu plataforma
bun run build
```

### Output

| Plataforma | Archivo | Tamaño |
|------------|---------|--------|
| Linux x64 | `bunradio-linux-x64` | ~87 MB |
| Linux ARM64 | `bunradio-linux-arm64` | ~85 MB |
| macOS Intel | `bunradio-macos-x64` | ~66 MB |
| macOS Apple Silicon | `bunradio-macos-arm64` | ~61 MB |
| Windows x64 | `bunradio-windows-x64.exe` | ~94 MB |

---

## 🐳 Docker

### Ejecutar

```bash
docker run -d \
  --name bunradio \
  -p 808:808 \
  -p 1935:1935 \
  -v ./musica:/app/musica \
  --restart unless-stopped \
  bunradio:latest
```

### Docker Compose

```yaml
services:
  bunradio:
    image: bunradio:latest
    container_name: bunradio
    restart: unless-stopped
    ports:
      - "808:808"
      - "1935:1935"
    volumes:
      - ./musica:/app/musica
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

---

## 🤖 MCP Integration (AI Assistants)

BunRadio incluye un servidor MCP para controlar la radio desde Claude Desktop, Cursor, o Windsurf.

### Configuración

```json
{
  "mcpServers": {
    "bunradio": {
      "url": "http://localhost:808/mcp"
    }
  }
}
```

### Herramientas disponibles

- `get_status` - Estado de la radio
- `get_queue` - Cola de reproducción
- `push_to_queue` - Agregar pista
- `skip_track` - Saltar pista
- `shuffle_playlist` - Re-shuffle
- `toggle_fallback` - Pausar/reanudar
- Y más...

---

## 📁 Estructura del proyecto

```
bunradio/
├── src/
│   ├── index-rtmp.ts      # Entry point
│   ├── config.ts           # Configuración (todo opcional)
│   ├── audio-router.ts     # Motor de audio principal
│   ├── broadcaster.ts      # Fan-out a oyentes
│   ├── pre-buffer.ts       # Buffer para conexión instantánea
│   ├── dsp.ts              # Cadena de procesamiento de audio
│   ├── lame-ffi.ts         # Encoder MP3 nativo via FFI
│   ├── http-server.ts      # Servidor HTTP + API
│   ├── http-helpers.ts     # Utilidades + Panel DJ embebido
│   ├── mcp-server.ts       # Servidor MCP para IA
│   └── logger.ts           # Sistema de logging
├── musica/                 # Carpeta de música fallback
├── build.sh               # Script de build multi-plataforma
├── install.sh             # Instalador automático
├── Dockerfile             # Build multi-stage para Docker
└── docker-compose.yml     # Configuración Docker Compose
```

---

## 📜 Licencia

[MIT](LICENSE)
