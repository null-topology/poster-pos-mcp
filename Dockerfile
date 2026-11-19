# poster-rush MCP · imagen para Cloud Run
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
# npm ci builds dist through the prepare script
RUN npm ci && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production TOKEN_SOURCE=gsm AUDIT_DIR=/tmp/audit
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
# Cloud Run inyecta PORT (8080); el server solo bindea ese puerto
CMD ["node", "dist/server.js"]
