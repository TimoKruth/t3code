import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { isElectron } from "../env";
import { useAppSettings } from "../appSettings";
import { resolveSidebarNewThreadEnvMode } from "../components/Sidebar.logic";
import { SidebarTrigger } from "../components/ui/sidebar";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useStore } from "../store";

const EMBEDDED_MODE = (() => {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("embedded") === "1") return true;
    const hash = window.location.hash;
    if (hash.includes("embedded=1")) return true;
    return false;
  } catch {
    return false;
  }
})();

function ChatIndexRouteView() {
  const { handleNewThread, projects } = useHandleNewThread();
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const { settings: appSettings } = useAppSettings();
  const attemptedProjectIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!EMBEDDED_MODE || !threadsHydrated) {
      return;
    }

    const projectId = projects[0]?.id;
    if (!projectId) {
      return;
    }

    if (attemptedProjectIdRef.current === projectId) {
      return;
    }
    attemptedProjectIdRef.current = projectId;

    void handleNewThread(projectId, {
      envMode: resolveSidebarNewThreadEnvMode({
        defaultEnvMode: appSettings.defaultThreadEnvMode,
      }),
    }).catch(() => {
      if (attemptedProjectIdRef.current === projectId) {
        attemptedProjectIdRef.current = null;
      }
    });
  }, [appSettings.defaultThreadEnvMode, handleNewThread, projects, threadsHydrated]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
      {!isElectron && (
        <header className="border-b border-border px-3 py-2 md:hidden">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0" />
            <span className="text-sm font-medium text-foreground">Threads</span>
          </div>
        </header>
      )}

      {isElectron && (
        <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
          <span className="text-xs text-muted-foreground/50">No active thread</span>
        </div>
      )}

      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <p className="text-sm">
            {EMBEDDED_MODE
              ? "Preparing a new chat..."
              : "Select a thread or create a new one to get started."}
          </p>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
