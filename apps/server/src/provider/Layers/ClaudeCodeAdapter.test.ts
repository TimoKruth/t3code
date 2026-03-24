import assert from "node:assert/strict";

import { ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, vi } from "vitest";

import { ClaudeCodeAdapter } from "../Services/ClaudeCodeAdapter.ts";
import { makeClaudeCodeAdapterLive } from "./ClaudeCodeAdapter.ts";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

function makeMockQuery(permissionMode: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "system",
        subtype: "init",
        session_id: "claude-session-1",
        cwd: "/repo",
        model: "claude-sonnet-4-6",
        tools: ["Read", "Edit", "Write"],
        permissionMode,
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
      };
    },
    close: vi.fn(),
    interrupt: vi.fn(async () => undefined),
  };
}

const layer = it.layer(makeClaudeCodeAdapterLive());

afterEach(() => {
  queryMock.mockReset();
});

layer("ClaudeCodeAdapterLive permission config", (it) => {
  it.effect("uses default permission flow for approval-required turns", () =>
    Effect.gen(function* () {
      queryMock.mockImplementation((params: { options?: { permissionMode?: string } }) =>
        makeMockQuery(params.options?.permissionMode),
      );

      const adapter = yield* ClaudeCodeAdapter;
      yield* adapter.startSession({
        provider: "claudeCode",
        threadId: asThreadId("thread-approval"),
        cwd: "/repo",
        runtimeMode: "approval-required",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-approval"),
        input: "Edit a file",
        attachments: [],
      });

      const options = queryMock.mock.calls[0]?.[0]?.options;
      assert.equal(options?.permissionMode, "default");
      assert.equal(options?.allowDangerouslySkipPermissions, undefined);
      assert.equal(typeof options?.canUseTool, "function");
    }),
  );

  it.effect("uses bypass permissions for full-access turns", () =>
    Effect.gen(function* () {
      queryMock.mockImplementation((params: { options?: { permissionMode?: string } }) =>
        makeMockQuery(params.options?.permissionMode),
      );

      const adapter = yield* ClaudeCodeAdapter;
      yield* adapter.startSession({
        provider: "claudeCode",
        threadId: asThreadId("thread-full-access"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-full-access"),
        input: "Edit a file without approvals",
        attachments: [],
      });

      const options = queryMock.mock.calls[0]?.[0]?.options;
      assert.equal(options?.permissionMode, "bypassPermissions");
      assert.equal(options?.allowDangerouslySkipPermissions, true);
      assert.equal(options?.canUseTool, undefined);
    }),
  );

  it.effect("defaults to approval-required with canUseTool and all setting sources", () =>
    Effect.gen(function* () {
      queryMock.mockImplementation((params: { options?: { permissionMode?: string } }) =>
        makeMockQuery(params.options?.permissionMode),
      );

      const adapter = yield* ClaudeCodeAdapter;
      yield* adapter.startSession({
        provider: "claudeCode",
        threadId: asThreadId("thread-default"),
        cwd: "/repo",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-default"),
        input: "Do something",
        attachments: [],
      });

      const options = queryMock.mock.calls[0]?.[0]?.options;
      assert.equal(options?.permissionMode, "default");
      assert.equal(typeof options?.canUseTool, "function");
      assert.equal(options?.allowDangerouslySkipPermissions, undefined);

      const sessionOptions = queryMock.mock.calls[0]?.[0]?.options;
      assert.deepEqual(sessionOptions?.settingSources, ["user", "project", "local"]);
    }),
  );

  it.effect("keeps plan turns in plan mode even for full-access sessions", () =>
    Effect.gen(function* () {
      queryMock.mockImplementation((params: { options?: { permissionMode?: string } }) =>
        makeMockQuery(params.options?.permissionMode),
      );

      const adapter = yield* ClaudeCodeAdapter;
      yield* adapter.startSession({
        provider: "claudeCode",
        threadId: asThreadId("thread-plan"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-plan"),
        input: "Make a plan only",
        attachments: [],
        interactionMode: "plan",
      });

      const options = queryMock.mock.calls[0]?.[0]?.options;
      assert.equal(options?.permissionMode, "plan");
      assert.equal(options?.allowDangerouslySkipPermissions, undefined);
      assert.equal(options?.canUseTool, undefined);
    }),
  );
});
