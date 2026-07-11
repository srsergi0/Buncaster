import { config } from "./config";
import { state } from "./state";

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": config.corsOrigin,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS, POST, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Session-Id, MCP-Protocol-Version",
    "Access-Control-Expose-Headers": "MCP-Session-Id, MCP-Protocol-Version",
  };
}

export function checkBasicAuth(req: Request): boolean {
  if (!config.adminUser || !config.adminPassword) return true;
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return false;
  try {
    const [user, pass] = atob(header.slice(6)).split(":");
    return user === config.adminUser && pass === config.adminPassword;
  } catch {
    return false;
  }
}

export function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Admin"' },
  });
}

export function getClientIp(req: Request, server: Bun.Server<undefined>): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return server.requestIP(req)?.address ?? "unknown";
}

export function getAdminHTML(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BunRadio — Cabina DJ</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg-primary: #0a0b0d;
    --bg-secondary: #12141c;
    --accent: #00ff88;
    --accent-hover: #00d470;
    --text-primary: #f3f4f6;
    --text-secondary: #9ca3af;
    --border: #222632;
    --card-bg: rgba(18, 20, 28, 0.6);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Outfit', sans-serif;
    background: radial-gradient(circle at top right, #171b26, var(--bg-primary) 70%);
    color: var(--text-primary);
    min-height: 100vh;
    padding: 2rem 1rem;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }

  .container { max-width: 1000px; margin: 0 auto; width: 100%; }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
    gap: 1rem;
  }

  h1 { font-size: 1.8rem; font-weight: 700; }
  h1 span { color: var(--accent); }

  .badge {
    display: inline-flex; align-items: center; gap: 0.5rem;
    padding: 0.5rem 1rem; border-radius: 999px; font-size: 0.85rem; font-weight: 600;
    background: rgba(34, 38, 50, 0.5); border: 1px solid var(--border);
    transition: all 0.3s;
  }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #6b7280; }
  
  .badge.live { color: #ff4560; border-color: rgba(255, 69, 96, 0.3); background: rgba(255, 69, 96, 0.1); }
  .badge.live .dot { background: #ff4560; animation: pulse 1.2s infinite; }
  .badge.fallback { color: var(--accent); border-color: rgba(0, 255, 136, 0.3); background: rgba(0, 255, 136, 0.1); }
  .badge.fallback .dot { background: var(--accent); }
  .badge.paused { color: #ffb700; border-color: rgba(255, 183, 0, 0.3); background: rgba(255, 183, 0, 0.1); }
  .badge.paused .dot { background: #ffb700; }

  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  .layout { display: grid; grid-template-columns: 1.2fr 0.8fr; gap: 1.5rem; }
  @media (max-width: 800px) { .layout { grid-template-columns: 1fr; } }

  .panel {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 1.5rem;
    backdrop-filter: blur(10px);
    box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
  }

  .now-playing { text-align: center; margin-bottom: 1.5rem; position: relative; }
  .album-art {
    width: 140px; height: 140px;
    background: linear-gradient(135deg, #1f2937, #111827);
    border-radius: 16px; margin: 0 auto 1.2rem;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--border);
    box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    font-size: 3rem; color: var(--text-secondary);
  }
  .now-playing.is-live .album-art {
    background: linear-gradient(135deg, #ff4560, #7a1525);
    color: #fff;
    box-shadow: 0 0 25px rgba(255, 69, 96, 0.3);
  }
  .track-title { font-size: 1.3rem; font-weight: 700; margin-bottom: 0.3rem; }
  .track-artist { font-size: 0.95rem; color: var(--text-secondary); margin-bottom: 1.2rem; }

  /* Barra de Progreso */
  .progress-container { margin: 1rem 0; text-align: right; display: none; }
  .progress-bar-bg {
    width: 100%; height: 6px; background: rgba(255, 255, 255, 0.08);
    border-radius: 99px; overflow: hidden; margin-bottom: 0.4rem;
  }
  .progress-bar-fill {
    width: 0%; height: 100%; background: linear-gradient(90deg, var(--accent), #00d2ff);
    border-radius: 99px; transition: width 0.1s linear;
  }
  .progress-time { font-size: 0.8rem; color: var(--text-secondary); font-family: monospace; }

  .controls-row {
    display: flex; gap: 0.8rem; margin: 1.5rem 0 1rem; flex-wrap: wrap; justify-content: center;
  }
  .btn {
    background: rgba(34, 38, 50, 0.8);
    color: var(--text-primary);
    border: 1px solid var(--border);
    padding: 0.7rem 1.2rem; border-radius: 12px;
    font-weight: 600; cursor: pointer; font-size: 0.9rem;
    display: inline-flex; align-items: center; gap: 0.5rem;
    transition: all 0.2s;
  }
  .btn:hover { background: var(--border); }
  .btn-accent { background: var(--accent); color: var(--bg-primary); border-color: var(--accent); }
  .btn-accent:hover { background: var(--accent-hover); color: var(--bg-primary); }
  .btn-danger { background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.3); color: #ef4444; }
  .btn-danger:hover { background: rgba(239, 68, 68, 0.3); }

  .card-title { font-size: 1.1rem; font-weight: 600; margin-bottom: 1rem; color: #fff; }

  /* Selector de archivos de audio */
  .files-list {
    max-height: 250px; overflow-y: auto;
    border: 1px solid var(--border); border-radius: 10px;
    background: rgba(0,0,0,0.2);
  }
  .file-item {
    display: flex; justify-content: space-between; align-items: center;
    padding: 0.6rem 0.8rem; border-bottom: 1px solid var(--border);
    font-size: 0.85rem; cursor: pointer; transition: background 0.15s;
  }
  .file-item:last-child { border-bottom: none; }
  .file-item:hover { background: rgba(255, 255, 255, 0.05); }
  .file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 80%; }
  .file-action { color: var(--accent); font-weight: 600; font-size: 0.8rem; }

  /* Cola de reproducción */
  .queue-list { display: flex; flex-direction: column; gap: 0.5rem; max-height: 250px; overflow-y: auto; }
  .queue-empty { text-align: center; color: var(--text-secondary); font-size: 0.9rem; padding: 1.5rem 0; }
  .queue-item {
    display: flex; justify-content: space-between; align-items: center;
    padding: 0.6rem 0.8rem; background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--border); border-radius: 10px; font-size: 0.85rem;
  }
  .queue-item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 80%; }
  .queue-item-delete {
    background: none; border: none; color: #ef4444; font-weight: 700; cursor: pointer; padding: 0.2rem;
  }

  .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.8rem; margin-top: 1rem; }
  .stat-mini {
    background: rgba(0,0,0,0.2); border: 1px solid var(--border);
    border-radius: 10px; padding: 0.6rem 0.8rem; text-align: center;
  }
  .stat-mini-label { font-size: 0.7rem; color: var(--text-secondary); text-transform: uppercase; margin-bottom: 0.2rem; }
  .stat-mini-val { font-size: 1.1rem; font-weight: 600; }

  audio { width: 100%; margin-top: 1rem; border-radius: 12px; }

  footer { text-align: center; margin-top: 2rem; color: var(--text-secondary); font-size: 0.8rem; }
</style>
</head>
<body>
  <div class="container">
    <header>
      <h1>BunRadio <span>· Cabina DJ</span></h1>
      <div id="status-badge" class="badge">
        <span class="dot"></span>
        <span id="status-text">Cargando...</span>
      </div>
    </header>

    <div class="layout">
      <!-- Sección Izquierda: Reproductor y Estado -->
      <div class="panel">
        <div id="now-playing-container" class="now-playing">
          <div id="art" class="album-art">📻</div>
          <h2 id="track-title" class="track-title">Sin Emisión</h2>
          <p id="track-artist" class="track-artist">Detenido o cargando...</p>

          <!-- Barra de progreso -->
          <div id="progress" class="progress-container">
            <div class="progress-bar-bg">
              <div id="progress-bar" class="progress-bar-fill"></div>
            </div>
            <span id="progress-time" class="progress-time">00:00 / 00:00</span>
          </div>
        </div>

        <audio id="player" controls src="/stream" preload="none"></audio>

        <div class="controls-row">
          <button id="btn-skip" class="btn btn-accent" onclick="actionSkip()">
            <span>⏭️</span> Saltar Tema
          </button>
          <button id="btn-pause" class="btn" onclick="actionTogglePause()">
            <span id="pause-icon">⏸️</span> <span id="pause-text">Pausar Fallback</span>
          </button>
          <button class="btn" onclick="actionShuffle()">
            <span>🔀</span> Mezclar Todo
          </button>
        </div>

        <div class="stat-grid">
          <div class="stat-mini">
            <div class="stat-mini-label">Oyentes Activos</div>
            <div id="stat-listeners" class="stat-mini-val">0</div>
          </div>
          <div class="stat-mini">
            <div class="stat-mini-label">Servidor HTTP</div>
            <div class="stat-mini-val" style="color: var(--accent);">Activo</div>
          </div>
        </div>
      </div>

      <!-- Sección Derecha: Cola de espera y Archivos -->
      <div style="display: flex; flex-direction: column; gap: 1.5rem;">
        <!-- Cola de reproducción -->
        <div class="panel">
          <div class="card-title" style="display: flex; justify-content: space-between; align-items: center;">
            <span>Cola de Espera (Queue)</span>
            <button class="btn btn-danger" style="padding: 0.3rem 0.6rem; font-size: 0.75rem; border-radius: 6px;" onclick="actionClearQueue()">Limpiar</button>
          </div>
          <!-- Input para URLs o Archivos Personalizados -->
          <div style="display: flex; gap: 0.5rem; margin-bottom: 0.8rem;">
            <input id="input-url" type="text" placeholder="Pegar URL de stream (http://...)" style="flex: 1; background: rgba(0,0,0,0.3); border: 1px solid var(--border); border-radius: 8px; padding: 0.5rem; font-size: 0.85rem; color: #fff;">
            <button class="btn btn-accent" style="padding: 0.5rem 0.8rem; font-size: 0.85rem; border-radius: 8px;" onclick="actionPushUrl()">Encolar URL</button>
          </div>
          <div id="queue-container" class="queue-list">
            <div class="queue-empty">No hay canciones en la cola. Se reproducirá la playlist general.</div>
          </div>
        </div>

        <!-- Encolador rápido de archivos -->
        <div class="panel">
          <div class="card-title">Biblioteca de Música</div>
          <div id="files-container" class="files-list">
            <div class="queue-empty">Escaneando archivos...</div>
          </div>
        </div>
      </div>
    </div>

    <footer>Cabina de control dinámica vía SSE · Metadatos por FFprobe</footer>
  </div>

  <script>
    let trackDuration = 0;
    let trackStartedAt = 0;
    let progressTimer = null;
    let isLive = false;

    // Conectar a Server-Sent Events (SSE)
    const eventSource = new EventSource('/admin/api/events');

    eventSource.addEventListener('state-updated', (e) => {
      const data = JSON.parse(e.data);
      updateState(data);
    });

    eventSource.addEventListener('track-changed', (e) => {
      const track = JSON.parse(e.data);
      updateTrack(track);
    });

    eventSource.addEventListener('queue-updated', (e) => {
      const data = JSON.parse(e.data);
      updateQueue(data.queue);
    });

    // Cargar archivos de música disponibles al arrancar
    async function loadFiles() {
      try {
        const res = await fetch('/admin/api/files');
        const data = await res.json();
        const container = document.getElementById('files-container');
        container.innerHTML = '';

        if (!data.files || data.files.length === 0) {
          container.innerHTML = '<div class="queue-empty">No se encontraron canciones en la ruta configurada</div>';
          return;
        }

        data.files.forEach(filePath => {
          const cleanName = filePath.split('/').pop();
          const item = document.createElement('div');
          item.className = 'file-item';
          item.onclick = () => actionPushQueue(filePath);

          item.innerHTML = \`
            <span class="file-name" title="\${filePath}">\${cleanName}</span>
            <span class="file-action">+ Encolar</span>
          \`;
          container.appendChild(item);
        });
      } catch (err) {
        console.error('Error cargando archivos:', err);
      }
    }

    function updateState(data) {
      const badge = document.getElementById('status-badge');
      const statusText = document.getElementById('status-text');
      const playContainer = document.getElementById('now-playing-container');
      const btnSkip = document.getElementById('btn-skip');

      isLive = data.broadcasting;

      if (data.broadcasting) {
        badge.className = 'badge live';
        statusText.textContent = 'TRANSMISIÓN EN VIVO';
        playContainer.classList.add('is-live');
        btnSkip.disabled = true;
        btnSkip.style.opacity = 0.5;
        document.getElementById('art').textContent = '⚡';
      } else if (data.fallbackPaused) {
        badge.className = 'badge paused';
        statusText.textContent = 'FALLBACK EN PAUSA';
        playContainer.classList.remove('is-live');
        btnSkip.disabled = true;
        btnSkip.style.opacity = 0.5;
        document.getElementById('art').textContent = '🔇';
      } else {
        badge.className = 'badge fallback';
        statusText.textContent = 'MÚSICA DE RESPALDO';
        playContainer.classList.remove('is-live');
        btnSkip.disabled = false;
        btnSkip.style.opacity = 1;
        document.getElementById('art').textContent = '🎵';
      }

      if (data.listeners !== undefined) {
        document.getElementById('stat-listeners').textContent = data.listeners;
      }

      const pauseIcon = document.getElementById('pause-icon');
      const pauseText = document.getElementById('pause-text');
      if (data.fallbackPaused) {
        pauseIcon.textContent = '▶️';
        pauseText.textContent = 'Activar Fallback';
      } else {
        pauseIcon.textContent = '⏸️';
        pauseText.textContent = 'Pausar Fallback';
      }
    }

    function updateTrack(track) {
      const titleEl = document.getElementById('track-title');
      const artistEl = document.getElementById('track-artist');
      const progressContainer = document.getElementById('progress');

      if (isLive) {
        titleEl.textContent = 'Emisión en vivo (OBS)';
        artistEl.textContent = 'Escuchando directo de cabina';
        progressContainer.style.display = 'none';
        clearInterval(progressTimer);
        return;
      }

      if (!track) {
        titleEl.textContent = 'Silencio';
        artistEl.textContent = 'No hay nada reproduciéndose';
        progressContainer.style.display = 'none';
        clearInterval(progressTimer);
        return;
      }

      titleEl.textContent = track.title;
      artistEl.textContent = track.artist;
      
      if (track.duration > 0) {
        progressContainer.style.display = 'block';
        trackDuration = track.duration;
        trackStartedAt = track.startedAt;
        
        clearInterval(progressTimer);
        progressTimer = setInterval(updateProgressBar, 200);
        updateProgressBar();
      } else {
        progressContainer.style.display = 'none';
        clearInterval(progressTimer);
      }
    }

    function updateQueue(queue) {
      const container = document.getElementById('queue-container');
      container.innerHTML = '';

      if (!queue || queue.length === 0) {
        container.innerHTML = '<div class="queue-empty">No hay canciones en la cola. Se reproducirá la playlist general.</div>';
        return;
      }

      queue.forEach((filePath, index) => {
        const cleanName = filePath.split('/').pop();
        const item = document.createElement('div');
        item.className = 'queue-item';

        item.innerHTML = \`
          <span class="queue-item-name" title="\${filePath}">\${index + 1}. \${cleanName}</span>
          <button class="queue-item-delete" onclick="actionRemoveQueue(\${index})">✕</button>
        \`;
        container.appendChild(item);
      });
    }

    function formatTime(s) {
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    }

    function updateProgressBar() {
      const elapsed = (Date.now() - trackStartedAt) / 1000;
      const pct = Math.min(100, (elapsed / trackDuration) * 100);
      
      document.getElementById('progress-bar').style.width = pct + '%';
      document.getElementById('progress-time').textContent = formatTime(elapsed) + ' / ' + formatTime(trackDuration);
    }

    // Acciones API REST
    async function actionPushQueue(file) {
      await fetch('/admin/api/queue/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file })
      });
    }

    async function actionPushUrl() {
      const input = document.getElementById('input-url');
      const url = input.value.trim();
      if (!url) return;
      await actionPushQueue(url);
      input.value = '';
    }

    async function actionRemoveQueue(index) {
      await fetch('/admin/api/queue/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index })
      });
    }

    async function actionClearQueue() {
      await fetch('/admin/api/queue/clear', { method: 'POST' });
    }

    async function actionSkip() {
      await fetch('/admin/api/skip', { method: 'POST' });
    }

    async function actionTogglePause() {
      await fetch('/admin/api/fallback/toggle', { method: 'POST' });
    }

    async function actionShuffle() {
      await fetch('/admin/api/playlist/shuffle', { method: 'POST' });
    }

    loadFiles();
  </script>
</body>
</html>`;
}
