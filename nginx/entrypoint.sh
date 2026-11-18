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

R=/etc/nginx/rendered
DUMMY=/etc/nginx/dummy
DNS_CACHE=/var/cache/pbx-dns
REAL=/etc/letsencrypt/live/$DOMAIN
mkdir -p "$R" "$DUMMY" "$DNS_CACHE"

log() { echo "[entrypoint] $*" >&2; }

if [ ! -s "$DUMMY/key.pem" ]; then
  log "generating self-signed placeholder certificate for $DOMAIN"
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -subj "/CN=$DOMAIN" -keyout "$DUMMY/key.pem" -out "$DUMMY/cert.pem" 2>/dev/null
fi

valid_ip()   { printf '%s' "$1" | grep -Eq '^[0-9A-Fa-f:.]+(/[0-9]{1,3})?$'; }
valid_host() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'; }

# Replace $2 with $1 only if different; echo "1" when it changed.
install_if_changed() {
  if [ -f "$2" ] && cmp -s "$1" "$2"; then rm -f "$1"; return 1; fi
  mv "$1" "$2"; return 0
}

render() {
  changed=1  # 1 = nothing changed (shell convention: 0 = true)

  # ---- TLS include ----
  if [ -s "$REAL/fullchain.pem" ] && [ -s "$REAL/privkey.pem" ]; then
    crt="$REAL/fullchain.pem"; key="$REAL/privkey.pem"
    # Renewal swaps file content behind the same symlink path: fold its
    # checksum into the include so a new cert also counts as a change.
    sig=$(cksum "$crt" | cut -d' ' -f1,2)
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
  if install_if_changed "$R/allow.conf.new" "$R/allow.conf"; then changed=0; fi

  return $changed
}

render || true
nginx -t >&2
nginx -g 'daemon off;' &
NGINX_PID=$!
trap 'kill -QUIT "$NGINX_PID" 2>/dev/null || true' TERM INT

while kill -0 "$NGINX_PID" 2>/dev/null; do
  sleep 30 &
  wait $! || true
  kill -0 "$NGINX_PID" 2>/dev/null || break
  if render; then
    log "config changed — reloading nginx"
    if nginx -t >&2; then nginx -s reload; else log "nginx -t failed; keeping running config"; fi
  fi
done
wait "$NGINX_PID"
