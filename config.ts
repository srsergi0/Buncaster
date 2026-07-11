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
}

function envInt(name: string): number {
  const raw = process.env[name];
  if (!raw) {
    throw new Error(`Falta la variable de entorno obligatoria: ${name}`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Variable de entorno ${name} inválida: "${raw}" (se esperaba un entero no negativo)`);
  }
  return n;
}

function envStr(name: string): string {
  const val = process.env[name];
  if (val === undefined) {
    throw new Error(`Falta la variable de entorno obligatoria: ${name}`);
  }
  return val;
}

function envBool(name: string): boolean {
  const val = process.env[name];
  if (val === undefined) {
    throw new Error(`Falta la variable de entorno obligatoria: ${name}`);
  }
  if (val !== "true" && val !== "false") {
    throw new Error(`Variable de entorno ${name} inválida: "${val}" (se esperaba "true" o "false")`);
  }
  return val === "true";
}

function loadConfig(): Config {
  const cfg: Config = {
    httpPort: envInt("PORT"),
    rtmpPort: envInt("RTMP_PORT"),
    maxListeners: envInt("MAX_LISTENERS"),
    preBufferBytes: envInt("PREBUFFER_BYTES"),
    corsOrigin: envStr("CORS_ORIGIN"),
    adminUser: process.env.ADMIN_USER || undefined,
    adminPassword: process.env.ADMIN_PASSWORD || undefined,
    logLevel: (process.env.LOG_LEVEL as LogLevel) || "info",
    fallbackBitrateKbps: envInt("STREAM_BITRATE_KBPS"),
    fallbackSource: process.env.FALLBACK_SOURCE || undefined,
    audioProcessing: envBool("AUDIO_PROCESSING"),
    crossfadeSeconds: envInt("CROSSFADE_SECONDS"),
    rtmpStreamKey: process.env.RTMP_STREAM_KEY || "stream",
  };

  if (cfg.httpPort === cfg.rtmpPort) {
    throw new Error("PORT y RTMP_PORT no pueden ser el mismo puerto");
  }
  return cfg;
}

export const config = loadConfig();
