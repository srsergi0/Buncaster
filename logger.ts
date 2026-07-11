import { config } from "./config";
import type { LogLevel } from "./config";

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function ts(): string {
  return new Date().toISOString();
}

function makeLogger(scope: string) {
  const enabled = (level: LogLevel) => LOG_LEVELS[level] >= LOG_LEVELS[config.logLevel];
  return {
    debug: (...args: unknown[]) => enabled("debug") && console.debug(`[${ts()}] DEBUG [${scope}]`, ...args),
    info: (...args: unknown[]) => enabled("info") && console.log(`[${ts()}] INFO  [${scope}]`, ...args),
    warn: (...args: unknown[]) => enabled("warn") && console.warn(`[${ts()}] WARN  [${scope}]`, ...args),
    error: (...args: unknown[]) => enabled("error") && console.error(`[${ts()}] ERROR [${scope}]`, ...args),
  };
}

export const rtmpLog = makeLogger("RTMP");
export const httpLog = makeLogger("HTTP");
export const sysLog = makeLogger("SYS");
