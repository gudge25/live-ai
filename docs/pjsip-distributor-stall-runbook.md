# Runbook: PJSIP distributor stall (registrations/calls silently stop)

## Symptom

Phones/softphones can't register or call. SIP packets visibly arrive at the
PBX's NIC (`tcpdump`) and aren't blocked by any firewall/fail2ban rule, but
Asterisk never logs them (no entry in `/var/log/asterisk/full`, no
`unidentified request`, nothing). `asterisk -rx "core show taskprocessors"`
shows one or more `pjsip/distributor-*` rows with `In Queue` far above their
historical `Max Depth` (e.g. `78` against a max depth of `2`) — these are the
threads that pick up new incoming SIP requests, and a backed-up queue there
means Asterisk itself is wedged internally, not that anything is being
blocked externally.

Restarting Asterisk (`fwconsole restart` or `core restart now`) clears it
immediately. The problem is that nothing *notices* this on its own, so it can
sit broken for hours.

## First occurrence (2026-10-05)

- Extension 222 couldn't register over TCP or UDP on `pbx.gixo.co.uk:5057`.
- Ruled out: fail2ban/firewall (IP wasn't banned or blocked), NAT/rp_filter,
  TCP ECN handshake quirk (a red herring from an earlier, unrelated TCP
  capture), conntrack table exhaustion (365/262144, nowhere near full).
- Confirmed via `ss -ulnp`: Asterisk's UDP 5057 socket had ~430KB sitting
  unread in its kernel receive queue (`Recv-Q`), static across repeated
  checks — not slowly draining, genuinely stuck.
- Confirmed via `core show taskprocessors`: `pjsip/distributor-0000003e` had
  78 items queued (normal max depth 2).
- Correlated with the `live-ai` docker-compose stack (in this repo) having
  been introduced around the same time the problem started recurring.
- Fix each time: `fwconsole restart` (or `core restart now`).

A code review of this repo's ARI client (`apps/server/src/ari/events.ts`) and
ARI REST client (`apps/server/src/ari/rest.ts`) found no obvious infinite
loop, retry storm, or blocking handler — the reconnect backoff is sane and
listeners don't accumulate across reconnects. The live-ai Node process never
touches Asterisk's SIP stack directly; it only talks to Asterisk over ARI
(HTTP + WebSocket). The leading hypothesis is that an ARI/Stasis operation
(channel/bridge creation or teardown, done on every call for the snoop +
AudioSocket tap, and swept again by `cleanupOrphans()`) occasionally stalls
*inside Asterisk* while holding a lock shared with the PJSIP distributor
threads — but this has not been confirmed with a live thread backtrace. The
two gaps below (no real healthcheck, no watchdog) are why nobody caught it
in the act.

## What to do next time, in order

1. **Before restarting anything**, run `scripts/pjsip-stall-watch.sh` once by
   hand (or let the cron job have already captured it — see below) to get a
   full thread backtrace of the live Asterisk process. This is the one
   artifact that can actually identify the stuck C function; everything else
   in this incident was circumstantial.
2. Check the output under `/var/log/live-ai-asterisk-stall/stall-<ts>/`:
   - `gdb-backtrace.txt` — every Asterisk thread's stack. Look for threads
     blocked in anything touching `ast_channel`, `ast_bridge`, sorcery, or
     `res_ari`/`res_stasis` — that's the smoking gun this incident never had.
   - `taskprocessors.txt`, `channels.txt`, `pjsip-contacts.txt` — state at
     the moment of capture.
3. Only then restart Asterisk (`fwconsole restart`, or `core restart
   gracefully` if you want in-progress calls to finish first).
4. If a thread is clearly stuck in ARI/Stasis-related code, attach the
   backtrace to a repo issue here — that turns "the live-ai integration is
   the prime suspect" into an actual fix.

## Standing mitigations (installed by this repo)

- `apps/server/src/hub/ui-server.ts`'s `/healthz` now returns `503` when the
  ARI link isn't `connected` (it previously always returned `200`, making the
  Dockerfile's existing `HEALTHCHECK` cosmetic).
- `scripts/autoheal-live-ai.sh` — cron this on the PBX host (not in a
  container) to actually restart the `live-ai` container when Docker marks
  it unhealthy; plain `restart: unless-stopped` in compose does **not** react
  to an unhealthy status, only to the process exiting.
- `scripts/pjsip-stall-watch.sh` — cron this on the PBX host to catch a
  recurrence of the distributor backlog itself and capture a backtrace
  automatically, with a cooldown so it doesn't spam. It only captures
  diagnostics; it never restarts Asterisk on its own — that stays a human
  decision given it's a live, shared PBX.

Suggested crontab on the PBX host (as root):

```cron
* * * * * /opt/live-ai/scripts/autoheal-live-ai.sh
* * * * * /opt/live-ai/scripts/pjsip-stall-watch.sh
```
