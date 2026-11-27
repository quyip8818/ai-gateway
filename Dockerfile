FROM node:24-alpine AS build
WORKDIR /app
COPY native/package*.json ./
RUN npm ci
COPY native/ ./
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
RUN apk add --no-cache ca-certificates chromium nss freetype harfbuzz ttf-freefont \
    && mkdir -p /data/media && chown -R node:node /data
WORKDIR /app
COPY --from=build /app/package.json /app/console.html /app/console.js ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/SOURCES.md /app/src/providers/jimeng/LICENSE ./licenses/jimeng/
COPY --from=build /app/src/providers/codex/LICENSE /app/src/providers/codex/NOTICE ./licenses/codex/
COPY --from=build /app/src/providers/kiro/LICENSE ./licenses/kiro/
COPY --from=build /app/node_modules ./node_modules
ENV NODE_ENV=production PORT=8080 MEDIA_DIRECTORY=/data/media \
    JIMENG_BROWSER_EXECUTABLE=/usr/bin/chromium-browser \
    JIMENG_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
