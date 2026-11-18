# Unprivileged nginx (uid 101, listens on >1024) + openssl (used only to mint a
# throwaway self-signed cert so nginx can boot before Let's Encrypt has issued
# the real one). Nothing in the final image runs as root.
FROM nginxinc/nginx-unprivileged:1.27-alpine
USER root
RUN apk add --no-cache openssl
USER 101
