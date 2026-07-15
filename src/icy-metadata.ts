const META_INTERVAL = 65536;

export function buildMetadataBlock(streamTitle: string): Uint8Array {
  const trimmed = streamTitle.slice(0, 400).replace(/'/g, "\\'");
  const encoded = new TextEncoder().encode(`StreamTitle='${trimmed}';StreamUrl='';`);
  const blockSize = Math.ceil((encoded.length + 1) / 16) * 16;
  const buf = new Uint8Array(blockSize + 1);
  buf[0] = blockSize / 16;
  buf.set(encoded, 1);
  return buf;
}

export interface IcyClientState {
  bytesSinceMeta: number;
  metaInterval: number;
}

export function createIcyState(): IcyClientState {
  return {
    bytesSinceMeta: 0,
    metaInterval: META_INTERVAL,
  };
}

export function chunkWithIcy(
  chunk: Uint8Array,
  state: IcyClientState,
  title: string,
): Uint8Array[] {
  if (!title) return [chunk];

  const result: Uint8Array[] = [];
  let offset = 0;

  while (offset < chunk.length) {
    const remaining = chunk.length - offset;
    const space = state.metaInterval - state.bytesSinceMeta;

    if (remaining <= space) {
      const piece = remaining === chunk.length ? chunk : chunk.slice(offset);
      result.push(piece);
      state.bytesSinceMeta += remaining;
      offset = chunk.length;
    } else {
      result.push(chunk.slice(offset, offset + space));
      state.bytesSinceMeta += space;
      offset += space;

      const metaBlock = buildMetadataBlock(title);
      result.push(metaBlock);
      state.bytesSinceMeta = 0;
    }
  }

  return result;
}
