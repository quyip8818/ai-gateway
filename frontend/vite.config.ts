import { defineConfig, normalizePath } from "vite";

const reactRouterClientEntry =
  /(?:^|\/)node_modules\/react-router\/dist\/(?:development|production)\/(?:index|dom-export)\.mjs$/;

export default defineConfig({
  build: {
    rolldownOptions: {
      onLog(level, log, handler) {
        // The console renders in the browser and has no React Server Component boundaries.
        if (
          level === "warn" &&
          log.code === "MODULE_LEVEL_DIRECTIVE" &&
          log.message.includes('directive "use client"') &&
          reactRouterClientEntry.test(normalizePath(log.id ?? ""))
        ) {
          return;
        }
        handler(level, log);
      },
    },
  },
  server: {
    proxy: {
      "/console": "http://localhost:8080",
      "/media/v1": "http://localhost:8080",
      "/openai/v1": "http://localhost:8080",
      "/anthropic/v1": "http://localhost:8080",
    },
  },
});
