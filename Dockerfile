FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN mkdir -p /data/conversations /data/meta-intake && chown -R node:node /data

USER node
ENV NODE_ENV=production PORT=3000 STATE_DIR=/data/conversations META_INTAKE_DIR=/data/meta-intake AUDIT_LOG_PATH=/data/audit.jsonl
EXPOSE 3000
CMD ["node", "src/server.ts"]
