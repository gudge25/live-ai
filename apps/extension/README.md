# Live AI Transcript — Chrome extension

Показує живий діалог розмов моніторованих номерів (напр. 222) у side panel або в окремому плаваючому вікні.

## Збірка

```bash
pnpm install
pnpm --filter @live-ai/extension build     # → apps/extension/.output/chrome-mv3
pnpm --filter @live-ai/extension dev       # dev-режим з HMR (відкриє окремий Chrome)
```

## Встановлення (unpacked)

1. Відкрити `chrome://extensions`, увімкнути **Developer mode**.
2. **Load unpacked** → вибрати `apps/extension/.output/chrome-mv3`.
3. Закріпити іконку розширення; клік по ній відкриває side panel.

## Налаштування

Іконка ⚙ у панелі (або `chrome://extensions` → Details → Extension options):

| Поле | Значення |
|---|---|
| Server URL | `ws://localhost:8765/ui` (або `wss://…/ui` за reverse proxy) |
| Access token | `UI_TOKEN` з `.env` сервера |
| Extensions | номери через кому, напр. `222,223`; порожньо = всі |
| Agent / Caller label | підписи сторін у діалозі та при копіюванні |

Зміни застосовуються одразу — панель перепідключається.

## Використання

- **Pop out ↗** — відкрити діалог в окремому вікні (`chrome.windows.create`, тип `popup`).
- **Copy** — скопіювати фінальні репліки розмови як `[час] Сторона: текст`.
- **Clear** — прибрати завершену розмову з екрана.
- Якщо активних розмов кілька — перемикач зверху.

## Поведінка з'єднання

- Автоперепідключення з backoff 1 → 15 с; індикатор: зелений — connected, жовтий — reconnecting, сірий — disconnected.
- Невірний токен (close code 4401): показується «Unauthorized — check token», повтор кожні 30 с; після зміни налаштувань — одразу.

## Розробка без Asterisk

```bash
UI_TOKEN=dev-token pnpm dev:mock-events   # фейкові розмови на ws://localhost:8765/ui
```
