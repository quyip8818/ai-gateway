.PHONY: ui build test
ui:
	cd frontend && npm ci && npm run build
	mkdir -p backend/internal/app/ui/dist
	cp -R frontend/dist/. backend/internal/app/ui/dist/

build: ui
	cd backend && go build ./cmd/gateway ./cmd/gatewayctl

test:
	cd backend && go test ./...
