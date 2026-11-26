FROM node:24-alpine AS frontend
WORKDIR /src/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM golang:1.26-alpine AS backend
WORKDIR /src/backend
COPY backend/go.* ./
RUN go mod download
COPY backend/ ./
RUN rm -rf internal/app/ui/dist
COPY --from=frontend /src/frontend/dist ./internal/app/ui/dist
RUN CGO_ENABLED=0 go build -o /out/gateway ./cmd/gateway && CGO_ENABLED=0 go build -o /out/gatewayctl ./cmd/gatewayctl

FROM alpine:3.23
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 gateway && mkdir -p /data/media && chown -R gateway /data
COPY --from=backend /out/ /usr/local/bin/
USER gateway
EXPOSE 8080
CMD ["gateway"]
