# Server requirements

What the host running `docker compose` for Live AI needs.

The service is light. Speech recognition runs at AssemblyAI, so this server only relays audio and text between Asterisk, AssemblyAI and the Chrome extension.

Measured on the running container: **~39 MiB RAM and ~0% CPU when idle**. The image is **173 MB** (`node:24-alpine`).

## Hardware

| | Up to ~10 simultaneous calls | Up to ~50 simultaneous calls |
|---|---|---|
| CPU | 1 vCPU | 2 vCPU |
| RAM | 512 MB (the service needs ~50–100 MB; the rest is for the OS and Docker) | 1 GB |
| Disk | 5 GB (OS + Docker + image; logs capped at 3 × 10 MB) | 10 GB |
| Network | ~0.5 Mbit/s per call | ~25 Mbit/s |

The cheapest VPS (1 vCPU / 1 GB, about €4–5/month) is more than enough. The 50-call column is an estimate: only single calls have been observed so far, not a load test.

### Network per call

- **In from Asterisk:** 2 AudioSocket streams (agent + caller) × 16 KB/s ≈ 32 KB/s.
- **Out to AssemblyAI:** the same again, ≈ 32 KB/s.
- **Total:** ≈ 0.5 Mbit/s per call including protocol overhead.

## Latency matters more than CPU

- **Server ↔ PBX.** Best on the same host or in the same data centre. The PBX (`pbx.gixo.co.uk`) is at Hetzner, so a small Hetzner VPS in the same location is ideal. Then the SSH tunnel is not needed: set `AUDIOSOCKET_ADVERTISE_HOST=<VPS private IP>:9092`.
- **Server ↔ AssemblyAI.** Their streaming servers are in the US by default, which adds ~100 ms. That is fine for a live transcript.

## Software

- **OS:** Linux x86_64 or arm64. `node:24-alpine` supports both, so cheap ARM VPSs work too.
- **Docker:** Engine 24+ with the Compose v2 plugin (`docker compose`, not the old `docker-compose`).
- **Optional:** `make`, for the shortcuts in the `Makefile`.

## Network access

| Direction | Port | Purpose | Notes |
|---|---|---|---|
| Server → PBX | TCP 8089 (TLS) | ARI REST + WSS events | `pbx.gixo.co.uk:8089` |
| Server → AssemblyAI | TCP 443 | realtime transcription | `streaming.assemblyai.com` |
| **PBX → server** | TCP 9092 | AudioSocket audio | **allow from the PBX only**: the audio is unencrypted |
| Browser → server | TCP 8765 | WebSocket `/ui` for the extension | see HTTPS below |

### Public server

- **Firewall:** restrict inbound 9092 to the PBX IP.
- **HTTPS for the UI:** put port 8765 behind HTTPS (for example Caddy or nginx) so the extension connects via `wss://…/ui`. Otherwise the access token and the transcripts travel unencrypted.

### Behind NAT (development)

When the server runs on a machine behind NAT and the PBX is remote, open a reverse SSH tunnel so the PBX can reach AudioSocket:

```bash
make tunnel PBX_SSH=root@pbx.gixo.co.uk
```

Then set `AUDIOSOCKET_ADVERTISE_HOST=127.0.0.1:9092`. See `docs/asterisk-setup.md` for details.

## Running costs (AssemblyAI)

Each call uses one streaming session per side. AssemblyAI bills for the time the WebSocket is open.

| Model (`AAI_SPEECH_MODEL`) | Per stream | Per call hour |
|---|---|---|
| `universal-streaming-english` (default) | $0.15/hr | ~$0.30 |
| `universal-3-5-pro` | $0.45/hr | ~$0.90 |

With `AAI_DUAL_CHANNEL=true` both sides share one session, which halves the cost. That mode is still experimental (task 4.4). Prices are as of September 2026.
