FROM node:24-alpine

LABEL org.opencontainers.image.title="zed-deepseek-budget" \
      org.opencontainers.image.description="Daily CNY budget proxy for the native Zed Agent's official DeepSeek provider" \
      org.opencontainers.image.authors="Gennady Artamonov" \
      org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DAILY_LIMIT_CNY=15 \
    USD_TO_CNY=7.2 \
    STATE_FILE=/data/daily-budget.json \
    LOG_FILE=/data/zed-agent-budget.log

WORKDIR /app

COPY package.json ./
COPY server.mjs ./
COPY config.json ./
COPY lib ./lib

RUN mkdir -p /data && chown -R node:node /app /data

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null || exit 1

CMD ["node", "server.mjs"]
