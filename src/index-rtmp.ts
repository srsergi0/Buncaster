#!/usr/bin/env bun
// =============================================================
// Radio Server — Ingesta RTMP + Streaming HTTP + Fallback
// -------------------------------------------------------------
// Coordinador principal del servidor.
// =============================================================

import { config } from "./config";
import { sysLog, httpLog } from "./logger";
import { state } from "./state";
import { startFallback, stopFallback, stopMasterEncoder, runRtmpListener } from "./audio-router";
import "./http-server"; // Levanta el servidor HTTP automáticamente al importar

// =============================================================
// 1. INICIALIZACIÓN DE FUENTES
// =============================================================

// Imprimir instrucciones de conexión en la consola
console.log("");
console.log("=== CONFIGURACIÓN DE OBS STUDIO ===");
console.log("1. Abre OBS Studio");
console.log("2. Ve a Settings (Ajustes) > Stream (Emisión)");
console.log("3. Elige Service (Servicio): Custom... (Personalizado)");
console.log(`4. Server (Servidor): rtmp://localhost:${config.rtmpPort}/live`);
console.log(`5. Stream Key (Clave de transmisión): ${config.rtmpStreamKey}`);
console.log("6. ¡Haz clic en 'Start Streaming' (Iniciar Emisión) para comenzar!");
console.log("");

// Arrancar audio de respaldo (fallback) inmediatamente
startFallback();

// Arrancar el receptor de OBS en segundo plano
runRtmpListener();

// =============================================================
// 2. APAGADO ORDENADO
// =============================================================

function shutdown(signal: string): void {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  sysLog.info(`Señal ${signal} recibida, cerrando servidor...`);

  // Detener todos los oyentes de forma limpia
  for (const [, client] of state.clients) {
    try {
      client.controller.close();
    } catch {
      /* noop */
    }
  }
  state.clients.clear();

  // Matar subprocesos de FFmpeg activos
  stopFallback();
  stopMasterEncoder();

  if (state.sourceProcess) {
    sysLog.info("Deteniendo receptor RTMP...");
    try {
      state.sourceProcess.kill();
    } catch {
      /* noop */
    }
  }

  sysLog.info("Servidor cerrado correctamente.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  sysLog.error("Excepción no capturada:", err);
});

process.on("unhandledRejection", (reason) => {
  sysLog.error("Promesa rechazada sin manejar:", reason);
});
