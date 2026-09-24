import { LiveAiApp } from './app.js';
import { AriEventStream } from './ari/events.js';
import { AriRest } from './ari/rest.js';
import { AudioSocketServer } from './audiosocket/server.js';
import { ConfigError, loadConfig, redactConfig, splitHostPort } from './config.js';
import { SessionStore } from './hub/session-store.js';
import { UiServer } from './hub/ui-server.js';
import { createLogger } from './logger.js';
import { assemblyAiFactory } from './transcription/assemblyai.js';

/** AudioSocket on Asterisk 18 carries signed linear 8 kHz only. */
const SAMPLE_RATE = 8000;

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }
  const log = createLogger(cfg.LOG_LEVEL);
  log.info({ config: redactConfig(cfg) }, 'starting live-ai');

  const ariOpts = {
    url: cfg.ARI_URL,
    user: cfg.ARI_USER,
    password: cfg.ARI_PASSWORD,
    app: cfg.ARI_APP,
    caCertPath: cfg.ARI_CA_CERT,
    tlsInsecure: cfg.ARI_TLS_INSECURE,
  };
  const api = new AriRest(ariOpts);
  const events = new AriEventStream({ ...ariOpts, subscribeAll: cfg.ARI_SUBSCRIBE_ALL }, log.child({ mod: 'ari' }));
  const audio = new AudioSocketServer(log.child({ mod: 'audiosocket' }));
  const store = new SessionStore(cfg.UI_HISTORY_LIMIT);

  const app = new LiveAiApp({
    api,
    events,
    audio,
    createSdk: assemblyAiFactory({
      apiKey: cfg.ASSEMBLYAI_API_KEY,
      speechModel: cfg.AAI_SPEECH_MODEL,
      languageCodes: cfg.AAI_LANGUAGE_CODES,
      keyterms: cfg.AAI_KEYTERMS,
    }),
    store,
    log,
    extensions: cfg.MONITORED_EXTENSIONS,
    tech: cfg.CHANNEL_TECH,
    advertiseHost: cfg.AUDIOSOCKET_ADVERTISE_HOST,
    sampleRate: SAMPLE_RATE,
    dualChannel: cfg.AAI_DUAL_CHANNEL,
    maxConcurrent: cfg.AAI_MAX_CONCURRENT_SESSIONS,
    logTranscripts: cfg.LOG_TRANSCRIPTS,
  });
  const ui = new UiServer({ token: cfg.UI_TOKEN, store, log: log.child({ mod: 'ui' }), ariStatus: () => app.ariStatus });
  app.attachUi(ui);

  const as = splitHostPort(cfg.AUDIOSOCKET_BIND);
  await audio.listen(as.port, as.host);
  log.info({ bind: cfg.AUDIOSOCKET_BIND, advertise: cfg.AUDIOSOCKET_ADVERTISE_HOST }, 'AudioSocket server listening');
  await ui.listen(cfg.UI_PORT, cfg.UI_BIND);
  log.info({ port: cfg.UI_PORT }, 'UI WebSocket listening on /ui');
  events.start();

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    await app.shutdown();
    events.stop();
    await Promise.allSettled([ui.close(), audio.close()]);
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
