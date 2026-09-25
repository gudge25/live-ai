# Live AI — common tasks. Run `make` or `make help` for the list.

PNPM        ?= npx -y pnpm@10.34.5
COMPOSE     ?= docker compose
SERVICE     ?= live-ai
UI_PORT     ?= 8765
# Reverse SSH tunnel for AudioSocket when running behind NAT, e.g. make tunnel PBX_SSH=root@pbx.example.com
PBX_SSH     ?=
TUNNEL_PORT ?= 9092
EXT_DIR     := apps/extension/.output/chrome-mv3

.DEFAULT_GOAL := help
.PHONY: help install env build test lint typecheck check \
        up down restart rebuild logs logs-pretty ps health tunnel \
        build-pbx up-pbx \
        dev-server dev-mock ext-build ext-dev ext-zip clean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ---- setup ----

install: ## Install workspace dependencies
	$(PNPM) install

env: ## Create .env from .env.example with a generated UI_TOKEN (never overwrites)
	@if [ -f .env ]; then echo ".env already exists — not touching it"; \
	else sed "s/^UI_TOKEN=$$/UI_TOKEN=$$(openssl rand -hex 24)/" .env.example > .env && echo "created .env — fill in ARI_*, ASSEMBLYAI_API_KEY, AUDIOSOCKET_ADVERTISE_HOST"; fi

# ---- quality ----

build: ## Build server bundle and extension
	$(PNPM) -r build

test: ## Run all tests
	$(PNPM) -r test

lint: ## Lint the whole repo
	$(PNPM) lint

typecheck: ## Typecheck all packages
	$(PNPM) -r typecheck

check: lint typecheck test ## Lint + typecheck + test

# ---- docker ----

up: ## Build and start the service in the background
	$(COMPOSE) up -d --build

down: ## Stop and remove the service
	$(COMPOSE) down

restart: ## Restart the service (keeps the image)
	$(COMPOSE) restart $(SERVICE)

rebuild: ## Rebuild the image without cache and restart
	$(COMPOSE) build --no-cache $(SERVICE) && $(COMPOSE) up -d $(SERVICE)

logs: ## Follow service logs (raw JSON)
	$(COMPOSE) logs -f --tail=100 $(SERVICE)

logs-pretty: ## Follow service logs, human-readable
	$(COMPOSE) logs -f --tail=100 --no-log-prefix $(SERVICE) | $(PNPM) --silent --filter @live-ai/server exec pino-pretty --ignore pid,hostname,svc --translateTime SYS:HH:MM:ss

ps: ## Show container status
	$(COMPOSE) ps

health: ## Query the service health endpoint
	@curl -fsS http://localhost:$(UI_PORT)/healthz && echo

tunnel: ## Reverse SSH tunnel so the PBX can reach AudioSocket (PBX_SSH=user@host)
	@test -n "$(PBX_SSH)" || { echo "usage: make tunnel PBX_SSH=user@pbx.example.com [TUNNEL_PORT=9092]"; exit 1; }
	ssh -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -R 127.0.0.1:$(TUNNEL_PORT):127.0.0.1:9092 $(PBX_SSH)

# ---- co-located with Asterisk (docker-compose-pbx.yml) ----
# Workaround for hosts whose Docker/seccomp predates the syscalls Node 24's
# libuv uses for fs ops (surfaces as EPERM during pnpm install). Neither
# BuildKit nor the classic builder accept --security-opt on `docker build`
# on such hosts, but `docker run --security-opt` does — so build dist that
# way, then package it with a Dockerfile that has no RUN step at all.

build-pbx: ## Build server dist via `docker run` (seccomp workaround), then package the runtime image
	docker run --rm --security-opt seccomp=unconfined -v "$(CURDIR)":/repo -w /repo node:24-alpine \
	  sh -c "corepack enable && pnpm install --frozen-lockfile --filter @live-ai/server... && pnpm --filter @live-ai/server build"
	docker build -t live-ai-server:latest -f apps/server/Dockerfile.pbx .

up-pbx: build-pbx ## Build (build-pbx) and start via docker-compose-pbx.yml
	$(COMPOSE) -f docker-compose-pbx.yml up -d

# ---- development ----

dev-server: ## Run the server locally with .env and auto-reload
	$(PNPM) dev:server

dev-mock: ## Serve fake calls on ws://localhost:8765/ui for extension work
	$(PNPM) dev:mock-events

ext-build: ## Build the Chrome extension (then Load unpacked / Reload in Chrome)
	$(PNPM) --filter @live-ai/extension build
	@echo "→ chrome://extensions → Load unpacked / Reload → $(EXT_DIR)"

ext-dev: ## Run the extension in WXT dev mode (hot reload)
	$(PNPM) --filter @live-ai/extension dev

ext-zip: ## Package the extension as a zip
	$(PNPM) --filter @live-ai/extension zip

clean: ## Remove build output
	rm -rf apps/server/dist apps/extension/.output apps/extension/.wxt
