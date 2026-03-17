# Debian (glibc) necessário para onnxruntime-node usado pelo @huggingface/transformers (Whisper)
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg curl \
  && rm -rf /var/lib/apt/lists/* \
  && which ffmpeg \
  && ffmpeg -version | head -1

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

# Permissão para node escrever (cache do Transformers.js em node_modules e HF_HOME)
ENV HF_HOME=/app/.cache/huggingface
RUN mkdir -p /app/.cache/huggingface && chown -R node:node /app

EXPOSE 3000

# Health check: GET /health na mesma porta do app (PORT ou 3000)
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD sh -c "curl -f http://localhost:${PORT:-3000}/health || exit 1"

USER node
CMD ["node", "src/server.js"]
