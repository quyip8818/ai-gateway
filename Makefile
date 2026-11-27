.PHONY: build test start deploy

build:
	npm ci
	npm run build

test:
	npm test

start:
	npm start

deploy:
	npm run deploy
