FROM node:20-alpine

# Instalar FFmpeg e curl (healthcheck)
RUN apk add --no-cache ffmpeg curl

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src ./src

EXPOSE 3000

USER node
CMD ["node", "src/server.js"]
