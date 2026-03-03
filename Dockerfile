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

USER node
CMD ["node", "src/server.js"]
