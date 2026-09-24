/** Minimal subset of ARI models used by the service. */

export interface AriCallerId {
  name: string;
  number: string;
}

export interface AriChannel {
  id: string;
  name: string;
  state: string;
  caller: AriCallerId;
  connected: AriCallerId;
  creationtime?: string;
}

export interface AriBridge {
  id: string;
  technology?: string;
  bridge_type?: string;
  channels: string[];
}

interface AriEventBase {
  type: string;
  application?: string;
  timestamp?: string;
}

export interface ChannelEvent extends AriEventBase {
  type: 'ChannelStateChange' | 'ChannelDestroyed' | 'StasisStart' | 'StasisEnd' | 'ChannelHangupRequest';
  channel: AriChannel;
}

export interface BridgeChannelEvent extends AriEventBase {
  type: 'ChannelEnteredBridge' | 'ChannelLeftBridge';
  channel: AriChannel;
  bridge: AriBridge;
}

export interface DialEvent extends AriEventBase {
  type: 'Dial';
  peer: AriChannel;
  caller?: AriChannel;
  dialstatus: string;
}

export interface OtherEvent extends AriEventBase {
  type: Exclude<string, ChannelEvent['type'] | BridgeChannelEvent['type'] | 'Dial'>;
}

export type AriEvent = ChannelEvent | BridgeChannelEvent | DialEvent;

export function isChannelEvent(e: { type: string }): e is ChannelEvent {
  return ['ChannelStateChange', 'ChannelDestroyed', 'StasisStart', 'StasisEnd', 'ChannelHangupRequest'].includes(e.type);
}

export function isBridgeChannelEvent(e: { type: string }): e is BridgeChannelEvent {
  return e.type === 'ChannelEnteredBridge' || e.type === 'ChannelLeftBridge';
}

export function isDialEvent(e: { type: string }): e is DialEvent {
  return e.type === 'Dial';
}
