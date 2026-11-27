FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY build.mjs ./
COPY app/ ./app/
COPY shared/ ./shared/
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ARG ALPINE_MIRROR
RUN if [ -n "$ALPINE_MIRROR" ]; then \
      sed -i "s|https://dl-cdn.alpinelinux.org/alpine|$ALPINE_MIRROR|g" /etc/apk/repositories; \
    fi \
    && apk add --no-cache ca-certificates chromium nss freetype harfbuzz ttf-freefont \
    && mkdir -p /data/media && chown -R node:node /data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/app/backend/SOURCES.md ./licenses/
COPY --from=build /app/app/backend/src/providers/jimeng/LICENSE ./licenses/jimeng/
COPY --from=build /app/app/backend/src/providers/codex/LICENSE /app/app/backend/src/providers/codex/NOTICE ./licenses/codex/
COPY --from=build /app/app/backend/src/providers/kiro/LICENSE ./licenses/kiro/
COPY --from=build /app/node_modules ./node_modules
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 MEDIA_DIRECTORY=/data/media \
    JIMENG_BROWSER_EXECUTABLE=/usr/bin/chromium-browser \
    JIMENG_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
