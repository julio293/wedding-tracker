FROM node:24-slim

# Chromium + fonts for whatsapp-web.js (headless WhatsApp Web)
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-noto-color-emoji fonts-liberation ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium \
    DATA_DIR=/data \
    PORT=3000 \
    TZ=Asia/Makassar

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public

# /data holds the SQLite DB, receipt photos and the WhatsApp session — mount a persistent volume there
EXPOSE 3000
CMD ["node", "src/index.js"]
