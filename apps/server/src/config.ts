import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const list = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const hostPort = z.string().regex(/^[^:\s]+:\d{1,5}$/, 'expected host:port');

const EnvSchema = z.object({
  // --- Asterisk ARI ---
  ARI_URL: z.url({ protocol: /^https?$/, error: 'ARI_URL must be an http(s) URL, e.g. https://pbx.example.com:8089' }),
  ARI_USER: z.string().min(1, 'ARI_USER is required'),
  ARI_PASSWORD: z.string().min(1, 'ARI_PASSWORD is required'),
  ARI_APP: z.string().regex(/^[A-Za-z0-9_-]+$/).default('live-ai'),
  ARI_CA_CERT: z.string().optional(),
  ARI_TLS_INSECURE: bool.default(false),
  ARI_SUBSCRIBE_ALL: bool.default(false),

  // --- Monitoring ---
  MONITORED_EXTENSIONS: list.pipe(z.array(z.string().regex(/^[\w*#+-]+$/)).min(1, 'MONITORED_EXTENSIONS must list at least one extension')),
  CHANNEL_TECH: z.string().regex(/^[A-Za-z0-9_]+$/).default('PJSIP'),

  // --- AudioSocket ---
  AUDIOSOCKET_BIND: hostPort.default('0.0.0.0:9092'),
  /** host:port that Asterisk uses to reach this service. */
  AUDIOSOCKET_ADVERTISE_HOST: hostPort,

  // --- AssemblyAI ---
  ASSEMBLYAI_API_KEY: z.string().min(1, 'ASSEMBLYAI_API_KEY is required'),
  AAI_SPEECH_MODEL: z.string().default('universal-streaming-english'),
  AAI_LANGUAGE_CODES: list.default(['en']),
  AAI_KEYTERMS: list.default([]),
  AAI_DUAL_CHANNEL: bool.default(false),
  AAI_MAX_CONCURRENT_SESSIONS: z.coerce.number().int().positive().default(20),

  // --- UI ---
  UI_BIND: z.string().default('0.0.0.0'),
  UI_PORT: z.coerce.number().int().min(1).max(65535).default(8765),
  UI_TOKEN: z.string().min(16, 'UI_TOKEN must be at least 16 characters'),
  UI_HISTORY_LIMIT: z.coerce.number().int().nonnegative().default(20),

  // --- Misc ---
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_TRANSCRIPTS: bool.default(false),
});

export type Config = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Env var names whose values must never be printed. */
export const SECRET_KEYS = ['ARI_PASSWORD', 'ASSEMBLYAI_API_KEY', 'UI_TOKEN'] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings as unset so `.env` placeholders fall back to defaults.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) => {
        const key = i.path.join('.');
        return i.code === 'invalid_type' && i.input === undefined ? `${key} is required` : `${key}: ${i.message}`;
      }),
    );
  }
  return result.data;
}

/** Copy of the config safe to log. */
export function redactConfig(cfg: Config): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cfg };
  for (const k of SECRET_KEYS) out[k] = '***';
  return out;
}

export function splitHostPort(hp: string): { host: string; port: number } {
  const idx = hp.lastIndexOf(':');
  return { host: hp.slice(0, idx), port: Number(hp.slice(idx + 1)) };
}
