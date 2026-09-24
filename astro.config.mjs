// @ts-check
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  security: {
    checkOrigin: false,
    allowedDomains: [
      { hostname: "yydoot.github.io" },
      { hostname: "*.trycloudflare.com" },
      { hostname: "doot.rocks" },
      { hostname: "localhost" }
    ],
  },

  server: {
    host: true,
    allowedHosts: [
      ".trycloudflare.com",
      "yydoot.github.io",
      "doot.rocks",
      "localhost",
    ],
  },
  vite: {
    server: {
      cors: true,
    },
  },
});

