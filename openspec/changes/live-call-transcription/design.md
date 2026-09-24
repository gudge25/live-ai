# Design

## Context

Проєкт порожній (greenfield). Asterisk уже працює, дзвінки на 222 проходять звичайним діалпланом (`Dial(PJSIP/222)`), тобто канали **не** перебувають у Stasis. Через це ARI не може просто «додати свій канал у брідж розмови»: бріджі, створені `Dial()`, не керуються ARI-застосунком. Мотивацію див. у proposal.md.

## Goals / Non-Goals

**Goals:**
- Працювати без змін діалплану — тільки ARI.
- Затримка «сказав → побачив текст» ≤ ~1 с для partial.
- Розділення мовців за каналами (не за ML-діаризацією).

**Non-Goals:**
- Збереження записів/транскриптів у БД (можна додати окремою зміною).
- Кілька користувачів/ролей, SSO.
- AI-підказки/резюме розмови (наступний крок після стабільної розшифровки).
- Публікація розширення в Chrome Web Store (ставиться як unpacked).

## Decisions

### D1. Стек: TypeScript на Node.js 24 LTS, один мовний стек для сервера й розширення
Навантаження невелике: один потік slin 8 kHz — це 16 КБ/с. Навіть 100 одночасних дзвінків (200 потоків) дають близько 3 МБ/с I/O без обчислень, і event loop Node з цим легко справляється. Тому мову обираємо не за продуктивністю, а за DX та екосистемою:
- **Офіційний SDK `assemblyai`** (Node) підтримує Universal-Streaming v3 (`client.streaming.transcriber`) з reconnect, `formatTurns`, `languageCodes` і dual-channel режимом (`channels`), тож не треба вручну писати протокол.
- **Розширення в будь-якому разі пишеться на TS**, тому спільний пакет `packages/shared` (zod-схеми подій) дає один контракт між сервером і UI без генерації коду.
- ARI і AudioSocket — тонкі протоколи: ~8 REST-ендпоінтів через `fetch`, події через `ws`, AudioSocket — ~60 рядків парсера на `node:net`. `node-ari-client` не беремо: він застарілий, на swagger 1.x і без типів.

Бібліотеки сервера: `ws`, `zod`, `pino` (логи), `assemblyai`; тести — `vitest`; запуск — `tsx` у dev і `tsup`/`tsc` у prod.
Структура: монорепо `pnpm` workspaces — `apps/server`, `apps/extension`, `packages/shared`.

*Розглянуті альтернативи:*
- **Go** (`CyCoreSystems/ari` + `CyCoreSystems/audiosocket`; автор AudioSocket — той самий автор) — найкращий вибір, якщо потрібні сотні одночасних дзвінків або деплой одним бінарником прямо на хост PBX. Мінуси: друга мова в проєкті, дубляж схем подій, для AssemblyAI streaming v3 — ручний WS-клієнт. Перехід можливий пізніше: протокол `/ui` зафіксовано в specs, тому розширення від цього не зміниться.
- **Python asyncio** (`assemblyai` SDK, `websockets`) — добрий, якщо далі планується важка локальна ML-обробка. Але LLM-підказки й резюме — це теж HTTP API, а для них TS не гірший. Мінус — дві мови й слабша типізація контракту з UI.
- **Bun/Deno** — сумісність `node:net`/`ws` уже нормальна, але для довгоживучого телефонного сервісу надійніше LTS Node.

### D2. Моніторинг номерів: підписка на endpoint event source
WSS: `wss://<pbx>:8089/ari/events?app=live-ai&subscribeAll=false` + `POST /applications/live-ai/subscription?eventSource=endpoint:PJSIP/222` для кожного номера (повторюється після кожного reconnect).
Тригер старту: `ChannelStateChange` зі `state=Up` для каналу цього ендпоінта + перевірка, що канал у бріджі (`BridgeEnter` або `GET /channels/{id}` → бридж через `CHANNEL(bridgepeer)`/події). Дедуплікація — `Map<channelId, Session>`.
*Альтернатива:* `subscribeAll=true` — простіше, але на навантаженому PBX це шквал подій. Можна увімкнути прапорцем як fallback.

### D3. Підслуховування: 2× snoop + 2× externalMedia(audiosocket), кожна пара у власному mixing-бриджі
```
PJSIP/222-xxx ──snoop spy=in──▶ Snoop(agent)  ─┐ bridge A ┌─ ExternalMedia(audiosocket, uuid-A) ──TCP──▶ AudioSocket server
              └─snoop spy=out─▶ Snoop(caller) ─┐ bridge B ┌─ ExternalMedia(audiosocket, uuid-B) ──TCP──▶ AudioSocket server
```
- `POST /channels/{id}/snoop?app=live-ai&spy=in` — голос, що йде від 222 (agent); `spy=out` — те, що 222 чує (caller). `whisper=none` → учасники нас не чують.
- `POST /channels/externalMedia?app=live-ai&external_host=<srv>:<port>&encapsulation=audiosocket&transport=tcp&format=slin&data=<uuid>`.
- Snoop і externalMedia з'єднуються через `POST /bridges?type=mixing` + `addChannel`.
*Чому не один snoop spy=both:* отримуємо змішане аудіо і втрачаємо, хто говорить; ML-діаризація на 8 кГц телефонії гірша і повільніша.
*Чому не додати externalMedia в брідж розмови:* брідж від `Dial()` не керований ARI, а додавання каналу змінило б мікс для учасників.

**Результат spike (задача 1.5, 2026-09-24, Asterisk 20.17 на `pbx.gixo.co.uk`):** шлях D3 працює як є, fallback через `Local`-канал не потрібен. `externalMedia` з `encapsulation=audiosocket` підключається через SSH reverse tunnel, snoop `spy=in`/`spy=out` дає два розділені потоки (~16 КБ/с кожен), обидві сторони розпізнаються. Після hangup на PBX не лишається `liveai-*` каналів чи бриджів.
Спостереження: коли обидва телефони в одній кімнаті, мікрофон 222 ловить голос абонента, і репліка дублюється на стороні `agent` приблизно на 100–300 мс раніше за оригінал. Це витік звуку в кімнаті, а не змішування в snoop; реакцію (dual-channel атрибуція або фільтр дублів) вирішуємо окремо.
