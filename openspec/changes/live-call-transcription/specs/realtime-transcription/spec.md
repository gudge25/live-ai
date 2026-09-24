# Spec Delta

## Purpose

Перетворює аудіопотоки кожної сторони розмови на текст у реальному часі через AssemblyAI realtime, видаючи проміжні та фінальні репліки з прив'язкою до мовця.

## ADDED Requirements

### Requirement: Streaming session per party
Для кожного аудіопотоку (`agent`, `caller`) сервіс SHALL відкривати окрему realtime-сесію AssemblyAI із частотою дискретизації та кодуванням, що відповідають вхідному аудіо. API-ключ AssemblyAI MUST зберігатися лише на бекенді і MUST NOT передаватися в UI.

#### Scenario: Session opened
- **WHEN** почав надходити аудіопотік сторони
- **THEN** відкривається realtime-сесія AssemblyAI і аудіо передається в неї без буферизації довше 200 мс

### Requirement: Partial and final utterances
Сервіс SHALL публікувати проміжні результати (текст, що ще змінюється) і фінальні репліки (кінець ходу мовця). Кожна подія MUST містити ідентифікатор сесії, сторону (`agent`/`caller`), порядковий номер репліки, текст і часову мітку.

#### Scenario: Partial update
- **WHEN** AssemblyAI повертає незавершений хід
- **THEN** публікується подія `partial` з поточним текстом для цього номера репліки, яка замінює попередній partial

#### Scenario: Final utterance
- **WHEN** AssemblyAI повідомляє про кінець ходу
- **THEN** публікується подія `final` з відформатованим текстом, і partial для цього номера репліки більше не надсилається

### Requirement: Session termination
Після завершення аудіопотоку сервіс SHALL коректно завершити realtime-сесію (повідомлення про завершення), щоб останні слова були розпізнані і не тарифікувався зайвий час.

#### Scenario: Call ends mid-sentence
- **WHEN** AudioSocket-потік закрився, поки мовець говорив
- **THEN** сервіс надсилає завершення сесії, публікує останній `final`, і лише потім закриває з'єднання з AssemblyAI

### Requirement: Transcription failure handling
При обриві з'єднання з AssemblyAI під час розмови сервіс SHALL спробувати перепідключитися (до 3 спроб) і MUST повідомити UI про статус `transcription_degraded`, якщо спроби вичерпано.

#### Scenario: AssemblyAI disconnect
- **WHEN** WebSocket AssemblyAI закрився з помилкою під час активної розмови
- **THEN** сервіс відкриває нову сесію і продовжує передавати аудіо; UI бачить коротку перерву, а не зупинку розшифровки
