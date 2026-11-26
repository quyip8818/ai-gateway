import { defineConfig } from "vite";
export default defineConfig({
  server: {
    proxy: {
      "/console": "http://localhost:8080",
      "/media/v1": "http://localhost:8080",
      "/openai/v1": "http://localhost:8080",
      "/anthropic/v1": "http://localhost:8080",
    },
  },
});
