/// <reference types="vite/client" />

// Vite exposes build-time variables through `import.meta.env`; without this
// reference `import.meta.env.PROD` does not type-check.
interface ImportMetaEnv {
  readonly PROD: boolean;
  readonly DEV: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
