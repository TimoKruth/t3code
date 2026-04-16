import { createFileRoute } from "@tanstack/react-router";
import { type ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { NoActiveThreadState } from "../components/NoActiveThreadState";
import { EMBEDDED_MODE, EMBEDDED_THREAD_ID } from "../embedded";
import { useEmbeddedDraftThreadBootstrap } from "../hooks/useEmbeddedDraftThreadBootstrap";
import {
  selectBootstrapCompleteForActiveEnvironment,
  selectThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import { useSettings } from "~/hooks/useSettings";

function ChatIndexRouteView() {
  const navigate = useNavigate();
  const appSettings = useSettings();
  const bootstrapComplete = useStore(selectBootstrapCompleteForActiveEnvironment);
  const desiredThreadId = EMBEDDED_THREAD_ID;
  const matchingServerThread = useStore((store) => {
    if (!desiredThreadId) {
      return null;
    }
    return selectThreadsAcrossEnvironments(store).find((thread) => thread.id === desiredThreadId) ?? null;
  });
  const matchingDraftSession = useComposerDraftStore((store) => {
    if (!desiredThreadId) {
      return null;
    }
    for (const [draftId, draftThread] of Object.entries(store.draftThreadsByThreadKey)) {
      if (draftId === desiredThreadId || draftThread.threadId === desiredThreadId) {
        return DraftId.make(draftId);
      }
    }
    return null;
  });
  const routeThreadExists = matchingServerThread !== null || matchingDraftSession !== null;

  useEmbeddedDraftThreadBootstrap({
    bootstrapComplete,
    routeThreadExists,
    threadId: (desiredThreadId ?? "") as ThreadId,
    defaultThreadEnvMode: appSettings.defaultThreadEnvMode,
  });

  useEffect(() => {
    if (!EMBEDDED_MODE || !desiredThreadId) {
      return;
    }
    if (matchingServerThread) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          environmentId: matchingServerThread.environmentId,
          threadId: matchingServerThread.id,
        }),
        replace: true,
      });
      return;
    }
    if (matchingDraftSession) {
      void navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(matchingDraftSession),
        replace: true,
      });
    }
  }, [desiredThreadId, matchingDraftSession, matchingServerThread, navigate]);

  return <NoActiveThreadState />;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
