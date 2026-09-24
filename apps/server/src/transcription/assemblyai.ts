import { AssemblyAI, type StreamingSpeechModel } from 'assemblyai';
import type { SdkParams } from './call-transcription.js';
import type { SdkTranscriber } from './streaming-session.js';

export interface AaiOptions {
  apiKey: string;
  speechModel: string;
  languageCodes: string[];
  keyterms: string[];
}

/** Factory that binds the API key and model settings; the key never leaves the server. */
export function assemblyAiFactory(o: AaiOptions): (p: SdkParams) => SdkTranscriber {
  const client = new AssemblyAI({ apiKey: o.apiKey });
  return (p) =>
    client.streaming.transcriber({
      sampleRate: p.sampleRate,
      encoding: 'pcm_s16le',
      speechModel: o.speechModel as StreamingSpeechModel,
      languageCodes: o.languageCodes,
      formatTurns: true,
      includePartialTurns: true,
      ...(o.keyterms.length ? { keytermsPrompt: o.keyterms } : {}),
      ...(p.channels ? { channels: p.channels } : {}),
    }) as unknown as SdkTranscriber;
}
