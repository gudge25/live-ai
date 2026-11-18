#!/bin/sh
# Obtains the Let's Encrypt cert via the HTTP-01 webroot challenge served by
# nginx on :80, then tries to renew twice a day (certbot only renews when the
# cert is within 30 days of expiry). nginx notices the new cert on its own.
set -u

DOMAIN="${PUBLIC_DOMAIN:?PUBLIC_DOMAIN is required}"
EMAIL="${LETSENCRYPT_EMAIL:-}"
WEBROOT=/var/www/certbot

extra=""
if [ "${LETSENCRYPT_STAGING:-false}" = "true" ]; then extra="$extra --staging"; fi
if [ -n "$EMAIL" ]; then
  extra="$extra --email $EMAIL"
else
  echo "[certbot] LETSENCRYPT_EMAIL is empty — registering without an email (no expiry notices)" >&2
  extra="$extra --register-unsafely-without-email"
fi

sleep 5  # let nginx come up and start serving /.well-known/acme-challenge/
while true; do
  if [ -s "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    certbot renew --webroot -w "$WEBROOT" --non-interactive || echo "[certbot] renew failed" >&2
    sleep 12h
  else
    # shellcheck disable=SC2086
    if certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" --agree-tos --no-eff-email --non-interactive $extra; then
      sleep 12h
    else
      echo "[certbot] issuance failed (is $DOMAIN resolving here and port 80 open?) — retrying in 15 min" >&2
      sleep 15m
    fi
  fi
done
