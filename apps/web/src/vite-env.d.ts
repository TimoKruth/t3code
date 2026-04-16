/// <reference types="vite/client" />

import type { DesktopBridge, LocalApi } from "@t3tools/contracts";

interface ImportMetaEnv {
  readonly APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    __CMUX_EMBEDDED__?: boolean;
    nativeApi?: LocalApi;
    desktopBridge?: DesktopBridge;
  }
}
