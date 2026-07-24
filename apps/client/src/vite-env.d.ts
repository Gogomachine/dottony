/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** База API; пустая строка — оффлайн-режим без сервера. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
