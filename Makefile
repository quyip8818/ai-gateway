.PHONY: build test start deploy

build:
	npm ci --prefix native
	npm run build

test:
	npm test

start:
	npm start

deploy:
	npm run deploy
