FROM node:20-alpine

# Instalar FFmpeg e curl (healthcheck)
RUN apk add --no-cache ffmpeg curl \
  && which ffmpeg \
  && ffmpeg -version | head -1

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 3000

# Health check: GET /health na mesma porta do app (PORT ou 3000)
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD sh -c "curl -f http://localhost:${PORT:-3000}/health || exit 1"

USER node
CMD ["node", "src/server.js"]
