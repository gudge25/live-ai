import { createServer, type Server, type Socket } from 'node:net';
import type { Logger } from '../logger.js';
import { bytesToUuid, FrameParser, Kind } from './protocol.js';

/** Receives audio for one registered AudioSocket UUID. */
export interface AudioSink {
  onAudio(pcm: Buffer): void;
  /** Stream ended: Asterisk hung up, sent an error, or the socket closed. */
  onEnd(reason: 'hangup' | 'error' | 'closed'): void;
}

/** TCP AudioSocket server that routes connections by the UUID in their first frame. */
export class AudioSocketServer {
  private readonly server: Server;
  private readonly sinks = new Map<string, AudioSink>();
  private readonly sockets = new Map<string, Socket>();

  constructor(
    private readonly log: Logger,
    private readonly firstFrameTimeoutMs = 5000,
  ) {
    this.server = createServer((s) => this.onConnection(s));
  }

  /** Register a UUID before asking Asterisk to connect with it. */
  register(uuid: string, sink: AudioSink): void {
    this.sinks.set(uuid.toLowerCase(), sink);
  }

  /** Forget the UUID and close its socket if connected. */
  unregister(uuid: string): void {
    const id = uuid.toLowerCase();
    this.sinks.delete(id);
    this.sockets.get(id)?.destroy();
    this.sockets.delete(id);
  }

  isConnected(uuid: string): boolean {
    return this.sockets.has(uuid.toLowerCase());
  }

  listen(port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        const addr = this.server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });
  }

  close(): Promise<void> {
    for (const s of this.sockets.values()) s.destroy();
    return new Promise((r) => this.server.close(() => r()));
  }

  private onConnection(socket: Socket): void {
    const parser = new FrameParser();
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    let uuid: string | undefined;
    let sink: AudioSink | undefined;
    let ended = false;
    const end = (reason: 'hangup' | 'error' | 'closed') => {
      if (ended || !sink) return;
      ended = true;
      sink.onEnd(reason);
    };

    socket.setNoDelay(true);
    const timer = setTimeout(() => {
      this.log.warn({ remote }, 'AudioSocket: no UUID frame received, closing');
      socket.destroy();
    }, this.firstFrameTimeoutMs);

    socket.on('data', (chunk: Buffer) => {
      for (const f of parser.push(chunk)) {
        if (!sink) {
          clearTimeout(timer);
          if (f.kind !== Kind.Uuid || f.payload.length !== 16) {
            this.log.warn({ remote, kind: f.kind }, 'AudioSocket: first frame is not a UUID, closing');
            socket.destroy();
            return;
          }
          uuid = bytesToUuid(f.payload);
          sink = this.sinks.get(uuid);
          if (!sink) {
            this.log.warn({ remote, uuid }, 'AudioSocket: unknown UUID, closing');
            socket.destroy();
            return;
          }
          this.sockets.get(uuid)?.destroy();
          this.sockets.set(uuid, socket);
          this.log.info({ remote, uuid }, 'AudioSocket: stream connected');
          continue;
        }
        if (f.kind === Kind.Audio) sink.onAudio(f.payload);
        else if (f.kind === Kind.Hangup) {
          end('hangup');
          socket.end();
          return;
        } else if (f.kind === Kind.Error) {
          this.log.warn({ uuid, code: f.payload[0] }, 'AudioSocket: error frame');
          end('error');
          socket.end();
          return;
        }
      }
    });
    socket.on('error', (err) => this.log.debug({ uuid, err: err.message }, 'AudioSocket: socket error'));
    socket.on('close', () => {
      clearTimeout(timer);
      if (uuid && this.sockets.get(uuid) === socket) this.sockets.delete(uuid);
      end('closed');
    });
  }
}
