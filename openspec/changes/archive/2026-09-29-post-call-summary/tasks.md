# Tasks

## 1. Спільний контракт (`packages/shared`)

- [x] 1.1 Додати `summary: z.string().optional()` до `SessionSnapshot` в `packages/shared/src/events.ts` і перевірити, що `pnpm --filter @live-ai/shared build` (або `tsc --noEmit`) проходить без помилок типів у залежних пакетах
- [x] 1.2 Додати новий варіант `SummaryEvent = { type: 'summary', sessionId, summary }` до discriminated union `ServerEvent`, експортувати тип, і покрити `packages/shared/src/events.test.ts` тестом на `parseServerEvent`/`parseClientMessage` для нової форми (валідний і невалідний payload)

## 2. Конфігурація сервера

- [x] 2.1 Додати `AAI_SUMMARY_ENABLED` (bool, default `false`), `AAI_SUMMARY_MODEL` (string, default `qwen3.5-4b-32k-fast`), `AAI_SUMMARY_TIMEOUT_MS` (number, default `10000`), `AAI_SUMMARY_SYSTEM_PROMPT` (string, зі значенням за замовчуванням з design.md) до `EnvSchema` в `apps/server/src/config.ts`, у секції `--- AssemblyAI ---`
- [x] 2.2 Додати ці ж чотири змінні (закоментовані/зі значеннями за замовчуванням) у відповідну секцію `.env.example`
- [x] 2.3 Розширити `apps/server/src/config.test.ts` тестами на значення за замовчуванням і на успішний парсинг явно заданих значень для всіх чотирьох нових змінних

## 3. Клієнт AssemblyAI LLM Gateway

- [x] 3.1 Створити модуль (напр. `apps/server/src/summary/summary-client.ts`) з функцією, що приймає `{ model, systemPrompt, transcriptText, timeoutMs }` і повертає `Promise<string | undefined>`: `fetch` на `https://llm-gateway.assemblyai.com/v1/chat/completions` з `authorization: <ASSEMBLYAI_API_KEY>` (без `Bearer`), тілом `{ model, messages: [system, user], temperature: 0.3, max_tokens: 200 }`, `signal: AbortSignal.timeout(timeoutMs)` — за зразком `apps/server/src/ari/rest.ts`
- [x] 3.2 У цьому ж модулі: не-2xx відповідь, мережева помилка і timeout (`DOMException` з `name === 'TimeoutError' | 'AbortError'`) всі повертають `undefined` (не кидають виключення назовні), кожен випадок логує `warn` з `sessionId`/статусом через переданий логер
- [x] 3.3 Написати `summary-client.test.ts` (мокаючи `global.fetch`) на: успішну відповідь → повертає `choices[0].message.content`; `4xx`/`5xx` → повертає `undefined` і логує `warn`; timeout → повертає `undefined` і логує `warn`; мережева помилка (`fetch` reject) → повертає `undefined` і логує `warn`

## 4. Формування транскрипту для LLM

- [x] 4.1 Додати невелику функцію форматування (окрему від `formatTranscriptLine`, без часових позначок): по одному рядку `${labels[side]}: ${text}` у хронологічному порядку — розмістити поруч з новим summary-модулем або в `packages/shared`, якщо потрібна і на сервері, і в тестах
- [x] 4.2 Юніт-тест на цю функцію: перевірити хронологічне сортування між сторонами і відсутність часових позначок у виводі

## 5. `SessionStore`: зберігання резюме

- [x] 5.1 Додати метод `SessionStore.setSummary(id: string, summary: string): boolean` в `apps/server/src/hub/session-store.ts` — повертає `false` (без помилки), якщо сесії вже нема в мапі (evicted), інакше `true` (потрібно в `app.ts`, щоб знати, чи варто broadcast'ити подію)
- [x] 5.2 Розширити `apps/server/src/hub/hub.test.ts` тестами: `setSummary` записує поле в існуючу сесію і воно потрапляє у наступний `snapshot()`; `setSummary` для вже evicted `id` — без помилки й без побічного ефекту

## 6. Інтеграція в `onEnd()`

- [x] 6.1 В `apps/server/src/app.ts::onEnd()`, після broadcast `session_ended`: якщо `AAI_SUMMARY_ENABLED` і `entry.stats.finals > 0`, зібрати транскрипт сесії (функція з 4.1) і викликати summary-клієнт (3.1) без `await` у самому `onEnd()` (fire-and-forget, наприклад через `void this.summarize(...)`). Реалізовано зі знімком `utterances` до `store.update(..., {state:'ended'})`, бо `update()` може синхронно evict'нути сесію одразу.
- [x] 6.2 На успішній відповіді: викликати `this.o.store.setSummary(sessionId, summary)` і `this.ui?.broadcast({ type: 'summary', sessionId, summary }, info.extension)` — але тільки якщо сесія все ще присутня в `SessionStore` (щоб не broadcast'ити подію для вже evicted сесії)
- [x] 6.3 На `undefined` від summary-клієнта (вимкнено, помилка, таймаут, порожній транскрипт): нічого не робити — ні запису в store, ні broadcast
- [x] 6.4 Розширити `apps/server/src/app.test.ts` тестами на сценарії зі spec.md: дзвінок з транскриптом → викликається summary-клієнт; дзвінок без жодної фінальної репліки → клієнт не викликається; фіча вимкнена → клієнт не викликається; `session_ended` публікується без очікування відповіді summary-клієнта (перевірити порядок/неблокуючість, наприклад через контрольований проміс)

## 7. Розширення (reducer + UI)

- [x] 7.1 В `apps/extension/src/lib/reducer.ts`: розширити `fromSnapshot()`, щоб переносити `s.summary` у `SessionView.summary`, і додати `case 'summary':` в `applyEvent()` через наявний `withSession()` helper
- [x] 7.2 Розширити `apps/extension/src/lib/reducer.test.ts`: snapshot з `summary` заповнює `SessionView.summary`; подія `summary` для існуючої сесії оновлює `SessionView.summary`; подія `summary` для сесії, якої вже нема в `state.sessions` (scrolled out), — без помилки й без зміни стану
- [x] 7.3 В `apps/extension/src/components/Dialog.tsx`: відрендерити `session.summary` (якщо є) одразу після роздільника `{ended && (...'Call ended'...)}` — окремий текстовий блок, без Markdown-парсингу (звичайний текст)
- [x] 7.4 Вручну перевірити в браузері (dev-режим розширення): дзвінок із увімкненою фічею показує резюме після завершення; дзвінок з вимкненою фічею або без резюме виглядає так само, як і зараз. Перевірено на реальних дзвінках через розширення (не мок): резюме коректно з'являється після "Call ended", звичайним текстом, без Markdown-артефактів.

## 8. Наскрізна перевірка

- [x] 8.1 З `AAI_SUMMARY_ENABLED=true` і реальним `ASSEMBLYAI_API_KEY` зробити тестовий дзвінок кінець-в-кінець, переконатися, що резюме з'являється у вікні діалогу після завершення дзвінка, і що воно відповідає вмісту розмови. Виконано на реальному PBX через `docker compose` (після виправлення відсутнього SSH-тунелю для AudioSocket, не пов'язаного з цією зміною) — кілька реальних дзвінків, резюме коректне й відповідає вмісту.
- [x] 8.2 Прогнати повний набір тестів (`pnpm test` або еквівалент у корені воркспейсу) і переконатися, що нічого не зламано в наявних тестах `realtime-transcription`/`call-audio-tap`/`pbx-call-monitoring` — 17 файлів, 113 тестів, усі проходять
