import { z } from 'zod';

/** Which party of the call an audio stream / utterance belongs to. */
export const Side = z.enum(['agent', 'caller']);
export type Side = z.infer<typeof Side>;

export const SessionState = z.enum(['active', 'tap_failed', 'ended']);
export type SessionState = z.infer<typeof SessionState>;

export const Party = z.object({
  name: z.string(),
  number: z.string(),
});
export type Party = z.infer<typeof Party>;

export const SessionInfo = z.object({
  id: z.string().min(1),
  /** Monitored extension, e.g. "222". */
  extension: z.string().min(1),
  channelId: z.string().min(1),
  /** The other party of the call. */
  remote: Party,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().optional(),
  state: SessionState,
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const Utterance = z.object({
  sessionId: z.string().min(1),
  side: Side,
  /** Turn number within the side's stream; a partial is replaced by the final with the same key. */
  turn: z.number().int().nonnegative(),
  text: z.string(),
  ts: z.iso.datetime(),
});
export type Utterance = z.infer<typeof Utterance>;

export const SessionSnapshot = SessionInfo.extend({
  utterances: z.array(Utterance),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;

export const StatusScope = z.enum(['ari', 'transcription', 'tap']);
export type StatusScope = z.infer<typeof StatusScope>;

export const StatusState = z.enum([
  'connected',
  'reconnecting',
  'disconnected',
  'transcription_degraded',
  'tap_failed',
]);
export type StatusState = z.infer<typeof StatusState>;

// ---- server -> client ----

export const SnapshotEvent = z.object({
  type: z.literal('snapshot'),
  sessions: z.array(SessionSnapshot),
  ari: StatusState,
});

export const SessionStartedEvent = z.object({
  type: z.literal('session_started'),
  session: SessionInfo,
});

export const PartialEvent = Utterance.extend({ type: z.literal('partial') });
export const FinalEvent = Utterance.extend({ type: z.literal('final') });

export const SessionEndedEvent = z.object({
  type: z.literal('session_ended'),
  sessionId: z.string().min(1),
  endedAt: z.iso.datetime(),
  state: SessionState,
});

export const StatusEvent = z.object({
  type: z.literal('status'),
  scope: StatusScope,
  state: StatusState,
  sessionId: z.string().optional(),
  side: Side.optional(),
  message: z.string().optional(),
});

export const ServerEvent = z.discriminatedUnion('type', [
  SnapshotEvent,
  SessionStartedEvent,
  PartialEvent,
  FinalEvent,
  SessionEndedEvent,
  StatusEvent,
]);
export type SnapshotEvent = z.infer<typeof SnapshotEvent>;
export type SessionStartedEvent = z.infer<typeof SessionStartedEvent>;
export type PartialEvent = z.infer<typeof PartialEvent>;
export type FinalEvent = z.infer<typeof FinalEvent>;
export type SessionEndedEvent = z.infer<typeof SessionEndedEvent>;
export type StatusEvent = z.infer<typeof StatusEvent>;
export type ServerEvent = z.infer<typeof ServerEvent>;

// ---- client -> server ----

export const SubscribeMessage = z.object({
  type: z.literal('subscribe'),
  /** Extensions to receive events for; empty array means all. */
  extensions: z.array(z.string().min(1)),
});
export const ClientMessage = z.discriminatedUnion('type', [SubscribeMessage]);
export type SubscribeMessage = z.infer<typeof SubscribeMessage>;
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Close code used when the UI token is missing or wrong. */
export const WS_CLOSE_UNAUTHORIZED = 4401;

export function parseServerEvent(raw: unknown): ServerEvent {
  return ServerEvent.parse(raw);
}

export function parseClientMessage(raw: unknown): ClientMessage {
  return ClientMessage.parse(raw);
}

/** Formats a transcript line as `[HH:MM:SS] Side: text` for clipboard export. */
export function formatTranscriptLine(u: Pick<Utterance, 'ts' | 'side' | 'text'>, labels: Record<Side, string>): string {
  const time = new Date(u.ts).toTimeString().slice(0, 8);
  return `[${time}] ${labels[u.side]}: ${u.text}`;
}
