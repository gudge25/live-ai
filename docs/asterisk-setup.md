# Налаштування Asterisk 18 для Live AI

Діалплан не змінюється. Потрібні лише ARI по HTTPS/WSS та модулі AudioSocket.

## 1. Модулі

```
asterisk -rx "module show like audiosocket"   # res_audiosocket.so, chan_audiosocket.so — Running
asterisk -rx "module show like res_ari"       # res_ari.so, res_ari_channels.so, res_ari_bridges.so, res_ari_applications.so ...
```
Якщо чогось немає: `asterisk -rx "module load chan_audiosocket.so"` (і додати `load =>` у `modules.conf`).

## 2. `http.conf` — HTTPS/WSS для ARI

```ini
[general]
enabled = yes
bindaddr = 127.0.0.1          ; plain HTTP лише локально
bindport = 8088
tlsenable = yes
tlsbindaddr = 0.0.0.0:8089
tlscertfile = /etc/asterisk/keys/asterisk.crt
tlsprivatekey = /etc/asterisk/keys/asterisk.key
```
`asterisk -rx "module reload http"` → `asterisk -rx "http show status"` має показати `HTTPS Server Enabled and Bound to 0.0.0.0:8089`.

Якщо сертифікат самопідписаний, покладіть CA (або сам .crt) у `./certs/pbx-ca.pem` і задайте `ARI_CA_CERT=/certs/pbx-ca.pem`. Для першого тесту можна тимчасово `ARI_TLS_INSECURE=true`.

## 3. `ari.conf` — користувач

```ini
[general]
enabled = yes

[liveai]
type = user
read_only = no
password = <той самий, що ARI_PASSWORD>
```
`asterisk -rx "module reload res_ari.so"` → `asterisk -rx "ari show users"`.

## 4. Мережа

| Звідки → куди | Порт | Навіщо |
|---|---|---|
| Live AI → Asterisk | TCP 8089 (TLS) | ARI REST + WSS події |
| **Asterisk → Live AI** | TCP 9092 (`AUDIOSOCKET_PUBLISH_PORT`) | аудіо AudioSocket |
| Браузер → Live AI | TCP 8765 (`UI_PUBLISH_PORT`) | WebSocket `/ui` для розширення |

`AUDIOSOCKET_ADVERTISE_HOST` = IP хоста з Docker, **як його бачить Asterisk**, + опублікований порт (напр. `192.168.1.50:9092`). Перевірка з PBX: `nc -vz 192.168.1.50 9092`.

## 5. Перший запуск

```bash
cp .env.example .env         # вже створено; заповнити ARI_*, ASSEMBLYAI_API_KEY, AUDIOSOCKET_ADVERTISE_HOST
docker compose up -d --build
docker compose logs -f live-ai
```
Очікувані рядки в логах: `ARI events connected` → `subscribed to monitored endpoints`.
Стан: `curl http://localhost:8765/healthz` → `{"ok":true,"ari":"connected",...}`. Застосунок ARI видно на PBX: `asterisk -rx "ari show apps"` → `live-ai`.

## 6. Тестовий дзвінок (задачі 1.5 / 7.2)

1. Подзвоніть на 222 (або з 222) і відповідайте.
2. У логах: `conversation started` → `tap attached`. На PBX під час розмови:
   ```
   asterisk -rx "core show channels" | grep -E "Snoop|AudioSocket"
   asterisk -rx "bridge show all"            # два мікс-бриджі liveai-<id>-br-agent / -br-caller
   ```
3. У вікні розширення з'являються репліки обох сторін.
4. Покладіть трубку → у логах `conversation ended` / `tap detached`; команди з п.2 більше не показують `liveai-*`.
5. Під час розмови виконайте `docker compose stop` — учасники нічого не чують і розмова триває (задача 7.3).

### Якщо `tap attach failed`

Подивіться помилку ARI в лозі:
- `Stasis app not registered` / `Provided application not found` — ARI WSS ще не підключений.
- `externalMedia ... 400/501` або `encapsulation` — ця збірка 18.x не підтримує `encapsulation=audiosocket` у externalMedia → потрібен fallback через `Local`-канал (design.md, ризики). Надішліть лог — додамо.
- Snoop створився, але аудіо не приходить: перевірте `nc -vz <AUDIOSOCKET_ADVERTISE_HOST>` з PBX і фаєрвол.

### Ручний spike без сервісу (діагностика)

```bash
# термінал 1 — зареєструвати Stasis-застосунок
npx wscat -n -c "wss://PBX:8089/ari/events?app=spike&api_key=liveai:PASS"
# термінал 2 — слухач AudioSocket на хості з IP 192.168.1.50
nc -l 9092 > /tmp/as.raw
# термінал 3 — під час дзвінка на 222
A='-sku liveai:PASS'; B=https://PBX:8089/ari
CH=$(curl $A $B/channels | jq -r '.[]|select(.name|startswith("PJSIP/222-")).id')
curl $A -X POST "$B/channels/$CH/snoop?app=spike&spy=in&whisper=none&snoopId=spike-snoop"
curl $A -X POST "$B/channels/externalMedia?app=spike&channelId=spike-em&external_host=192.168.1.50:9092&encapsulation=audiosocket&transport=tcp&format=slin&data=$(uuidgen)"
curl $A -X POST "$B/bridges?type=mixing&bridgeId=spike-br"
curl $A -X POST "$B/bridges/spike-br/addChannel?channel=spike-snoop,spike-em"
ls -l /tmp/as.raw     # розмір має рости ~16 КБ/с
curl $A -X DELETE $B/bridges/spike-br; curl $A -X DELETE $B/channels/spike-snoop; curl $A -X DELETE $B/channels/spike-em
```
