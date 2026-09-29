# Design

## Context

Див. proposal.md - Why. Технічний контекст:

- `onEnd(channelId)` в `apps/server/src/app.ts` — обробник hangup: відв'язує tap, закриває `CallTranscription` (це флашить останню репліку через `store.addFinal`), позначає сесію `ended` у `SessionStore`, broadcast'ить `session_ended`, логує stats. Це природна точка для запуску запиту на резюме — після broadcast'у `session_ended`, fire-and-forget.
- `SessionStore` (`apps/server/src/hub/session-store.ts`) тримає єдину `Map<sessionId, SessionSnapshot>` для активних і завершених сесій; при переході в `ended` синхронно викликає `evict()`, який видаляє найстаріші завершені сесії понад `UI_HISTORY_LIMIT`. `snapshot()` віддає копії цих об'єктів новим/перепідключеним клієнтам.
- `packages/shared/src/events.ts` — Zod-схеми, discriminated union `ServerEvent` за полем `type` (snake_case: `session_started`, `session_ended`, `partial`, `final`, `snapshot`, `status`). `SessionSnapshot = SessionInfo.extend({ utterances })`.
- Єдиний існуючий HTTP-клієнтський патерн до зовнішнього REST API — `apps/server/src/ari/rest.ts`: нативний `fetch`, `AbortSignal.timeout(ms)` для таймауту, без ретраїв.
- Конфігурація — Zod `EnvSchema` в `apps/server/src/config.ts`, згрупована по префіксах (`AAI_*` для AssemblyAI), boolean-прапорці через спільний `bool` transform. `.env` завантажується через нативний Node `--env-file-if-exists` (не пакет `dotenv`) — багаторядкові значення ненадійні, тож конфігуровані рядки мають лишатися однорядковими.
- Розширення: `apps/extension/src/lib/reducer.ts` (`applyEvent`, `withSession` helper — no-op, якщо сесії вже нема в стані) та `apps/extension/src/components/Dialog.tsx` (рендер реплік, роздільник "Call ended" при `ended`).
- Формат `[HH:MM:SS] Side: text` (`formatTranscriptLine` в `events.ts`) вже використовується для копіювання транскрипту в буфер обміну (`apps/extension/src/lib/copy.ts`) — і має лишитися незмінним для цієї мети.
- Реальний ендпоінт `POST https://llm-gateway.assemblyai.com/v1/chat/completions` перевірено наживо (тестові запити з реальним `ASSEMBLYAI_API_KEY`) під час проєктування цього design.md — форма запиту/відповіді нижче підтверджена фактичними відповідями API, а не лише документацією.

## Goals / Non-Goals

**Goals:**
- Коротке (2-4 речення), звичайним текстом, без Markdown резюме розмови, що з'являється в тому самому вікні діалогу, яке оператор вже бачив під час дзвінка.
- Повторне використання наявних патернів (fetch+timeout, Zod-конфіг, discriminated event union, `withSession` reducer) замість нових абстракцій.
- Часткова відмова (мережа, таймаут, не-2xx) не впливає на решту функціоналу і не показує оператору помилку.

**Non-Goals:**
- Структурований JSON-вивід (`response_format: json_schema`) — перевірено наживо: обрана модель (`qwen3.5-4b-32k-fast`) повертає `400 model qwen3.5-4b-32k-fast does not support response_format`. Свідоме рішення: лишити резюме одним рядком тексту; структуровані поля (тема/запит/дії) — можливий майбутній розширення з іншою (повільнішою) моделлю, не в цій зміні.
- Ретраї, редагування/регенерація резюме, підтримка інших LLM-провайдерів окрім AssemblyAI LLM Gateway — все явно поза межами (див. proposal.md - Impact).
- Timestamps у тексті, що йде в LLM-запит — навмисно відсутні (див. Decisions нижче); це стосується лише вмісту LLM-запиту, не UI чи clipboard-експорту.

## Decisions

### Тригер і неблокуючість
Виклик резюме запускається в `onEnd()` **після** `this.ui?.broadcast({ type: 'session_ended', ... })`, без `await` у критичному шляху hangup — навмисно fire-and-forget (`void this.summarize(...)`), щоб мережевий виклик до LLM Gateway (навіть у межах таймауту) ніколи не затримував `session_ended`. Пропускається без запиту, якщо `entry.stats.finals === 0` (немає жодної фінальної репліки) або `AAI_SUMMARY_ENABLED=false` — обидві перевірки дешеві, без потреби сканувати `SessionStore`.

### Формат транскрипту для LLM — без часових позначок
Окрема, нова функція форматування (не `formatTranscriptLine`, яка навмисно лишається з таймстемпами для clipboard-експорту): по одному рядку на репліку, `${labels[side]}: ${text}`, у хронологічному порядку. Перевірено наживо: модель коректно розрізняє сторони й будує зв'язне резюме без часових позначок; вилучення таймстемпів також трохи зменшує довжину промпту без втрати сенсу.

### Форма запиту до LLM Gateway (перевірено наживо)
```json
{
  "model": "<AAI_SUMMARY_MODEL>",
  "messages": [
    { "role": "system", "content": "<AAI_SUMMARY_SYSTEM_PROMPT>" },
    { "role": "user", "content": "<транскрипт, Side: text по рядку, без часу>" }
  ],
  "temperature": 0.3,
  "max_tokens": 200
}
```
- `authorization` header = сирий `ASSEMBLYAI_API_KEY`, без префіксу `Bearer` (підтверджено документацією і живим 401 без заголовку).
- `messages` замість `prompt`: чіткий поділ інструкції (system) і даних (user), а не одне злите повідомлення.
- Без `stream` — не потрібен для одного короткого атомарного результату, і `stream` підтримується лише для моделей OpenAI (документація), тобто був би несумісним при зміні `AAI_SUMMARY_MODEL` на іншого провайдера.
- Без `transcript_id` — транскрипт не є асинхронним об'єктом AssemblyAI API (вже зафіксовано в spec.md).
- `temperature: 0.3`, `max_tokens: 200` — підібрано й перевірено наживо: дає стабільний короткий текст (у тесті — 71 completion token, ~0.28с) без Markdown-форматування, коли `system`-повідомлення явно просить plain text.
- Відповідь: `choices[0].message.content` → `summary: string`, англійською (рішення користувача, узгоджене з мовою стрімінгу AssemblyAI Universal-Streaming, що вже налаштований на English).

### Вибір моделі — `qwen3.5-4b-32k-fast`
Розглянуті альтернативи: Qwen3 32B / Qwen3 Next 80B A3B, Gemini 2.5 Flash-Lite, GPT-oss варіанти — усі підтримують `response_format`, але повільніші (3.1с+ на 10k токенів за таблицею документації, проти протестованих ~0.28-0.9с для `qwen3.5-4b-32k-fast`). Оскільки структурований вивід — не ціль цієї зміни (див. Non-Goals), обрано найшвидшу/найдешевшу модель, реально протестовану проти цього ж транскрипту й промпту.
Компроміс: `qwen3.5-4b-32k-fast` (родина Alibaba Cloud Qwen) доступна лише на US-ендпоінті LLM Gateway, не на EU. Прийнятно, оскільки стрімінг-транскрипція вже йде через AssemblyAI US-інфраструктуру — нового вектора приватності це не додає.
Модель конфігурована (`AAI_SUMMARY_MODEL`), тож може бути змінена без зміни коду, якщо потрібна інша модель або регіон.

### Конфігурація (нові env-змінні, у секції `--- AssemblyAI ---` в `config.ts` і `.env.example`)
```
AAI_SUMMARY_ENABLED=false                  # bool, вимкнено за замовчуванням
AAI_SUMMARY_MODEL=qwen3.5-4b-32k-fast      # string
AAI_SUMMARY_TIMEOUT_MS=10000               # number, AbortSignal.timeout
AAI_SUMMARY_SYSTEM_PROMPT=Summarize this phone call transcript for an operator glancing at it after the call. Plain text only, no markdown, no headers, no bold, no asterisks. 2-4 short sentences covering: what the call was about, what the caller wanted, and any action items.
```
`AAI_SUMMARY_SYSTEM_PROMPT` — однорядковий текст (обмеження нативного `--env-file-if-exists`, без гарантій для багаторядкових значень). Значення за замовчуванням — той самий текст, що дав чистий результат у живому тесті.

### Доставка і зберігання резюме
- Новий необов'язковий `summary: z.string().optional()` на `SessionSnapshot` (events.ts) — тримається в тому самому об'єкті, що вже лежить у `SessionStore`, тож потрапляє в `snapshot()` автоматично для нових клієнтів без додаткової логіки.
- Новий метод `SessionStore.setSummary(id: string, summary: string): void` — no-op, якщо сесію вже evicted (задовольняє сценарій "Call scrolled out of history before summary arrives" зі spec.md без додаткової перевірки на виклику).
- Новий discriminated-union варіант `SummaryEvent = { type: 'summary', sessionId, summary }` у `ServerEvent` (events.ts) — той самий naming convention (snake_case `type`), той самий broadcast-шлях, що й `session_ended` (`this.ui?.broadcast({...}, info.extension)`).
- Розширення: новий `case 'summary':` у `applyEvent()` (reducer.ts), що використовує вже наявний `withSession()` helper — автоматично no-op, якщо сесія вже не в `state.sessions` (той самий "ignore if scrolled out" для клієнтської сторони).

### Розміщення в UI
Резюме рендериться в `Dialog.tsx` одразу після роздільника `{ended && (...'Call ended'...)}` — те саме вікно діалогу, яке оператор вже бачив під час дзвінка ("доповнити вікно діалогу після закінчення"), а не в пілл-навігації `Header.tsx`.

### Ізоляція відмов і логування
Мережева помилка, не-2xx, або таймаут (`AbortSignal.timeout(AAI_SUMMARY_TIMEOUT_MS)`) — усі трактуються однаково: `log.warn({ sessionId, ... }, '<повідомлення>')` (той самий стиль, що й інші `warn`-логи в кодовій базі), подія `summary` не публікується, `SessionStore` не оновлюється. Без ретраїв — узгоджено з відсутністю retry-логіки будь-де в сервері.

## Risks / Trade-offs

- **Якість резюме малої/швидкої моделі** → пом'якшено конфігурованістю `AAI_SUMMARY_MODEL`; можна перейти на більшу модель пізніше без зміни коду.
- **`qwen3.5-4b-32k-fast` не підтримує `response_format`** → прийнято свідомо (Non-Goals); якщо структуровані поля знадобляться пізніше, це вимагатиме зміни моделі й нового design-рішення, не просто конфігурації.
- **Відсутність ретраїв** → тимчасовий збій назавжди залишає дзвінок без резюме → прийнятно, узгоджено зі спекою (Failure isolation requirement).
- **Гонка "evict до відповіді LLM"** → резюме, що прийшло для вже витісненої з `UI_HISTORY_LIMIT` сесії, ігнорується і на сервері (`setSummary` no-op), і на клієнті (`withSession` no-op) — без помилок, як і вимагає spec.md.
- **`AAI_SUMMARY_SYSTEM_PROMPT` як однорядковий env-рядок** → ризик випадкового зіпсованого промпту при редагуванні `.env` вручну → пом'якшено розумним значенням за замовчуванням, що постачається "з коробки".

## Migration Plan

Фіча вимкнена за замовчуванням (`AAI_SUMMARY_ENABLED=false`) — розгортання не потребує міграції даних: нове поле `summary` необов'язкове, нова подія адитивна до `ServerEvent`, старі клієнти й старі знімки історії лишаються валідними. Відкат — встановити `AAI_SUMMARY_ENABLED=false` (або відкатити деплой); стан у пам'яті (`SessionStore`) не персистентний, тож відкат не залишає застряглих даних.
