/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** CI 建置時填入的 commit SHA（見 .github/workflows/deploy.yml）。 */
  readonly VITE_BUILD_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
