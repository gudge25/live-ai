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

### D4. Формат аудіо: `slin` 8 kHz, 16-bit LE mono

> Оновлення: фактичний PBX — Asterisk **20.17** (`pbx.gixo.co.uk`), модулі `chan_audiosocket`/`res_audiosocket`/`app_audiosocket` завантажені. Починаємо зі `slin` 8 kHz як найсумісніший варіант; перехід на `slin16` можна перевірити після першого успішного тесту.
На Asterisk 18 AudioSocket передає лише `slin` 8 kHz (кадр типу `0x10`, 320 байт = 20 мс); інших частот і параметра `direction` в `externalMedia` у цій версії немає. AssemblyAI приймає `sampleRate: 8000, encoding: 'pcm_s16le'`, тож ресемплінг не потрібен.

Протокол AudioSocket: `[type:1][len:2 BE][payload]`; перший кадр — `0x01` UUID (16 байт), далі `0x10` audio, `0x00` hangup, `0xff` error. Ми лише читаємо. Канал двонаправлений, але те, що ми не шлемо аудіо назад, на учасників не впливає: snoop з `whisper=none` нічого не передає в розмову.

### D5. AssemblyAI Universal-Streaming v3 через офіційний SDK

> Модель за замовчуванням — `universal-streaming-english` ($0.15/год на потік проти $0.45 у `universal-3-5-pro`). На реальному дзвінку 2026-09-24 якість порівнянна з Pro; повернутися можна через `AAI_SPEECH_MODEL`. Параметри `languageCodes`/`includePartialTurns` API приймає для обох моделей.

`client.streaming.transcriber({ apiKey, sampleRate: 8000, encoding: 'pcm_s16le', formatTurns: true, speechModel, languageCodes: ['en'] })` — ключ лише на сервері. Мова розмов — англійська; модель — `universal-streaming-english` (див. примітку вище), `keytermsPrompt` — опційно, для назв продуктів і термінів компанії. На початку — **одна сесія на кожну сторону** (`agent`, `caller`): найпростіша й передбачувана атрибуція. Аудіо шлемо чанками 50–100 мс, для цього агрегуємо 20-мс кадри AudioSocket. На кінці викликаємо `transcriber.close()`, щоб AAI дофіналізував останню репліку.
Мапінг: `Turn` без `end_of_turn` → `partial`; `end_of_turn && turn_is_formatted` → `final` (ключ — `turn_order`/id ходу). Код ізольовано за інтерфейсом `Transcriber`, тож провайдера чи режим можна замінити.
*Опція для експерименту:* dual-channel режим SDK (`channels: [{name:'agent'},{name:'caller'}]`, `sendAudio(pcm, {channel})`) — одна сесія на дзвінок. Вмикаємо, якщо на 8 kHz він дає ту саму якість і нижчу вартість/кількість з'єднань.
*Альтернатива:* сирий WS `wss://streaming.assemblyai.com/v3/ws` — лишається fallback, якщо SDK заважатиме. Тимчасові токени й стрім з браузера не підходять: аудіо в нас на сервері.

### D6. UI-канал: WebSocket `/ui` на бекенді + in-memory стан сесій
Бекенд тримає активні сесії та їх `final`-репліки в пам'яті (обмеження: остання N-та кількість завершених сесій), щоб новий клієнт отримав снапшот. Автентифікація: `?token=` (Chrome-розширення не може ставити заголовки у `new WebSocket`). Схема подій — у `packages/shared`.

### D7. Chrome extension MV3: side panel + pop-out вікно
- `chrome.sidePanel` — основний вигляд, живе поруч з будь-якою вкладкою.
- Кнопка «Відкріпити» → `chrome.windows.create({type:'popup', width:380, height:600})` — справжнє плаваюче вікно.
- WebSocket тримає сама сторінка панелі/вікна (не service worker — його MV3 присипляє). Налаштування — `chrome.storage.local`.
- Фреймворк: **WXT** (Vite-based, file-based entrypoints `sidepanel/`, `popup/`, `options/`, генерує MV3 manifest, HMR) + **React** + Tailwind. Сирий Vite + CRXJS вимагає більше ручної роботи з manifest; Plasmo розвивається повільніше.
*Альтернатива:* content-script overlay у вкладці — прив'язаний до однієї вкладки і конфліктує зі стилями сайтів; Document Picture-in-Picture (always-on-top) — можна додати пізніше, але вимагає top-level сторінки і user gesture.

### D8. Конфіг через env (`.env`)
`ARI_URL`, `ARI_USER`, `ARI_PASSWORD`, `ARI_APP`, `MONITORED_EXTENSIONS`, `CHANNEL_TECH=PJSIP`, `AUDIOSOCKET_BIND`, `AUDIOSOCKET_ADVERTISE_HOST` (адреса, яку бачить Asterisk), `ASSEMBLYAI_API_KEY`, `AAI_SPEECH_MODEL`, `AAI_LANGUAGE_CODES`, `AAI_DUAL_CHANNEL=false`, `UI_PORT`, `UI_TOKEN`. Валідація на старті (zod).

## Risks / Trade-offs

- [Бекенд за NAT / недоступний з PBX по TCP] → `AUDIOSOCKET_ADVERTISE_HOST` окремо від bind. Для розробки за NAT: SSH reverse tunnel `-R 127.0.0.1:9092:127.0.0.1:9092` на PBX і `AUDIOSOCKET_ADVERTISE_HOST=127.0.0.1:9092`; ARI йде напряму по WSS. У продакшні — розгортати на тому ж хості/LAN, що й Asterisk.
- [Осиротілі snoop/бріджі після падіння] → усі ресурси створюються з `channelId`/`bridgeId` з префіксом `liveai-`; на старті `GET /channels`, `GET /bridges` і видалення за префіксом.
- [Якість 8 кГц телефонії] → англійська на `universal-3-5-pro` добре працює з телефонним аудіо; перевіряємо на реальних дзвінках (задача 4.5), `keytermsPrompt` — для специфічних термінів.
- [Вартість AssemblyAI: 2 сесії на дзвінок] → стрім лише поки розмова активна; `Terminate` одразу після hangup; ліміт одночасних сесій у конфігу.
- [Asterisk 18 — EOL (security-фікси завершились у жовтні 2025)] → сервіс не залежить від фіч новіших версій; при оновленні PBX до 20/22 LTS можна буде перейти на `slin16` у конфігу без зміни архітектури.
- [`externalMedia` з `encapsulation=audiosocket` недоступний у конкретній збірці 18.x] → перевіряємо першою ж задачею (spike). Fallback: `POST /channels` (originate) `Local/<uuid>@liveai-tap` у мінімальний контекст діалплану з `AudioSocket(${EXTEN},host:port)`; другий кінець Local-каналу йде в той самий бридж зі snoop. Решта архітектури не змінюється.
- [Самопідписаний TLS на ARI] → опція `ARI_CA_CERT` / `ARI_TLS_INSECURE` (тільки для dev).
- [Transfer/hold/conference з 222] → на першому етапі сесія прив'язана до каналу 222; зміна бриджу не перериває snoop (snoop слухає канал, а не брідж).
- [Приватність] → токен на UI, AAI-ключ лише на сервері, у логах не пишемо текст розмов за замовчуванням.

## Migration Plan

Нове розгортання, міграцій немає. Кроки для Asterisk 18: увімкнути в `http.conf` TLS (`tlsenable=yes`, порт 8089), додати користувача в `ari.conf`, переконатися, що завантажено `res_ari*`, `res_audiosocket`, `chan_audiosocket` (`module show like audiosocket`); запустити сервіс (Docker або systemd); встановити розширення як unpacked. Відкат — зупинити сервіс: на розмови він не впливає.
