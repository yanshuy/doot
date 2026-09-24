# Doot

Monorepo containing the Doot Web Application and Signaling Server.

## 🚀 Repository Structure

```text
/
├── signaling-server/          # Bun WebSocket & HTTP signaling server
│   ├── index.ts               # Server entrypoint
│   ├── src/                   # Message handlers, error constants, state
│   └── test/                  # Bun tests (signaling.test.ts)
│
├── web/                       # Astro web application
│   ├── astro.config.mjs       # Astro & Vite configuration
│   ├── public/                # Static assets & generated service worker
│   └── src/                   # Astro pages, components, & WebRTC transfer logic
│
├── package.json               # Root scripts & orchestrator
├── pnpm-workspace.yaml        # Workspace configuration
└── pnpm-lock.yaml             # Single workspace lockfile
```

## 🧞 Commands

All commands are run from the root of the project using `pnpm`:

| Command | Action |
| :--- | :--- |
| `pnpm install` | Installs dependencies for all workspace packages |
| `pnpm dev` | Starts **both** Web App (`localhost:4321`) & Signaling Server (`ws://localhost:3333`) concurrently |
| `pnpm run dev:web` | Starts the Astro dev server only |
| `pnpm run dev:signal` | Starts the Bun signaling server only |
| `pnpm build` | Bundles the service worker and builds the web app to `web/dist/` |
| `pnpm test` | Runs signaling server test suite with Bun |
