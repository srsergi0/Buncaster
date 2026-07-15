import fs from "fs";
import { config } from "./config";
import { state } from "./state";
import { preBuffer } from "./pre-buffer";
import { httpLog } from "./logger";
import {
  corsHeaders,
  checkBasicAuth,
  unauthorized,
  getClientIp,
  getAdminHTML,
} from "./http-helpers";
import {
  stopFallback,
  startFallback,
  actionSkipFallback,
  reshufflePlaylist,
  broadcastSse,
  fallbackPlaylist,
  currentPlaylistIndex,
  deckA,
  deckB,
  activeDeck,
  transitionStarted,
  isStoppingFallback,
} from "./audio-router";

import { StreamableHttpTransport, InMemorySessionAdapter } from "mcp-lite";
import { mcpServer } from "./mcp-server";

const mcpSessionAdapter = new InMemorySessionAdapter({ maxEventBufferSize: 100 });
const mcpTransport = new StreamableHttpTransport({
  sessionAdapter: mcpSessionAdapter,
});
const handleMcpRequest = mcpTransport.bind(mcpServer);

function generateClientId(): string {
  return crypto.randomUUID();
}

export const httpServer = Bun.serve({
  hostname: config.host,
  port: config.httpPort,
  idleTimeout: 0,

  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (path.startsWith("/mcp")) {
      const response = await handleMcpRequest(req);
      // Expose CORS headers on response
      const headers = new Headers(response.headers);
      for (const [key, val] of Object.entries(corsHeaders())) {
        headers.set(key, val);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    // ---- Stream de audio ----
    if ((path === "/stream" || path === "/") && (req.method === "GET" || req.method === "HEAD")) {
      if (state.clients.size >= config.maxListeners) {
        return new Response("Servidor al máximo de oyentes", { status: 503, headers: corsHeaders() });
      }

      const streamHeaders: Record<string, string> = {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
        ...corsHeaders(),
      };

      if (req.method === "HEAD") {
        return new Response(null, { headers: streamHeaders });
      }

      const clientId = generateClientId();
      const ip = getClientIp(req, server);
      const userAgent = req.headers.get("user-agent") || "unknown";

      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            for (const chunk of preBuffer.snapshot()) {
              try {
                controller.enqueue(chunk);
              } catch {
                /* noop */
              }
            }

            state.clients.set(clientId, {
              id: clientId,
              controller,
              connectedAt: new Date(),
              ip,
              userAgent,
              bytesSent: 0,
              slowStrikes: 0,
            });
            state.totalListenersServed++;
            httpLog.info(`Oyente conectado: ${clientId} desde ${ip} (${state.clients.size} activos)`);
            broadcastSse("state-updated", { listeners: state.clients.size });
          },
          cancel() {
            state.clients.delete(clientId);
            httpLog.info(`Oyente desconectado: ${clientId} (${state.clients.size} activos)`);
            broadcastSse("state-updated", { listeners: state.clients.size });
          },
        },
        { highWaterMark: 256 * 1024 }
      );

      req.signal.addEventListener("abort", () => {
        state.clients.delete(clientId);
        broadcastSse("state-updated", { listeners: state.clients.size });
      });

      return new Response(stream, { headers: streamHeaders });
    }

    // ---- Salud ----
    if (path === "/health") {
      const uptimeSeconds = Math.floor((Date.now() - state.startTime.getTime()) / 1000);
      const mem = process.memoryUsage();
      const fallbackActive = !state.isBroadcasting && state.currentTrack !== null;
      const masterAlive = state.masterProcess !== null;
      const sourceAlive = state.sourceProcess !== null;

      const health = {
        status: "ok",
        uptime: uptimeSeconds,
        memory: {
          rss: Math.round(mem.rss / 1024 / 1024),
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
          external: Math.round(mem.external / 1024 / 1024),
        },
        processes: {
          masterEncoder: masterAlive,
          rtmpSource: sourceAlive,
        },
        broadcasting: state.isBroadcasting,
        sourceConnected: state.sourceConnected,
        fallback: {
          active: fallbackActive,
          paused: state.fallbackPaused,
          currentTrack: state.currentTrack?.title || null,
        },
        listeners: state.clients.size,
        maxListeners: config.maxListeners,
        totalListenersServed: state.totalListenersServed,
        totalBytesReceived: state.totalBytesReceived,
        totalBytesSent: state.totalBytesSent,
        detectedBitrateKbps: state.detectedBitrateKbps,
        detectedSampleRate: state.detectedSampleRate,
      };

      return Response.json(health, { headers: corsHeaders() });
    }

    // ---- Estado Debug ----
    if (path === "/debug-state") {
      return Response.json({
        activeDeck,
        transitionStarted,
        isStoppingFallback,
        deckA: {
          hasProcess: deckA.process !== null,
          currentTrackFile: deckA.currentTrackFile,
          bufferLength: deckA.buffer.length,
        },
        deckB: {
          hasProcess: deckB.process !== null,
          currentTrackFile: deckB.currentTrackFile,
          bufferLength: deckB.buffer.length,
        },
      }, { headers: corsHeaders() });
    }

    // ---- Estado ----
    if (path === "/status") {
      const uptimeSeconds = Math.floor((Date.now() - state.startTime.getTime()) / 1000);
      return Response.json(
        {
          broadcasting: state.isBroadcasting,
          sourceConnected: state.sourceConnected,
          listeners: state.clients.size,
          maxListeners: config.maxListeners,
          totalListenersServed: state.totalListenersServed,
          totalBytesReceived: state.totalBytesReceived,
          totalBytesSent: state.totalBytesSent,
          uptimeSeconds,
          stationName: "BunRadio",
          detectedBitrateKbps: state.detectedBitrateKbps,
          detectedSampleRate: state.detectedSampleRate,
          fallbackBitrateKbps: config.fallbackBitrateKbps,
          fallbackActive: !state.isBroadcasting && state.currentTrack !== null,
        },
        { headers: corsHeaders() }
      );
    }

    // ---- Métricas Prometheus ----
    if (path === "/metrics") {
      const lines = [
        "# HELP radio_listeners Oyentes conectados actualmente",
        "# TYPE radio_listeners gauge",
        `radio_listeners ${state.clients.size}`,
        "# HELP radio_broadcasting 1 si hay una fuente transmitiendo, 0 si no",
        "# TYPE radio_broadcasting gauge",
        `radio_broadcasting ${state.isBroadcasting ? 1 : 0}`,
        "# HELP radio_bytes_received_total Bytes totales recibidos de la fuente",
        "# TYPE radio_bytes_received_total counter",
        `radio_bytes_received_total ${state.totalBytesReceived}`,
        "# HELP radio_bytes_sent_total Bytes totales enviados a oyentes",
        "# TYPE radio_bytes_sent_total counter",
        `radio_bytes_sent_total ${state.totalBytesSent}`,
        "# HELP radio_fallback_active 1 si el audio de respaldo está sonando, 0 si no",
        "# TYPE radio_fallback_active gauge",
        `radio_fallback_active ${(!state.isBroadcasting && state.currentTrack !== null) ? 1 : 0}`,
      ];
      return new Response(lines.join("\n") + "\n", {
        headers: { "Content-Type": "text/plain; version=0.0.4", ...corsHeaders() },
      });
    }

    // ---- Panel admin ----
    if (path === "/admin") {
      if (!checkBasicAuth(req)) return unauthorized();
      return new Response(getAdminHTML(), {
        headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
      });
    }

    // =============================================================
    // API REST DE CONTROL EN CALIENTE (PROTEGIDO)
    // =============================================================
    if (path.startsWith("/admin/api/")) {
      if (!checkBasicAuth(req)) return unauthorized();

      // ---- SSE Events ----
      if (path === "/admin/api/events" && req.method === "GET") {
        const sseHeaders = {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        };

        const stream = new ReadableStream<string>({
          start(controller) {
            state.sseClients.add(controller);

            // Enviar estados iniciales
            controller.enqueue(`event: state-updated\ndata: ${JSON.stringify({
              broadcasting: state.isBroadcasting,
              sourceConnected: state.sourceConnected,
              listeners: state.clients.size,
              fallbackPaused: state.fallbackPaused
            })}\n\n`);

            if (state.currentTrack) {
              controller.enqueue(`event: track-changed\ndata: ${JSON.stringify(state.currentTrack)}\n\n`);
            }

            controller.enqueue(`event: queue-updated\ndata: ${JSON.stringify({ queue: state.fallbackQueue })}\n\n`);
          },
          cancel(controller) {
            state.sseClients.delete(controller as any);
          }
        });

        // Evento de desconexión del cliente SSE
        req.signal.addEventListener("abort", () => {
          state.sseClients.delete(stream as any);
        });

        return new Response(stream, { headers: { ...sseHeaders, ...corsHeaders() } });
      }

      // ---- Tema actual ----
      if (path === "/admin/api/current" && req.method === "GET") {
        return Response.json({
          broadcasting: state.isBroadcasting,
          currentTrack: state.currentTrack,
        }, { headers: corsHeaders() });
      }

      // ---- Escanear archivos de audio en la carpeta de fallback ----
      if (path === "/admin/api/files" && req.method === "GET") {
        try {
          if (!config.fallbackSource) {
            return Response.json({ files: [] }, { headers: corsHeaders() });
          }
          const stat = fs.statSync(config.fallbackSource);
          let files: string[] = [];
          if (stat.isDirectory()) {
            files = fs.readdirSync(config.fallbackSource)
              .filter((f) => /\.(mp3|flac|wav|m4a|aac|ogg)$/i.test(f))
              .map((f) => `${config.fallbackSource}/${f}`);
          } else {
            files = [config.fallbackSource];
          }
          return Response.json({ files }, { headers: corsHeaders() });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 500, headers: corsHeaders() });
        }
      }

      // ---- Obtener cola ----
      if (path === "/admin/api/queue" && req.method === "GET") {
        return Response.json({ queue: state.fallbackQueue }, { headers: corsHeaders() });
      }

      // ---- Encolar pista (push) ----
      if (path === "/admin/api/queue/push" && req.method === "POST") {
        try {
          const body = (await req.json()) as any;
          if (!body.file || typeof body.file !== "string") {
            return Response.json({ error: "Parámetro 'file' inválido o faltante" }, { status: 400, headers: corsHeaders() });
          }
          state.fallbackQueue.push(body.file);
          broadcastSse("queue-updated", { queue: state.fallbackQueue });
          return Response.json({ success: true, queue: state.fallbackQueue }, { headers: corsHeaders() });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 400, headers: corsHeaders() });
        }
      }

      // ---- Eliminar de la cola por índice (remove) ----
      if (path === "/admin/api/queue/remove" && req.method === "POST") {
        try {
          const body = (await req.json()) as any;
          const index = Number(body.index);
          if (Number.isNaN(index) || index < 0 || index >= state.fallbackQueue.length) {
            return Response.json({ error: "Parámetro 'index' fuera de rango" }, { status: 400, headers: corsHeaders() });
          }
          state.fallbackQueue.splice(index, 1);
          broadcastSse("queue-updated", { queue: state.fallbackQueue });
          return Response.json({ success: true, queue: state.fallbackQueue }, { headers: corsHeaders() });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 400, headers: corsHeaders() });
        }
      }

      // ---- Limpiar la cola (clear) ----
      if (path === "/admin/api/queue/clear" && req.method === "POST") {
        state.fallbackQueue = [];
        broadcastSse("queue-updated", { queue: [] });
        return Response.json({ success: true, queue: [] }, { headers: corsHeaders() });
      }

      // ---- Reordenar cola (move) ----
      if (path === "/admin/api/queue/move" && req.method === "POST") {
        try {
          const body = (await req.json()) as any;
          const from = Number(body.from);
          const to = Number(body.to);
          if (
            Number.isNaN(from) || from < 0 || from >= state.fallbackQueue.length ||
            Number.isNaN(to) || to < 0 || to >= state.fallbackQueue.length
          ) {
            return Response.json({ error: "Valores 'from' o 'to' fuera de rango" }, { status: 400, headers: corsHeaders() });
          }
          const [movedItem] = state.fallbackQueue.splice(from, 1);
          if (movedItem) {
            state.fallbackQueue.splice(to, 0, movedItem);
          }
          broadcastSse("queue-updated", { queue: state.fallbackQueue });
          return Response.json({ success: true, queue: state.fallbackQueue }, { headers: corsHeaders() });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 400, headers: corsHeaders() });
        }
      }

      // ---- Saltar canción (skip) ----
      if (path === "/admin/api/skip" && req.method === "POST") {
        if (!state.isBroadcasting && state.currentTrack) {
          actionSkipFallback();
          return Response.json({ success: true, message: "Saltando canción..." }, { headers: corsHeaders() });
        }
        return Response.json({ error: "El vivo no se puede saltar, detén el stream desde OBS" }, { status: 400, headers: corsHeaders() });
      }

      // ---- Remezclar playlist general (playlist/shuffle) ----
      if (path === "/admin/api/playlist/shuffle" && req.method === "POST") {
        reshufflePlaylist();
        return Response.json({ success: true }, { headers: corsHeaders() });
      }

      // ---- Obtener playlist completa ----
      if (path === "/admin/api/playlist" && req.method === "GET") {
        return Response.json({ playlist: fallbackPlaylist, currentIndex: currentPlaylistIndex }, { headers: corsHeaders() });
      }

      // ---- Pausar/Reanudar fallback (fallback/toggle) ----
      if (path === "/admin/api/fallback/toggle" && req.method === "POST") {
        state.fallbackPaused = !state.fallbackPaused;
        if (state.fallbackPaused) {
          stopFallback();
        } else {
          startFallback();
        }
        broadcastSse("state-updated", { fallbackPaused: state.fallbackPaused });
        return Response.json({ success: true, paused: state.fallbackPaused }, { headers: corsHeaders() });
      }
    }

    return Response.json({ error: "Not Found" }, { status: 404, headers: corsHeaders() });
  },

  error(err) {
    httpLog.error("Error no controlado en el servidor HTTP:", err);
    return new Response("Internal Server Error", { status: 500 });
  },
});
