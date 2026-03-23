import { ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildExpiredTerminalContextToastCopy,
  deriveComposerSendState,
  isProviderSelectionLocked,
} from "./ChatView.logic";
import type { Thread } from "../types";

function buildThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: "project-1" as Thread["projectId"],
    title: "Thread",
    model: "gpt-5.4",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-20T10:00:00.000Z",
    latestTurn: null,
    lastVisitedAt: "2026-03-20T10:00:00.000Z",
    branch: "main",
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats clear empty-state guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
  });

  it("formats omission guidance for sent messages", () => {
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("isProviderSelectionLocked", () => {
  it("does not lock a pristine thread that only has a ready session", () => {
    expect(
      isProviderSelectionLocked(
        buildThread({
          session: {
            provider: "codex",
            status: "ready",
            createdAt: "2026-03-20T10:00:00.000Z",
            updatedAt: "2026-03-20T10:00:00.000Z",
            orchestrationStatus: "ready",
          },
        }),
      ),
    ).toBe(false);
  });

  it("locks after the thread has a turn in progress", () => {
    expect(
      isProviderSelectionLocked(
        buildThread({
          session: {
            provider: "claudeCode",
            status: "running",
            activeTurnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-03-20T10:00:00.000Z",
            updatedAt: "2026-03-20T10:00:01.000Z",
            orchestrationStatus: "running",
          },
        }),
      ),
    ).toBe(true);
  });

  it("locks after the thread has existing messages", () => {
    expect(
      isProviderSelectionLocked(
        buildThread({
          messages: [
            {
              id: "message-1" as never,
              role: "user",
              text: "hello",
              createdAt: "2026-03-20T10:00:00.000Z",
              streaming: false,
            },
          ],
        }),
      ),
    ).toBe(true);
  });
});
