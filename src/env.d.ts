/// <reference types="vite/client" />
/// <reference lib="webworker" />

interface ImportMetaEnv {
  readonly PUBLIC_BASE_DOMAIN: string;
  readonly PUBLIC_SIGNAL_SERVER: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
