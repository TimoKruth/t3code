import { scopeProjectRef } from "@t3tools/client-runtime";
import {
  DEFAULT_RUNTIME_MODE,
  type ServerLifecycleWelcomePayload,
  type ThreadId,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { resolveSidebarNewThreadEnvMode } from "../components/Sidebar.logic";
import { type DraftThreadEnvMode, useComposerDraftStore } from "../composerDraftStore";
import { EMBEDDED_MODE, EMBEDDED_PROJECT_CWD, postThreadIdToHost } from "../embedded";
import { newDraftId } from "../lib/utils";
import { deriveLogicalProjectKey } from "../logicalProject";
import { useServerWelcomeSubscription } from "../rpc/serverState";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import { resolveEmbeddedBootstrapProjectId } from "./embeddedDraftThreadBootstrap";

export function useEmbeddedDraftThreadBootstrap(input: {
  readonly bootstrapComplete: boolean;
  readonly routeThreadExists: boolean;
  readonly threadId: ThreadId;
  readonly defaultThreadEnvMode: DraftThreadEnvMode;
}): void {
  const { bootstrapComplete, routeThreadExists, threadId, defaultThreadEnvMode } = input;
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const [latestWelcome, setLatestWelcome] = useState<ServerLifecycleWelcomePayload | null>(null);
  const normalizedThreadId = threadId.trim();

  useServerWelcomeSubscription(setLatestWelcome);

  useEffect(() => {
    if (normalizedThreadId.length === 0) {
      return;
    }
    postThreadIdToHost(normalizedThreadId);
  }, [normalizedThreadId]);

  useEffect(() => {
    if (
      !bootstrapComplete ||
      !EMBEDDED_MODE ||
      routeThreadExists ||
      normalizedThreadId.length === 0
    ) {
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

    const project = projects.find((p) => p.id === projectId);
    if (!project) {
      return;
    }

    const projectRef = scopeProjectRef(project.environmentId, projectId);
    const logicalProjectKey = deriveLogicalProjectKey(project);
    const draftId = newDraftId();

    useComposerDraftStore.getState().setLogicalProjectDraftThreadId(
      logicalProjectKey,
      projectRef,
      draftId,
      {
        threadId: normalizedThreadId as ThreadId,
        createdAt: new Date().toISOString(),
        envMode: resolveSidebarNewThreadEnvMode({
          defaultEnvMode: defaultThreadEnvMode,
        }),
        runtimeMode: DEFAULT_RUNTIME_MODE,
      },
    );
  }, [
    bootstrapComplete,
    defaultThreadEnvMode,
    latestWelcome,
    normalizedThreadId,
    projects,
    routeThreadExists,
  ]);
}
