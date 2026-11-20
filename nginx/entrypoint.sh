#!/bin/sh
# nginx entrypoint for docker-compose-nginx.yml.
#  - renders rendered/ssl.conf (real Let's Encrypt cert if present, else a
#    self-signed placeholder) and rendered/allow.conf (PBX source-IP allow list)
#  - runs nginx in the foreground
#  - every 30s re-renders (re-resolving PBX hostnames, noticing a new/renewed
#    cert) and hot-reloads nginx only when something actually changed
set -eu

DOMAIN="${PUBLIC_DOMAIN:?PUBLIC_DOMAIN is required}"
PBX_ALLOWED_IPS="${PBX_ALLOWED_IPS:-}"
PBX_ALLOWED_HOSTS="${PBX_ALLOWED_HOSTS:-}"

# Runs as uid 101 on a read-only root fs: only /tmp (tmpfs) is writable.
R=/tmp/rendered
DUMMY=/tmp/dummy
DNS_CACHE=/tmp/pbx-dns
# Readable copy of the Let's Encrypt cert, published by certbot's deploy hook as a
# versioned dir behind an atomically switched `current` symlink.
CERT_ROOT=/certs
REAL=$CERT_ROOT/current
mkdir -p "$R" "$DUMMY" "$DNS_CACHE"

log() { echo "[entrypoint] $*" >&2; }

if [ ! -s "$DUMMY/key.pem" ]; then
  log "generating self-signed placeholder certificate for $DOMAIN"
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -subj "/CN=$DOMAIN" -keyout "$DUMMY/key.pem" -out "$DUMMY/cert.pem" 2>/dev/null
fi

# Strict IPv4 check (octets <= 255, optional /prefix <= 32). IPv6 is deliberately
# not supported. Anything nginx would reject must not reach allow.conf, or
# `nginx -t` fails and the whole edge (HTTPS + ACME) stays down.
valid_ip() {
  v=$1; addr=${v%%/*}; pfx=""
  [ -n "$addr" ] || return 1
  case $v in */*) pfx=${v#*/}; [ -n "$pfx" ] || return 1 ;; esac
  printf '%s' "$addr" | awk -F. 'NF != 4 { exit 1 } { for (i = 1; i <= 4; i++) if ($i !~ /^[0-9]{1,3}$/ || $i + 0 > 255) exit 1 }' || return 1
  if [ -n "$pfx" ]; then
    printf '%s' "$pfx" | grep -Eq '^[0-9]{1,2}$' || return 1
    [ "$pfx" -le 32 ] || return 1
  fi
  return 0
}
valid_host() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'; }

# Replace $2 with $1 only if different; echo "1" when it changed.
install_if_changed() {
  if [ -f "$2" ] && cmp -s "$1" "$2"; then rm -f "$1"; return 1; fi
  mv "$1" "$2"; return 0
}

render() {
  changed=1  # 1 = nothing changed (shell convention: 0 = true)

  # ---- TLS include ----
  # certbot publishes each cert+key pair as an immutable version dir and flips the
  # `current` symlink. Resolve it ONCE here and point nginx at the version dir
  # itself: nginx opens cert and key as two separate paths, so going through the
  # moving symlink could pair a new cert with an old key. A new version name also
  # counts as a change (it covers cert and key together).
  ver=$(readlink "$REAL" 2>/dev/null || true)
  if [ -n "$ver" ] && [ -s "$CERT_ROOT/$ver/fullchain.pem" ] && [ -s "$CERT_ROOT/$ver/privkey.pem" ]; then
    crt="$CERT_ROOT/$ver/fullchain.pem"; key="$CERT_ROOT/$ver/privkey.pem"; sig=$ver
  else
    crt="$DUMMY/cert.pem"; key="$DUMMY/key.pem"; sig=placeholder
  fi
  printf '# cert-sig: %s\nssl_certificate %s;\nssl_certificate_key %s;\n' "$sig" "$crt" "$key" > "$R/ssl.conf.new"
  if install_if_changed "$R/ssl.conf.new" "$R/ssl.conf"; then changed=0; fi

  # ---- PBX allow list ----
  {
    echo "# generated; do not edit"
    n=0
    for ip in $(printf '%s' "$PBX_ALLOWED_IPS" | tr ',' ' '); do
      if valid_ip "$ip"; then echo "allow $ip;"; n=$((n + 1)); else log "ignoring invalid PBX_ALLOWED_IPS entry: $ip"; fi
    done
    for h in $(printf '%s' "$PBX_ALLOWED_HOSTS" | tr ',' ' '); do
      if ! valid_host "$h"; then log "ignoring invalid PBX_ALLOWED_HOSTS entry: $h"; continue; fi
      addrs=$(getent ahostsv4 "$h" 2>/dev/null | awk '{print $1}' | sort -u || true)
      if [ -n "$addrs" ]; then
        printf '%s\n' "$addrs" > "$DNS_CACHE/$h"
      elif [ -s "$DNS_CACHE/$h" ]; then
        log "could not resolve $h — keeping last known address"
        addrs=$(cat "$DNS_CACHE/$h")
      else
        log "could not resolve $h and no cached address — skipping"
        continue
      fi
      for a in $addrs; do
        if valid_ip "$a"; then echo "allow $a; # $h"; n=$((n + 1)); fi
      done
    done
    [ "$n" -gt 0 ] || echo "# WARNING: no PBX_ALLOWED_IPS / PBX_ALLOWED_HOSTS set — AudioSocket port rejects everyone"
    echo "deny all;"
  } > "$R/allow.conf.new"
  # allow.gen is the raw generated list; allow.conf is what nginx uses (possibly pruned
  # by check_config), so a pruned entry doesn't look like a change on every tick.
  if install_if_changed "$R/allow.conf.new" "$R/allow.gen"; then cp "$R/allow.gen" "$R/allow.conf"; changed=0; fi

  return $changed
}

# If nginx still rejects the generated config, find the offending allow entries
# one by one and drop only those — valid entries keep working.
check_config() {
  if nginx -t >/dev/null 2>&1; then return 0; fi
  log "nginx -t rejected the generated config — testing allow entries one by one"
  {
    echo "# generated; entries nginx rejected were dropped"
    grep '^allow ' "$R/allow.gen" | while IFS= read -r line; do
      printf '%s\ndeny all;\n' "$line" > "$R/allow.conf"
      if nginx -t >/dev/null 2>&1; then echo "$line"; else log "dropping entry nginx rejects: $line"; fi
    done
    echo "deny all;"
  } > "$R/allow.pruned"
  mv "$R/allow.pruned" "$R/allow.conf"
  nginx -t >&2
}

render || true
check_config
nginx -g 'daemon off;' &
NGINX_PID=$!
trap 'kill -QUIT "$NGINX_PID" 2>/dev/null || true' TERM INT

while kill -0 "$NGINX_PID" 2>/dev/null; do
  sleep 30 &
  wait $! || true
  kill -0 "$NGINX_PID" 2>/dev/null || break
  if render; then
    log "config changed — reloading nginx"
    if check_config; then nginx -s reload; else log "nginx -t failed; keeping running config"; fi
  fi
done
wait "$NGINX_PID"
