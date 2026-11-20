import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLog } from '../test/log.js';
import { bytesToUuid, encodeFrame, FrameParser, Kind, uuidToBytes } from './protocol.js';
import { AudioSocketServer, type AudioSink } from './server.js';

describe('FrameParser', () => {
  it('parses frames split across arbitrary chunks', () => {
    const audio = Buffer.alloc(320, 7);
    const wire = Buffer.concat([encodeFrame(Kind.Uuid, uuidToBytes(randomUUID())), encodeFrame(Kind.Audio, audio), encodeFrame(Kind.Hangup)]);
    const p = new FrameParser();
    const frames = [];
    for (let i = 0; i < wire.length; i += 7) frames.push(...p.push(wire.subarray(i, i + 7)));
    expect(frames.map((f) => f.kind)).toEqual([Kind.Uuid, Kind.Audio, Kind.Hangup]);
    expect(frames[1]!.payload.equals(audio)).toBe(true);
    expect(frames[2]!.payload.length).toBe(0);
  });

  it('round-trips uuids', () => {
    const u = randomUUID();
    expect(bytesToUuid(uuidToBytes(u))).toBe(u);
  });
});

function recordingSink() {
  const audio: Buffer[] = [];
  let endReason: string | undefined;
  let resolveEnd!: () => void;
  const endedP = new Promise<void>((r) => (resolveEnd = r));
  const sink: AudioSink = {
    onAudio: (b) => audio.push(Buffer.from(b)),
    onEnd: (r) => {
      endReason = r;
      resolveEnd();
    },
  };
  return { sink, audio, ended: endedP, reason: () => endReason };
}

describe('AudioSocketServer', () => {
  let server: AudioSocketServer;
  let port: number;
  beforeEach(async () => {
    server = new AudioSocketServer(silentLog, 200);
    port = await server.listen(0, '127.0.0.1');
  });
  afterEach(() => server.close());

  const client = () =>
    new Promise<Socket>((resolve) => {
      const s = connect(port, '127.0.0.1', () => resolve(s));
    });
  const closed = (s: Socket) => new Promise<void>((r) => s.on('close', () => r()));

  it('routes audio by UUID and reports hangup', async () => {
    const uuid = randomUUID();
    const rec = recordingSink();
    server.register(uuid, rec.sink);
    const s = await client();
    s.write(encodeFrame(Kind.Uuid, uuidToBytes(uuid)));
    s.write(Buffer.concat([encodeFrame(Kind.Audio, Buffer.alloc(320, 1)), encodeFrame(Kind.Audio, Buffer.alloc(320, 2))]));
    s.write(encodeFrame(Kind.Hangup));
    await rec.ended;
    expect(rec.reason()).toBe('hangup');
    expect(Buffer.concat(rec.audio).length).toBe(640);
    expect(rec.audio[1]![0]).toBe(2);
  });

  it('closes connections with an unknown UUID', async () => {
    const s = await client();
    const c = closed(s);
    s.write(encodeFrame(Kind.Uuid, uuidToBytes(randomUUID())));
    await c;
  });

  it('closes connections whose first frame is not a UUID', async () => {
    const s = await client();
    const c = closed(s);
    s.write(encodeFrame(Kind.Audio, Buffer.alloc(320)));
    await c;
  });

  it('closes silent connections after the first-frame timeout', async () => {
    const s = await client();
    await closed(s);
  });

  it('reports closed when the socket drops and when unregistered', async () => {
    const uuid = randomUUID();
    const rec = recordingSink();
    server.register(uuid, rec.sink);
    const s = await client();
    s.write(encodeFrame(Kind.Uuid, uuidToBytes(uuid)));
    await new Promise((r) => setTimeout(r, 20));
    expect(server.isConnected(uuid)).toBe(true);
    server.unregister(uuid);
    await rec.ended;
    expect(rec.reason()).toBe('closed');
    expect(server.isConnected(uuid)).toBe(false);
  });
});

describe('AudioSocketServer keepalive', () => {
  let server: AudioSocketServer;
  afterEach(() => server.close());

  /** Connects (optionally identifying itself) and exposes the frames the server sends back. */
  async function open(keepaliveMs: number, identify: boolean) {
    server = new AudioSocketServer(silentLog, 5000, keepaliveMs);
    const port = await server.listen(0, '127.0.0.1');
    const uuid = randomUUID();
    server.register(uuid, recordingSink().sink);
    const s = await new Promise<Socket>((resolve) => {
      const c = connect(port, '127.0.0.1', () => resolve(c));
    });
    const parser = new FrameParser();
    const frames: { kind: number; payload: Buffer }[] = [];
    s.on('data', (d: Buffer) => frames.push(...parser.push(d)));
    if (identify) s.write(encodeFrame(Kind.Uuid, uuidToBytes(uuid)));
    /** Resolves once `n` frames have arrived; rejects after a generous deadline so a slow runner can't flake it. */
    const waitFor = async (n: number, deadlineMs = 5000) => {
      const end = Date.now() + deadlineMs;
      while (frames.length < n) {
        if (Date.now() > end) throw new Error(`only ${frames.length}/${n} frames after ${deadlineMs} ms`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    return { frames, waitFor, close: () => s.destroy() };
  }

  const expectSilence = (frames: { kind: number; payload: Buffer }[]) => {
    for (const f of frames) {
      expect(f.kind).toBe(Kind.Audio);
      expect(f.payload.length).toBe(320);
      expect(f.payload.every((b) => b === 0)).toBe(true);
    }
  };

  it('keeps sending 20 ms silence frames on an identified stream', async () => {
    const c = await open(20, true);
    await c.waitFor(3);
    expectSilence(c.frames);
    c.close();
  });

  it('sends the first frame as soon as the stream identifies, not on the next timer tick', async () => {
    const c = await open(60_000, true); // the interval never ticks within this test
    await c.waitFor(1, 2000);
    expect(c.frames).toHaveLength(1);
    expectSilence(c.frames);
    c.close();
  });

  it('sends nothing before the stream has identified itself', async () => {
    const c = await open(20, false);
    await new Promise((r) => setTimeout(r, 150));
    expect(c.frames).toEqual([]);
    c.close();
  });

  it('sends nothing when disabled', async () => {
    const c = await open(0, true);
    await new Promise((r) => setTimeout(r, 150));
    expect(c.frames).toEqual([]);
    c.close();
  });
});
