/**
 * AudioSocket wire protocol: [kind:1][length:2 BE][payload:length].
 * https://docs.asterisk.org/Configuration/Channel-Drivers/AudioSocket/
 */
export const Kind = {
  Hangup: 0x00,
  Uuid: 0x01,
  Dtmf: 0x03,
  Audio: 0x10,
  Error: 0xff,
} as const;

export interface Frame {
  kind: number;
  payload: Buffer;
}

/** Incremental frame parser; feed arbitrary TCP chunks, get whole frames back. */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: Frame[] = [];
    while (this.buf.length >= 3) {
      const len = this.buf.readUInt16BE(1);
      if (this.buf.length < 3 + len) break;
      frames.push({ kind: this.buf[0]!, payload: this.buf.subarray(3, 3 + len) });
      this.buf = this.buf.subarray(3 + len);
    }
    return frames;
  }
}

export function encodeFrame(kind: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(3);
  header[0] = kind;
  header.writeUInt16BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`invalid uuid: ${uuid}`);
  return Buffer.from(hex, 'hex');
}

export function bytesToUuid(b: Buffer): string {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
