# Radio Server — RTMP Ingest + HTTP Streaming + DJ Booth

High-performance, professional-grade web radio server built with **Bun** and **FFmpeg**. Allows OBS Studio to broadcast audio directly via the standard RTMP protocol, seamlessly switching with a dynamic fallback music system. All audio is unified through a master encoder that generates a continuous, gapless MP3 stream for listeners.

---

## Key Features

*   ⚡ **High Performance**: Built on Bun for maximum I/O speed and ultra-lightweight HTTP connections with minimal memory usage.
*   📼 **Continuous Master Encoder (Liquidsoap-style)**: The server maintains a single permanent FFmpeg MP3 output encoder process. Sources (live OBS and fallback) inject raw **uncompressed digital PCM (`s16le`, 48000Hz, stereo)** audio. This ensures smooth, gapless transitions: listeners' players never lose connection or require pressing play again when switching sources.
*   🎛️ **Dynamic Sound Processing (FM Radio-style)**: Optional limiter and dynamic compressor in the audio chain (`loudnorm` and `compand` under EBU R128 standard) to normalize volume and add body to the sound. Enable/disable from environment.
*   📂 **Random Fallback Playlist**: Support for music folders (`FALLBACK_SOURCE`). The server dynamically scans the directory, filters supported audio formats, shuffles them using the Fisher-Yates algorithm, and plays them one by one, reshuffling in a loop when the list ends.
*   🔗 **External Streams and URLs Support**: You can enqueue both local audio files and remote stream URLs (`http://`, `https://`, `rtmp://`). The server natively plays external URLs.
*   📡 **Server-Sent Events (SSE)**: Instant bidirectional communication between the server and the web admin panel. Real-time metadata updates, broadcast status, and active listener counts without network polling.
*   🔍 **Metadata via FFprobe**: Background extraction of title, artist, and duration from local fallback files to display an accurate progress bar in the panel. External URLs are safely skipped to avoid network latency.
*   🔒 **Next-Generation DJ Booth**: Dark, sleek, and reactive web interface with interactive control over the playback queue (reorder, remove, clear), quick file library, and stream monitoring.

---

## Prerequisites

Make sure you have the following installed on your system:
1.  **[Bun](https://bun.sh/)** (JS/TS runtime).
2.  **[FFmpeg](https://ffmpeg.org/)** (FFmpeg and FFprobe configured in the OS PATH).

---

## Quick Start

### 1. Install Dependencies
```bash
bun install
```

### 2. Configure Environment
Copy the example template and adjust variables as needed:
```bash
cp .env.example .env
```

Main variables in `.env`:
*   `PORT`: HTTP port for listeners and the web panel.
*   `RTMP_PORT`: RTMP port for OBS to connect to.
*   `STREAM_BITRATE_KBPS`: Final MP3 encoding bitrate (e.g., `320` for maximum quality).
*   `FALLBACK_SOURCE`: Path to an audio file or a folder with music for fallback (e.g., `music`).
*   `AUDIO_PROCESSING`: Enable (`true`) or disable (`false`) the dynamic volume and compression processor.

### 3. Run the Server
*   **Development mode (with auto-reload and watch)**:
    ```bash
    bun run dev
    ```
*   **Production mode**:
    ```bash
    bun run start
    ```

### 4. Running with Docker (Alternative - Recommended for Deployment)
If you prefer running the station inside a container, you can choose between pulling the pre-built image or building it locally.

#### Option A: Pull pre-built image from GHCR (Fastest, no compilation needed)
You don't need any source files on your server. Just create a `docker-compose.yml` file and a `.env` configuration file on your target machine:

```yaml
services:
  bunradio:
    image: ghcr.io/srsergi0/buncaster:latest
    container_name: bunradio
    restart: unless-stopped
    ports:
      - "${PORT:-4321}:${PORT:-4321}"
      - "${RTMP_PORT:-1935}:${RTMP_PORT:-1935}"
    env_file:
      - .env
    volumes:
      - ./${FALLBACK_SOURCE:-musica}:/app/${FALLBACK_SOURCE:-musica}
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

Then start the server with:
```bash
docker compose up -d
```

#### Option B: Build and run locally with Docker Compose
If you have the source files locally and want to build the container from scratch:
1. Make sure you have your `.env` file configured.
2. Run:
   ```bash
   docker compose up -d --build
   ```

To check logs or stop the server:
```bash
# View live logs
docker compose logs -f

# Stop container
docker compose down
```

---

### 5. Running Natively on Windows (Absolute Peak Performance & Low Footprint)
For Windows users wanting the absolute lowest resource usage (~30-50MB RAM and 0% idle CPU compared to ~1.5GB RAM with Docker WSL2), you can run natively:
1. Double-click the **[start-radio.bat](file:///d:/cursos/bunradio/start-radio.bat)** file.
2. The script will automatically verify your environment (checks Bun & FFmpeg), install dependencies if missing, and launch the server.

---

## OBS Studio Configuration

Broadcasting to the server is extremely simple using the standard streaming settings:

1.  Open **OBS Studio**.
2.  Go to **Settings** → **Stream**.
3.  In **Service**, select **Custom...**.
4.  **Server**: `rtmp://localhost:1935/live` *(replace `localhost` with your server's IP if broadcasting from another machine)*.
5.  **Stream Key**: `stream`
6.  *(Optional)* In **Settings** → **Output** → **Audio**, you can set the audio bitrate quality to **320** to maximize transmission fidelity (ideal for 5G/Fiber).
7.  Click **"Start Streaming"**. The server will stop the fallback music immediately and broadcast the OBS signal without gaps.

---

## REST API for Control and Interaction

All admin endpoints require basic authentication (`ADMIN_USER` and `ADMIN_PASSWORD` in `.env`):

| Endpoint | Method | Format / Body | Description |
| :--- | :--- | :--- | :--- |
| `GET /` or `/stream` | `GET` | *None* | **MP3 audio stream** for players (Browser, VLC, Winamp, etc.). |
| `GET /admin` | `GET` | *None* | Interactive **Admin DJ Booth**. |
| `GET /admin/api/events` | `GET` | *Stream (SSE)* | Server-Sent Events channel for live updates. |
| `GET /admin/api/current` | `GET` | *None* | Returns JSON with details of the currently playing track or source. |
| `GET /admin/api/files` | `GET` | *None* | Dynamically scans and returns the audio library in the `FALLBACK_SOURCE` folder. |
| `GET /admin/api/queue` | `GET` | *None* | Lists all items currently in the priority wait queue. |
| `POST /admin/api/queue/push` | `POST` | `{"file": "path/url"}` | Enqueues a local file or remote network URL. |
| `POST /admin/api/queue/remove`| `POST` | `{"index": 0}` | Removes a track from the queue by index. |
| `POST /admin/api/queue/clear` | `POST` | *None* | Completely clears the playback queue. |
| `POST /admin/api/queue/move`  | `POST` | `{"from": 1, "to": 0}`| Reorders an item's position in the queue. |
| `POST /admin/api/skip` | `POST` | *None* | Skips the currently active fallback song. |
| `POST /admin/api/playlist/shuffle`| `POST` | *None* | Shuffles the playlist randomly and jumps to the first track. |
| `POST /admin/api/fallback/toggle` | `POST` | *None* | Enables or disables (pauses) fallback music playback. |
| `GET /status` | `GET` | *None* | Public station status in JSON format. |
| `GET /metrics` | `GET` | *None* | Metrics formatted for **Prometheus** (listeners, bytes, etc.). |
| `GET /health` | `GET` | *None* | Health check. |

---

## Model Context Protocol (MCP) Integration

The server includes an integrated MCP (Model Context Protocol) layer built using the ultra-lightweight `mcp-lite` package. This allows LLM agents and IDE assistants (like Cursor, Windsurf, or Claude Desktop) to directly inspect and control your radio station using structured tools.

### Available Tools
The MCP server registers the following tools:
*   `get_status`: Returns current radio status, broadcasting state, listener count, and current track metadata.
*   `get_queue`: Retrieves the priority wait queue.
*   `push_to_queue` (arguments: `file`): Adds a local audio file or stream URL to the queue.
*   `remove_from_queue` (arguments: `index`): Removes an item from the queue by index.
*   `clear_queue`: Clears all items from the playback queue.
*   `move_in_queue` (arguments: `from`, `to`): Reorders items in the queue.
*   `skip_track`: Skips the current fallback track.
*   `shuffle_playlist`: Shuffles the fallback music directory.
*   `list_files`: Lists all supported audio files in your music directory.
*   `toggle_fallback`: Pauses or resumes the fallback music playback.

### Connection Modes

#### 1. HTTP/SSE Transport (Automatic with `bun run dev`)
When the radio server starts via `bun run dev`, the MCP server is automatically hosted inline at:
```http
http://localhost:4321/mcp
```
To connect Claude Desktop via SSE, add the following to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "bunradio": {
      "url": "http://localhost:4321/mcp"
    }
  }
}
```

#### 2. Stdio Subprocess Transport (Alternative)
You can also launch the MCP server as a standalone stdio process that communicates with the active HTTP server:
```json
{
  "mcpServers": {
    "bunradio": {
      "command": "bun",
      "args": ["run", "src/mcp-server.ts"],
      "env": {
        "BUNRADIO_API_URL": "http://localhost:4321"
      }
    }
  }
}
```

---

## License

This project is licensed under the [MIT](LICENSE) license.

