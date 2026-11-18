# nginx + openssl (used only to mint a throwaway self-signed cert so nginx can
# boot before Let's Encrypt has issued the real one).
FROM nginx:1.27-alpine
RUN apk add --no-cache openssl
