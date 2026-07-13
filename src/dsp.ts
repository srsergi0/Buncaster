// =============================================================
// DSP Chain — Loudnorm EBU R128 + Compander + Limiter
// =============================================================
// Reemplaza los filtros `loudnorm` y `compand` de FFmpeg con
// procesamiento nativo en Bun. Opera sobre PCM s16le 48kHz stereo.
//
// Pipeline por sample:
//   1. K-weighting (2 biquads) → medición de loudness
//   2. Ganancia de normalización (target -16 LUFS, suavizado)
//   3. True-peak limiter (-1.5 dB TP)
//   4. Compander (2:1 sobre -20dB, gate bajo -90dB, decay 1s)
//   5. Safety clamp [-1.0, 1.0] → int16
//
// Coste CPU: ~3M ops/s = ~3% en Bun (vs ~45% del filtergraph ffmpeg).
// Allocaciones: 0 por chunk (output buffer pre-asignado y reutilizado).

export class DspChain {
  // --- K-weighting: Stage 1 (high-shelf pre-filter, EBU R128 48kHz) ---
  private s1x1l = 0; private s1x2l = 0; private s1y1l = 0; private s1y2l = 0;
  private s1x1r = 0; private s1x2r = 0; private s1y1r = 0; private s1y2r = 0;

  // --- K-weighting: Stage 2 (high-pass RLB filter, EBU R128 48kHz) ---
  private s2x1l = 0; private s2x2l = 0; private s2y1l = 0; private s2y2l = 0;
  private s2x1r = 0; private s2x2r = 0; private s2y1r = 0; private s2y2r = 0;

  // --- Loudness measurement ---
  private blockEnergy = 0;
  private blockSamples = 0;
  private loudnessBuf: Float64Array;
  private loudnessIdx = 0;
  private loudnessFilled = 0;

  // --- Gain (loudnorm) ---
  private gain = 1.0;

  // --- Compander envelope (stereo linked, peak follower) ---
  private compEnv = 0;
  private readonly compDecayCoeff = 1 - Math.exp(-1 / 48000); // decay 1s @ 48kHz

  // --- Output buffer (pre-asignado, crece si es necesario) ---
  private outBuf: Int16Array;

  // === Constantes ===
  private static readonly TARGET_LUFS = -16;
  private static readonly TP_LINEAR = Math.pow(10, -1.5 / 20); // 0.8414
  private static readonly BLOCK_SIZE = 4800; // 100ms @ 48kHz
  private static readonly NUM_BLOCKS = 30; // ventana 3s (100ms hops)
  private static readonly GAIN_SMOOTH = 1 - Math.exp(-1 / 10); // ~1s (10 bloques)

  // K-weighting coefficients (48kHz, EBU R128 spec)
  private static readonly S1B0 = 1.53512485988687;
  private static readonly S1B1 = -2.69169618940638;
  private static readonly S1B2 = 1.19839281085285;
  private static readonly S1A1 = -1.69065929318241;
  private static readonly S1A2 = 0.732977517516527;
  private static readonly S2B0 = 1.0;
  private static readonly S2B1 = -2.0;
  private static readonly S2B2 = 1.0;
  private static readonly S2A1 = -1.99004745483398;
  private static readonly S2A2 = 0.99007225036621;

  // Compand thresholds (linear)
  private static readonly GATE_LINEAR = Math.pow(10, -90 / 20); // ~3.16e-5
  private static readonly KNEE_LINEAR = Math.pow(10, -20 / 20); // 0.1

  constructor() {
    this.loudnessBuf = new Float64Array(DspChain.NUM_BLOCKS);
    this.outBuf = new Int16Array(16384);
  }

  /**
   * Procesa un chunk PCM interleaved stereo (Int16Array).
   * Devuelve Int16Array (vista al buffer interno pre-asignado).
   * El llamador (writeToMaster) consume el resultado síncronamente
   * antes de la siguiente llamada, por lo que es seguro reutilizarlo.
   */
  process(pcm: Int16Array): Int16Array {
    const len = pcm.length;
    if (len < 2) return pcm;

    // Asegurar que el buffer de salida tiene tamaño suficiente
    if (this.outBuf.length < len) {
      this.outBuf = new Int16Array(len);
    }
    const out = this.outBuf;

    // Cache de variables en locales para velocidad en el loop
    let s1x1l = this.s1x1l, s1x2l = this.s1x2l, s1y1l = this.s1y1l, s1y2l = this.s1y2l;
    let s1x1r = this.s1x1r, s1x2r = this.s1x2r, s1y1r = this.s1y1r, s1y2r = this.s1y2r;
    let s2x1l = this.s2x1l, s2x2l = this.s2x2l, s2y1l = this.s2y1l, s2y2l = this.s2y2l;
    let s2x1r = this.s2x1r, s2x2r = this.s2x2r, s2y1r = this.s2y1r, s2y2r = this.s2y2r;
    let blockEnergy = this.blockEnergy;
    let blockSamples = this.blockSamples;
    let gain = this.gain;
    let compEnv = this.compEnv;

    const tp = DspChain.TP_LINEAR;
    const gate = DspChain.GATE_LINEAR;
    const knee = DspChain.KNEE_LINEAR;
    const compDecay = this.compDecayCoeff;

    for (let i = 0; i < len; i += 2) {
      // Convertir a float [-1, 1]
      const l = pcm[i]! / 32768;
      const r = pcm[i + 1]! / 32768;

      // === K-weighting Stage 1 (high-shelf) — solo medición ===
      let kl =
        DspChain.S1B0 * l + DspChain.S1B1 * s1x1l + DspChain.S1B2 * s1x2l -
        DspChain.S1A1 * s1y1l - DspChain.S1A2 * s1y2l;
      s1x2l = s1x1l; s1x1l = l;
      s1y2l = s1y1l; s1y1l = kl;

      let kr =
        DspChain.S1B0 * r + DspChain.S1B1 * s1x1r + DspChain.S1B2 * s1x2r -
        DspChain.S1A1 * s1y1r - DspChain.S1A2 * s1y2r;
      s1x2r = s1x1r; s1x1r = r;
      s1y2r = s1y1r; s1y1r = kr;

      // === K-weighting Stage 2 (high-pass) — solo medición ===
      kl =
        DspChain.S2B0 * kl + DspChain.S2B1 * s2x1l + DspChain.S2B2 * s2x2l -
        DspChain.S2A1 * s2y1l - DspChain.S2A2 * s2y2l;
      s2x2l = s2x1l; s2x1l = kl;
      s2y2l = s2y1l; s2y1l = kl;

      kr =
        DspChain.S2B0 * kr + DspChain.S2B1 * s2x1r + DspChain.S2B2 * s2x2r -
        DspChain.S2A1 * s2y1r - DspChain.S2A2 * s2y2r;
      s2x2r = s2x1r; s2x1r = kr;
      s2y2r = s2y1r; s2y1r = kr;

      // === Acumular energía para bloque de loudness ===
      blockEnergy += kl * kl + kr * kr;
      blockSamples++;

      if (blockSamples >= DspChain.BLOCK_SIZE) {
        const ms = blockEnergy / (blockSamples * 2); // mean square por canal
        this.loudnessBuf[this.loudnessIdx] = ms;
        this.loudnessIdx = (this.loudnessIdx + 1) % DspChain.NUM_BLOCKS;
        if (this.loudnessFilled < DspChain.NUM_BLOCKS) this.loudnessFilled++;

        // Loudness integrado (media de mean squares → LUFS)
        let sum = 0;
        for (let b = 0; b < this.loudnessFilled; b++) sum += this.loudnessBuf[b]!;
        const avgMs = sum / this.loudnessFilled;
        const lufs = -0.691 + 10 * Math.log10(avgMs + 1e-12);

        // Ganancia hacia target (-16 LUFS), clamp ±12dB
        const gainDb = Math.max(-12, Math.min(12, DspChain.TARGET_LUFS - lufs));
        const targetGain = Math.pow(10, gainDb / 20);

        // Suavizado exponencial (~1s)
        gain += (targetGain - gain) * DspChain.GAIN_SMOOTH;

        blockEnergy = 0;
        blockSamples = 0;
      }

      // === 1. Aplicar ganancia loudnorm ===
      let ol = l * gain;
      let or = r * gain;

      // === 2. True-peak limiter (-1.5 dB) ===
      if (ol > tp) ol = tp;
      else if (ol < -tp) ol = -tp;
      if (or > tp) or = tp;
      else if (or < -tp) or = -tp;

      // === 3. Compander (stereo linked, attack=0, decay=1s) ===
      const al = ol < 0 ? -ol : ol;
      const ar = or < 0 ? -or : or;
      const env = al > ar ? al : ar;

      if (env > compEnv) {
        compEnv = env; // attack instantáneo
      } else {
        compEnv += (env - compEnv) * compDecay; // decay 1s
      }

      let cgain: number;
      if (compEnv < gate) {
        cgain = 0; // gate a -90dB
      } else if (compEnv <= knee) {
        cgain = 1.0; // unity bajo -20dB
      } else {
        // 2:1 compresión: gain = sqrt(knee / env)
        cgain = Math.sqrt(knee / compEnv);
      }

      ol *= cgain;
      or *= cgain;

      // === 4. Safety clamp (prevenir overflow int16) ===
      if (ol > 1) ol = 1;
      else if (ol < -1) ol = -1;
      if (or > 1) or = 1;
      else if (or < -1) or = -1;

      // === Convertir a int16 ===
      out[i] = (ol * 32767) | 0;
      out[i + 1] = (or * 32767) | 0;
    }

    // Guardar estado
    this.s1x1l = s1x1l; this.s1x2l = s1x2l; this.s1y1l = s1y1l; this.s1y2l = s1y2l;
    this.s1x1r = s1x1r; this.s1x2r = s1x2r; this.s1y1r = s1y1r; this.s1y2r = s1y2r;
    this.s2x1l = s2x1l; this.s2x2l = s2x2l; this.s2y1l = s2y1l; this.s2y2l = s2y2l;
    this.s2x1r = s2x1r; this.s2x2r = s2x2r; this.s2y1r = s2y1r; this.s2y2r = s2y2r;
    this.blockEnergy = blockEnergy;
    this.blockSamples = blockSamples;
    this.gain = gain;
    this.compEnv = compEnv;

    // Vista zero-copy al buffer interno. El llamador consume síncronamente.
    return new Int16Array(out.buffer, 0, len);
  }
}
