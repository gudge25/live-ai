#!/bin/sh
# Obtains the Let's Encrypt cert via the HTTP-01 webroot challenge served by
# nginx on :80, then tries to renew twice a day (certbot only renews when the
# cert is within 30 days of expiry). nginx notices the new cert on its own.
set -u

DOMAIN="${PUBLIC_DOMAIN:?PUBLIC_DOMAIN is required}"
EMAIL="${LETSENCRYPT_EMAIL:-}"
WEBROOT=/var/www/certbot
NGINX_CERTS=/nginx-certs      # volume shared (read-only) with the unprivileged nginx
NGINX_UID="${NGINX_UID:-101}"

# certbot keeps privkey.pem root-only; nginx runs as uid 101, so hand it its own
# copy. Run by certbot after every issuance/renewal, and once at startup below.
cat > /tmp/deploy-hook.sh <<'HOOK'
#!/bin/sh
set -eu
src="${RENEWED_LINEAGE:?}"
for f in fullchain.pem privkey.pem; do
  cp -L "$src/$f" "$NGINX_CERTS/.$f.new"
  chown "$NGINX_UID:$NGINX_UID" "$NGINX_CERTS/.$f.new"
  chmod 600 "$NGINX_CERTS/.$f.new"
  mv "$NGINX_CERTS/.$f.new" "$NGINX_CERTS/$f"
done
echo "[certbot] copied renewed certificate for nginx" >&2
HOOK
chmod +x /tmp/deploy-hook.sh
export NGINX_CERTS NGINX_UID

extra=""
if [ "${LETSENCRYPT_STAGING:-false}" = "true" ]; then extra="$extra --staging"; fi
if [ -n "$EMAIL" ]; then
  extra="$extra --email $EMAIL"
else
  echo "[certbot] LETSENCRYPT_EMAIL is empty — registering without an email (no expiry notices)" >&2
  extra="$extra --register-unsafely-without-email"
fi

# Cert already issued earlier (e.g. nginx-certs volume was recreated): re-copy it.
if [ -s "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  RENEWED_LINEAGE="/etc/letsencrypt/live/$DOMAIN" /tmp/deploy-hook.sh || echo "[certbot] initial copy failed" >&2
fi

sleep 5  # let nginx come up and start serving /.well-known/acme-challenge/
while true; do
  if [ -s "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    certbot renew --webroot -w "$WEBROOT" --non-interactive --deploy-hook /tmp/deploy-hook.sh || echo "[certbot] renew failed" >&2
    sleep 12h
  else
    # shellcheck disable=SC2086
    if certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" --agree-tos --no-eff-email --non-interactive --deploy-hook /tmp/deploy-hook.sh $extra; then
      sleep 12h
    else
      echo "[certbot] issuance failed (is $DOMAIN resolving here and port 80 open?) — retrying in 15 min" >&2
      sleep 15m
    fi
  fi
done
