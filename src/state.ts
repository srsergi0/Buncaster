import { type IcyClientState } from "./icy-metadata";

export interface RadioClient {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  connectedAt: Date;
  ip: string;
  userAgent: string;
  bytesSent: number;
  slowStrikes: number;
  icy?: IcyClientState;
}

export interface ActiveTrackInfo {
  file: string;
  title: string;
  artist: string;
  duration: number; // en segundos
  startedAt: number; // timestamp ms
}

export const state = {
  clients: new Map<string, RadioClient>(),
  isBroadcasting: false,
  sourceConnected: false,
  sourceProcess: null as any | null,
  masterProcess: null as any | null,
  shuttingDown: false,
  startTime: new Date(),
  totalListenersServed: 0,
  totalBytesReceived: 0,
  totalBytesSent: 0,
  detectedBitrateKbps: null as number | null,
  detectedSampleRate: null as number | null,

  // --- Propiedades para el Panel DJ Moderno ---
  fallbackQueue: [] as string[],
  currentTrack: null as ActiveTrackInfo | null,
  fallbackPaused: false,
  sseClients: new Set<ReadableStreamDefaultController<string>>(),
};
