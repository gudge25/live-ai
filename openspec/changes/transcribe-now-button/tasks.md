# Tasks

## 1. Протокол `/ui` (packages/shared)

- [ ] 1.1 У `packages/shared/src/events.ts` додати схему `UntappedCall`, поле `SnapshotEvent.untapped` (`default([])`), події `call_untapped`, `call_untapped_ended`, `transcribe_now_rejected` (з `reason ∈ not_found | already_tapped | not_watching | limit_reached`), повідомлення клієнта `transcribe_now` і необов'язкове `SessionInfo.transcribedFrom`; додати їх до `ServerEvent`/`ClientMessage`; перевірити тестами в `events.test.ts`, що валідні повідомлення парсяться, невалідні (порожній `channelId`, невідома `reason`) відхиляються, а `snapshot` без `untapped` парситься з порожнім масивом
- [ ] 1.2 Зібрати `@live-ai/shared` і впевнитись, що `pnpm -r typecheck` проходить у server та extension після зміни типів (старі виклики не ламаються)

## 2. Сервер: облік розмов без tap і запуск за запитом (apps/server)

- [ ] 2.1 У `LiveAiApp` розділити `onStart` на рішення і виконання `beginSession(call, { late })`, не змінюючи поведінки звичайного старту; перевірити, що всі існуючі тести `app.test.ts` проходять без правок
- [ ] 2.2 Додати `untapped: Map<channelId, MonitoredCall>`: запис у гілці «немає глядача», видалення на `end` від монітора; надсилати `call_untapped` / `call_untapped_ended` через `broadcast(ev, extension)`; розмови, пропущені через ліміт одночасних сесій, не додавати; перевірити тестами в `app.test.ts`: пропущена розмова з'являється в обліку, зникає після `end`, розмова з tap і розмова, пропущена через ліміт, в облік не потрапляють
- [ ] 2.3 Реалізувати `LiveAiApp.transcribeNow(channelId, clientExtensions)` з порядком перевірок із design.md D3 (`already_tapped` → `not_found` → `not_watching` → `limit_reached` → запуск), синхронним переходом `untapped → live` і `transcribedFrom = now` при збереженні `startedAt` розмови; перевірити тестами: успішний запуск створює tap, відкриває стріми й публікує `session_started`; кожна з чотирьох відмов не створює ні каналів, ні сесії; два послідовні запити на одну розмову дають рівно одну сесію; відмова через ліміт лишає розмову в обліку
- [ ] 2.4 Перевірити тестом, що розмова, запущена запитом, проходить звичайне завершення (`session_ended`, прибирання ресурсів, підсумок за налаштуванням), а наступна розмова на тому ж екстеншні без глядача знову пропускається (запит одноразовий)
- [ ] 2.5 У `UiServer`: додати `untapped` у `snapshot` (з тим самим фільтром екстеншнів) і при `subscribe`; розібрати `transcribe_now`, викликати колбек `onTranscribeNow` і при відмові надіслати `transcribe_now_rejected` лише цьому клієнту; підключити колбек у `main.ts` до `LiveAiApp`; перевірити тестами в `hub.test.ts`: клієнт 222 бачить розмову 222 у snapshot і не бачить розмови 223, відмова приходить лише автору, невалідне повідомлення ігнорується

## 3. Розширення: стан і інтерфейс (apps/extension)

- [ ] 3.1 У `reducer.ts` додати `untapped` у стан, обробку `snapshot`, `call_untapped`, `call_untapped_ended`, `session_started` (прибирає запис із тим самим `channelId`), `transcribe_now_rejected`, дію запиту (`requested`) і фільтрацію за налаштуванням «Extensions»; «Clear» не торкається `untapped`; перевірити тестами в `reducer.test.ts`
- [ ] 3.2 У `TranscriptSocket` додати `send(msg)`, що не робить нічого, поки з'єднання не `open`; перевірити тестом (або ручною перевіркою в консолі), що повідомлення не надсилається до `onopen` і надсилається після
- [ ] 3.3 У `App.tsx` додати банер «розмова триває, але не транскрибується» з кнопкою «Transcribe now» над діалогом і в `EmptyState`; кнопка неактивна після натискання, показує причину відмови, зникає при `session_started` / `call_untapped_ended`; перевірити `pnpm --filter @live-ai/extension build` і ручним прогоном у Chrome
- [ ] 3.4 У `Header.tsx` показувати «transcribed from hh:mm:ss» для сесій із `transcribedFrom`; перевірити, що звичайні сесії не мають позначки (тест або візуально)

## 4. Перевірка наскрізь

- [ ] 4.1 `pnpm lint`, `pnpm -r typecheck`, `pnpm -r test` проходять; Sonar без нових зауважень
- [ ] 4.2 На тестовому PBX (лабораторний застосунок із SIPp-дзвінками 9901 ↔ 9902): дзвінок без глядача → відкрити клієнта → у `snapshot` є `untapped`; надіслати `transcribe_now` → прийшов `session_started`, `final` лише для мови після запиту; повторний запит → `already_tapped`; після завершення розмови `call_untapped_ended` не приходить повторно, а новий дзвінок без глядача знову пропускається
- [ ] 4.3 Ручна перевірка в Chrome на розгорнутому сервері: відкрити вікно посеред розмови → видно банер і кнопку; натиснути → з'являється текст і позначка «transcribed from»; «Clear» не прибирає банер
- [ ] 4.4 Оновити README (розділ про розширення): що робити, якщо розмова не транскрибується, бо вікно відкрили пізніше; перевірити, що опис збігається з поведінкою кнопки
- [ ] 4.5 Після злиття: `openspec archive transcribe-now-button`, перевірити, що `openspec/specs/viewer-gated-transcription/spec.md` оновлено, а `openspec/specs/transcribe-now/spec.md` створено
