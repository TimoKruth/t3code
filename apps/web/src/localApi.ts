import type { ContextMenuItem, LocalApi } from "@t3tools/contracts";

import { resetGitStatusStateForTests } from "./lib/gitStatusState";
import { resetRequestLatencyStateForTests } from "./rpc/requestLatencyState";
import { resetServerStateForTests } from "./rpc/serverState";
import { resetWsConnectionStateForTests } from "./rpc/wsConnectionState";
import {
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
} from "./environments/runtime";
import {
  getPrimaryEnvironmentConnection,
  resetEnvironmentServiceForTests,
} from "./environments/runtime";
import { type WsRpcClient } from "./rpc/wsRpcClient";
import { showContextMenuFallback } from "./contextMenuFallback";
import {
  readBrowserClientSettings,
  readBrowserSavedEnvironmentRegistry,
  readBrowserSavedEnvironmentSecret,
  removeBrowserSavedEnvironmentSecret,
  writeBrowserClientSettings,
  writeBrowserSavedEnvironmentRegistry,
  writeBrowserSavedEnvironmentSecret,
} from "./clientPersistenceStorage";

let cachedApi: LocalApi | undefined;

function readDesktopBridge() {
  return typeof window !== "undefined" ? window.desktopBridge : undefined;
}

export function createLocalApi(rpcClient: WsRpcClient): LocalApi {
  return {
    dialogs: {
      pickFolder: async (options) => {
        const bridge = readDesktopBridge();
        if (typeof bridge?.pickFolder !== "function") return null;
        return bridge.pickFolder(options);
      },
      confirm: async (message) => {
        const bridge = readDesktopBridge();
        if (typeof bridge?.confirm === "function") {
          return bridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    shell: {
      openInEditor: (cwd, editor) => rpcClient.shell.openInEditor({ cwd, editor }),
      openExternal: async (url) => {
        const bridge = readDesktopBridge();
        if (typeof bridge?.openExternal === "function") {
          const opened = await bridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        const bridge = readDesktopBridge();
        if (typeof bridge?.showContextMenu === "function") {
          return bridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    persistence: {
      getClientSettings: async () => {
        const bridge = readDesktopBridge();
        if (typeof bridge?.getClientSettings === "function") {
          return bridge.getClientSettings();
        }
        return readBrowserClientSettings();
      },
      setClientSettings: async (settings) => {
        const bridge = readDesktopBridge();
        if (typeof bridge?.setClientSettings === "function") {
          return bridge.setClientSettings(settings);
        }
        writeBrowserClientSettings(settings);
      },
      getSavedEnvironmentRegistry: async () => {
        const bridge = readDesktopBridge();
        if (typeof bridge?.getSavedEnvironmentRegistry === "function") {
          return bridge.getSavedEnvironmentRegistry();
        }
        return readBrowserSavedEnvironmentRegistry();
      },
      setSavedEnvironmentRegistry: async (records) => {
        const bridge = readDesktopBridge();
        if (typeof bridge?.setSavedEnvironmentRegistry === "function") {
          return bridge.setSavedEnvironmentRegistry(records);
        }
        writeBrowserSavedEnvironmentRegistry(records);
      },
      getSavedEnvironmentSecret: async (environmentId) => {
        const bridge = readDesktopBridge();
        if (typeof bridge?.getSavedEnvironmentSecret === "function") {
          return bridge.getSavedEnvironmentSecret(environmentId);
        }
        return readBrowserSavedEnvironmentSecret(environmentId);
      },
      setSavedEnvironmentSecret: async (environmentId, secret) => {
        const bridge = readDesktopBridge();
        if (typeof bridge?.setSavedEnvironmentSecret === "function") {
          return bridge.setSavedEnvironmentSecret(environmentId, secret);
        }
        return writeBrowserSavedEnvironmentSecret(environmentId, secret);
      },
      removeSavedEnvironmentSecret: async (environmentId) => {
        const bridge = readDesktopBridge();
        if (typeof bridge?.removeSavedEnvironmentSecret === "function") {
          return bridge.removeSavedEnvironmentSecret(environmentId);
        }
        removeBrowserSavedEnvironmentSecret(environmentId);
      },
    },
    server: {
      getConfig: rpcClient.server.getConfig,
      refreshProviders: rpcClient.server.refreshProviders,
      upsertKeybinding: rpcClient.server.upsertKeybinding,
      getSettings: rpcClient.server.getSettings,
      updateSettings: rpcClient.server.updateSettings,
    },
  };
}

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  if (window.nativeApi) {
    cachedApi = window.nativeApi;
    return cachedApi;
  }

  cachedApi = createLocalApi(getPrimaryEnvironmentConnection().client);
  return cachedApi;
}

export function ensureLocalApi(): LocalApi {
  const api = readLocalApi();
  if (!api) {
    throw new Error("Local API not found");
  }
  return api;
}

export async function __resetLocalApiForTests() {
  cachedApi = undefined;
  const { __resetClientSettingsPersistenceForTests } = await import("./hooks/useSettings");
  __resetClientSettingsPersistenceForTests();
  await resetEnvironmentServiceForTests();
  resetGitStatusStateForTests();
  resetRequestLatencyStateForTests();
  resetSavedEnvironmentRegistryStoreForTests();
  resetSavedEnvironmentRuntimeStoreForTests();
  resetServerStateForTests();
  resetWsConnectionStateForTests();
}
