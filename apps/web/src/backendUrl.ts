function readProcessEnvWsUrl(): string | null {
  const testEnv = (
    globalThis as typeof globalThis & {
      __T3CODE_TEST_ENV__?: Record<string, string | undefined>;
    }
  ).__T3CODE_TEST_ENV__;
  const testEnvUrl = testEnv?.VITE_WS_URL;
  if (typeof testEnvUrl === "string") {
    const trimmed = testEnvUrl.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  const processEnv = (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  const envUrl = processEnv?.VITE_WS_URL;
  if (typeof envUrl !== "string") {
    return null;
  }
  const trimmed = envUrl.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readEnvWsUrl(): string | null {
  const envUrl =
    (typeof import.meta.env.VITE_WS_URL === "string" ? import.meta.env.VITE_WS_URL : undefined) ??
    readProcessEnvWsUrl();
  if (typeof envUrl !== "string") {
    return null;
  }
  const trimmed = envUrl.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasDesktopBridge(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.desktopBridge !== undefined || window.nativeApi !== undefined;
}

function readBridgeWsUrl(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const bridgeUrl = window.desktopBridge?.getWsUrl?.();
  if (typeof bridgeUrl !== "string") {
    return null;
  }
  const trimmed = bridgeUrl.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function shouldPreferConfiguredWebSocket(): boolean {
  return readEnvWsUrl() !== null && !hasDesktopBridge();
}

export function resolvePreferredWebSocketUrl(): string | null {
  const bridgeWsUrl = readBridgeWsUrl();
  if (bridgeWsUrl !== null) {
    return bridgeWsUrl;
  }
  return readEnvWsUrl();
}

export function resolveDefaultWebSocketUrl(): string {
  return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`;
}

export function resolveWebSocketUrl(explicitUrl?: string): string {
  return explicitUrl ?? resolvePreferredWebSocketUrl() ?? resolveDefaultWebSocketUrl();
}

export function resolveHttpOriginFromWebSocketUrl(): string {
  const wsUrl = resolvePreferredWebSocketUrl();
  if (!wsUrl) {
    return window.location.origin;
  }

  try {
    const parsed = new URL(wsUrl);
    const protocol =
      parsed.protocol === "wss:" ? "https:" : parsed.protocol === "ws:" ? "http:" : parsed.protocol;
    return `${protocol}//${parsed.host}`;
  } catch {
    return window.location.origin;
  }
}
