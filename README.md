# Live AI — live call transcription for Asterisk
<img width="380" height="713" alt="image" src="https://github.com/user-attachments/assets/ea23a48b-3a4f-4cf0-a202-6a4244480098" />



Watches configured extensions (e.g. `222`) on an Asterisk PBX over ARI (WSS). When one of them is in a conversation, it taps the call listen-only (snoop + AudioSocket via ARI `externalMedia`), streams each party to AssemblyAI Universal-Streaming, and pushes the live dialog to a Chrome extension (side panel / floating window).

```
Asterisk ──ARI WSS──▶ live-ai server ◀──AudioSocket TCP── Asterisk (2× snoop: agent / caller)
                          │  └──────▶ AssemblyAI realtime (one session per side)
                          └──WS /ui──▶ Chrome extension (side panel · pop-out window)
```

No dialplan changes are required.

## Layout

| Path | What |
|---|---|
| `apps/server` | Node.js 24 / TypeScript service (ARI client, call monitor, AudioSocket server, AssemblyAI, UI WebSocket) |
| `apps/extension` | Chrome MV3 extension (WXT + React + Tailwind) — see its README |
| `packages/shared` | Event contract (zod schemas) shared by server and extension |
| `docs/asterisk-setup.md` | PBX setup, networking, test checklist, troubleshooting |
| `REQUIREMENTS.md` | Server spec, ports, network and running costs |
| `openspec/` | Specs, design and tasks (OpenSpec change `live-call-transcription`) |

## Quick start

With `make` (run `make` alone for the full list):

```bash
make env                                  # .env from .env.example with a generated UI_TOKEN
make up && make logs-pretty               # build + start the service, follow readable logs
make tunnel PBX_SSH=root@<pbx>            # only when running behind NAT (see below)
make ext-build                            # build the extension, then Load unpacked / Reload in Chrome
make check                                # lint + typecheck + tests
```

Or by hand:

```bash
cp .env.example .env              # ARI_*, ASSEMBLYAI_API_KEY, AUDIOSOCKET_ADVERTISE_HOST, UI_TOKEN
docker compose up -d --build
docker compose logs -f live-ai
```

Running behind NAT with a remote PBX: open a reverse SSH tunnel for AudioSocket and set `AUDIOSOCKET_ADVERTISE_HOST=127.0.0.1:9092`:

```bash
ssh -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -R 127.0.0.1:9092:127.0.0.1:9092 <user>@<pbx>
```

Extension: `npx pnpm@10 install && npx pnpm@10 --filter @live-ai/extension build`, then load `apps/extension/.output/chrome-mv3` unpacked in `chrome://extensions`.

## Development

```bash
npx pnpm@10 install
npx pnpm@10 test            # all unit/integration tests
npx pnpm@10 lint
npx pnpm@10 dev:server      # server with .env, auto-reload
npx pnpm@10 dev:mock-events # fake calls on ws://localhost:8765/ui for extension work
```
