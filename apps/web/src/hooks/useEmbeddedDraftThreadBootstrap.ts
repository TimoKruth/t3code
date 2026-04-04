import {
  DEFAULT_RUNTIME_MODE,
  type ServerLifecycleWelcomePayload,
  type ThreadId,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { resolveSidebarNewThreadEnvMode } from "../components/Sidebar.logic";
import { type DraftThreadEnvMode, useComposerDraftStore } from "../composerDraftStore";
import { EMBEDDED_MODE, EMBEDDED_PROJECT_CWD, postThreadIdToHost } from "../embedded";
import { useServerWelcomeSubscription } from "../rpc/serverState";
import { useStore } from "../store";
import { resolveEmbeddedBootstrapProjectId } from "./embeddedDraftThreadBootstrap";

export function useEmbeddedDraftThreadBootstrap(input: {
  readonly bootstrapComplete: boolean;
  readonly routeThreadExists: boolean;
  readonly threadId: ThreadId;
  readonly defaultThreadEnvMode: DraftThreadEnvMode;
}): void {
  const { bootstrapComplete, routeThreadExists, threadId, defaultThreadEnvMode } = input;
  const projects = useStore((store) => store.projects);
  const [latestWelcome, setLatestWelcome] = useState<ServerLifecycleWelcomePayload | null>(null);

  useServerWelcomeSubscription(setLatestWelcome);

  useEffect(() => {
    postThreadIdToHost(threadId);
  }, [threadId]);

  useEffect(() => {
    if (!bootstrapComplete || !EMBEDDED_MODE || routeThreadExists) {
      return;
    }

    const projectId = resolveEmbeddedBootstrapProjectId({
      projects,
      latestWelcome,
      embeddedProjectCwd: EMBEDDED_PROJECT_CWD,
    });
    if (!projectId) {
      return;
    }

    useComposerDraftStore.getState().ensureDraftThread(threadId, {
      projectId,
      createdAt: new Date().toISOString(),
      envMode: resolveSidebarNewThreadEnvMode({
        defaultEnvMode: defaultThreadEnvMode,
      }),
      runtimeMode: DEFAULT_RUNTIME_MODE,
      branch: null,
      worktreePath: null,
    });
  }, [bootstrapComplete, defaultThreadEnvMode, latestWelcome, projects, routeThreadExists, threadId]);
}
