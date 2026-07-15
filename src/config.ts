import fs from "fs";
import path from "path";
import crypto from "crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  httpPort: number;
  rtmpPort: number;
  maxListeners: number;
  preBufferBytes: number;
  corsOrigin: string;
  adminUser?: string;
  adminPassword?: string;
  logLevel: LogLevel;
  fallbackBitrateKbps: number;
  fallbackSource?: string;
  audioProcessing: boolean;
  crossfadeSeconds: number;
  rtmpStreamKey: string;
  rtmpMinLiveSeconds: number;
  useNativeLame: "auto" | "true" | "false";
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Variable de entorno ${name} inválida: "${raw}" (se esperaba un entero no negativo)`);
  }
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const val = process.env[name];
  if (!val) return fallback;
  if (val !== "true" && val !== "false") {
    throw new Error(`Variable de entorno ${name} inválida: "${val}" (se esperaba "true" o "false")`);
  }
  return val === "true";
}

function findFreePort(start: number, exclude: number[]): number {
  let port = start;
  while (exclude.includes(port)) port++;
  return port;
}

function generateStreamKey(): string {
  return crypto.randomBytes(16).toString("hex");
}

function autoDetectMusicFolder(): string | undefined {
  const candidates = ["musica", "music", "audio", "songs", "fallback"];
  for (const name of candidates) {
    const dir = path.resolve(process.cwd(), name);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      const files = fs.readdirSync(dir).filter((f) => /\.(mp3|flac|wav|m4a|aac|ogg)$/i.test(f));
      if (files.length > 0) return dir;
    }
  }
  return undefined;
}

function loadConfig(): Config {
  const rtmpKey = process.env.RTMP_STREAM_KEY || generateStreamKey();
  const httpPort = envInt("PORT", 808);
  const rtmpPort = envInt("RTMP_PORT", findFreePort(1935, [httpPort]));

  if (httpPort === rtmpPort) {
    throw new Error("PORT y RTMP_PORT no pueden ser el mismo puerto");
  }

  const cfg: Config = {
    httpPort,
    rtmpPort,
    maxListeners: envInt("MAX_LISTENERS", 500),
    preBufferBytes: envInt("PREBUFFER_BYTES", 65536),
    corsOrigin: process.env.CORS_ORIGIN || "*",
    adminUser: process.env.ADMIN_USER || undefined,
    adminPassword: process.env.ADMIN_PASSWORD || undefined,
    logLevel: (process.env.LOG_LEVEL as LogLevel) || "info",
    fallbackBitrateKbps: envInt("STREAM_BITRATE_KBPS", 320),
    fallbackSource: process.env.FALLBACK_SOURCE || autoDetectMusicFolder(),
    audioProcessing: envBool("AUDIO_PROCESSING", true),
    crossfadeSeconds: envInt("CROSSFADE_SECONDS", 2),
    rtmpStreamKey: rtmpKey,
    rtmpMinLiveSeconds: envInt("RTMP_MIN_LIVE_SECONDS", 10),
    useNativeLame: (() => {
      const v = process.env.USE_NATIVE_LAME;
      if (v === "true" || v === "false") return v;
      return "auto";
    })(),
  };

  return cfg;
}

export const config = loadConfig();
