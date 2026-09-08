FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

RUN mkdir -p /app/data/jobs && chown -R node:node /app
USER node

EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server.js"]