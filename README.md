# 🎙️ BunRadio

**Tu radio en un solo binario. Sin Node, sin npm.**

Servidor de radio profesional built con **Bun** y **FFmpeg**. Acepta streaming en vivo desde OBS Studio via RTMP, genera una stream MP3 continua y gapless para oyentes, con sistema de fallback musical y panel de DJ web.

---

## ⚡ Empieza en 3 segundos

### Opción 1: Instalador automático (recomendado)

```bash
curl -fsSL https://raw.githubusercontent.com/srsergi0/Buncaster/main/install.sh | bash
source ~/.bashrc
bunradio
```

### Opción 2: Docker

```bash
docker run -p 8080:8080 -p 1935:1935 -v ./musica:/app/musica ghcr.io/srsergi0/buncaster:latest
```

### Opción 3: Desde código fuente

```bash
bun install
bun run start
```

### Opción 4: Termux (Android)

Ver [TERMUX.md](TERMUX.md) para instrucciones detalladas.

---

## 🎯 Zero Config

BunRadio funciona **sin configuración**. Ejecuta el binario y:

| Aspecto | Comportamiento automático |
|---------|---------------------------|
| **Puerto HTTP** | 8080 (o el siguiente disponible) |
| **Puerto RTMP** | 1935 (o el siguiente disponible) |
| **Stream Key** | Se genera automáticamente (ej: `a1b2c3d4e5f6...`) |
| **Música fallback** | Directorio donde se ejecuta el binario |
| **Procesamiento de audio** | Activado por defecto (limiter + compressor) |
| **Crossfade** | 2 segundos entre canciones |
| **Panel admin** | Requiere stream key (Bearer) o Basic Auth |

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

Accede a `http://localhost:8080/admin` para controlar tu radio:

- **Now Playing**: Info de la canción actual con barra de progreso
- **Controles**: Saltar canción, pausar/reanudar fallback, re-shuffle
- **Cola de reproducción**: Agregar, eliminar, reordenar canciones
- **Biblioteca**: Explorar y reproducir archivos de música
- **Métricas**: Oyentes conectados, bytes enviados, bitrate detectado

---

## 📡 OBS Studio

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

## 🔒 Seguridad

El **stream key** (que aparece en la consola al iniciar) se usa como token de autenticación para las rutas protegidas. Pásalo como `Bearer` token:

```bash
# Ejemplo: skip con curl
curl -X POST http://localhost:8080/admin/api/skip \
  -H "Authorization: Bearer TU_STREAM_KEY"
```

| Ruta | Método | Protección |
|------|--------|------------|
| `/admin` | GET | Stream key (Bearer) o Basic Auth |
| `/admin/api/*` | POST | Stream key (Bearer) o Basic Auth |
| `/mcp` | POST | Stream key (Bearer) |
| `/stream` | GET | Abierto |
| `/health` | GET | Abierto |
| `/status` | GET | Abierto |
| `/metrics` | GET | Abierto |

---

## 🤖 MCP Integration (AI Assistants)

BunRadio incluye un servidor MCP para controlar la radio desde Claude Desktop, Cursor, o Windsurf.

### Configuración

```json
{
  "mcpServers": {
    "bunradio": {
      "url": "http://localhost:8080/mcp",
      "headers": {
        "Authorization": "Bearer TU_STREAM_KEY"
      }
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

## 📜 Licencia

[MIT](LICENSE)
