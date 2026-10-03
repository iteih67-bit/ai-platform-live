# Zero-dependency runtime image (no build step needed).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 LEDGER_PATH=/data/ledger.jsonl
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
RUN mkdir -p /data && adduser -D -u 10001 appuser && chown -R appuser:appuser /app /data
USER appuser
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.js"]
