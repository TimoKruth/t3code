import type { NativeApi } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createWsNativeApiMock = vi.fn<() => NativeApi>();

vi.mock("./wsNativeApi", () => ({
  createWsNativeApi: createWsNativeApiMock,
}));

import { readNativeApi, resetNativeApiForTests } from "./nativeApi";

function getProcessEnvForTest(): Record<string, string | undefined> {
  const testGlobal = globalThis as typeof globalThis & {
    __T3CODE_TEST_ENV__?: Record<string, string | undefined>;
  };
  if (!testGlobal.__T3CODE_TEST_ENV__) {
    testGlobal.__T3CODE_TEST_ENV__ = {};
  }
  return testGlobal.__T3CODE_TEST_ENV__;
}

function getWindowForTest(): Window & typeof globalThis & { nativeApi?: NativeApi } {
  const testGlobal = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis & { nativeApi?: NativeApi };
  };
  if (!testGlobal.window) {
    testGlobal.window = { location: { hostname: "localhost", port: "5733" } } as Window &
      typeof globalThis & { nativeApi?: NativeApi };
  }
  return testGlobal.window;
}

const originalWsUrl = getProcessEnvForTest().VITE_WS_URL;

describe("nativeApi", () => {
  beforeEach(() => {
    resetNativeApiForTests();
    createWsNativeApiMock.mockReset();
    const env = getProcessEnvForTest();
    if (originalWsUrl === undefined) {
      delete env.VITE_WS_URL;
    } else {
      env.VITE_WS_URL = originalWsUrl;
    }
    Reflect.deleteProperty(getWindowForTest(), "nativeApi");
    Reflect.deleteProperty(getWindowForTest(), "desktopBridge");
  });

  afterEach(() => {
    resetNativeApiForTests();
    vi.restoreAllMocks();
    const env = getProcessEnvForTest();
    if (originalWsUrl === undefined) {
      delete env.VITE_WS_URL;
    } else {
      env.VITE_WS_URL = originalWsUrl;
    }
  });

  it("uses the desktop native api when no explicit websocket override exists", () => {
    const desktopApi = {
      orchestration: {},
    } as NativeApi;
    Object.defineProperty(getWindowForTest(), "nativeApi", {
      configurable: true,
      writable: true,
      value: desktopApi,
    });

    expect(readNativeApi()).toBe(desktopApi);
    expect(createWsNativeApiMock).not.toHaveBeenCalled();
  });

  it("still prefers the desktop native api when running inside Electron", () => {
    getProcessEnvForTest().VITE_WS_URL = "ws://localhost:3773/?token=dev-token";

    const desktopApi = {
      orchestration: {},
    } as NativeApi;
    Object.defineProperty(getWindowForTest(), "nativeApi", {
      configurable: true,
      writable: true,
      value: desktopApi,
    });

    expect(readNativeApi()).toBe(desktopApi);
    expect(createWsNativeApiMock).not.toHaveBeenCalled();
  });

  it("uses the websocket api in a plain browser tab when VITE_WS_URL is configured", () => {
    getProcessEnvForTest().VITE_WS_URL = "ws://localhost:3773/?token=dev-token";

    const wsApi = {
      orchestration: {},
    } as NativeApi;
    createWsNativeApiMock.mockReturnValue(wsApi);

    expect(readNativeApi()).toBe(wsApi);
    expect(createWsNativeApiMock).toHaveBeenCalledTimes(1);
  });
});
