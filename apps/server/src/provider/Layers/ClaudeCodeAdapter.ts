import { randomUUID } from "node:crypto";

import {
  query,
  type ElicitationRequest,
  type ElicitationResult,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderUserInputAnswers,
  ApprovalRequestId,
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, PubSub, Stream } from "effect";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type ClaudeCodeAdapterShape, ClaudeCodeAdapter } from "../Services/ClaudeCodeAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "claudeCode" as const;

type ClaudeCodePermissionResult = PermissionResult;
type ClaudeCodeElicitationResult = ElicitationResult;

interface ClaudeResumeCursor {
  readonly sessionId: string;
}

interface ClaudeCodeSessionOptions {
  readonly binaryPath?: string;
  readonly settingSources: ReadonlyArray<"user" | "project" | "local">;
}

interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

interface PendingApprovalRequest {
  readonly requestId: ApprovalRequestId;
  readonly rawRequestId: string;
  readonly turnId: TurnId;
  readonly toolUseId: string;
  readonly suggestions?: PermissionUpdate[];
  readonly requestType:
    | "command_execution_approval"
    | "file_read_approval"
    | "file_change_approval";
  readonly resolve: (result: ClaudeCodePermissionResult) => void;
  readonly reject: (error: Error) => void;
}

interface PendingUserInputRequest {
  readonly requestId: ApprovalRequestId;
  readonly rawRequestId: string;
  readonly turnId: TurnId;
  readonly resolve: (result: ClaudeCodeElicitationResult) => void;
  readonly reject: (error: Error) => void;
}

interface ActiveTurnContext {
  readonly turnId: TurnId;
  readonly abortController: AbortController;
  readonly query: Query;
  readonly onSessionInitialized?: (sessionId: string) => void;
  resultEmitted: boolean;
  assistantItemId: RuntimeItemId | null;
}

interface ClaudeCodeSessionContext {
  session: ProviderSession;
  sessionOptions: ClaudeCodeSessionOptions;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApprovalRequest>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInputRequest>;
  readonly turns: ProviderThreadTurnSnapshot[];
  activeTurn: ActiveTurnContext | null;
}

export interface ClaudeCodeAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeEventId(): EventId {
  return EventId.makeUnsafe(randomUUID());
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
}

function hasErrorTag(value: unknown, tag: string): boolean {
  return asRecord(value)?._tag === tag;
}

function isSessionNotFoundError(cause: unknown): cause is ProviderAdapterSessionNotFoundError {
  return hasErrorTag(cause, "ProviderAdapterSessionNotFoundError");
}

function isSessionClosedError(cause: unknown): cause is ProviderAdapterSessionClosedError {
  return hasErrorTag(cause, "ProviderAdapterSessionClosedError");
}

function isRequestError(cause: unknown): cause is ProviderAdapterRequestError {
  return hasErrorTag(cause, "ProviderAdapterRequestError");
}

function readClaudeResumeCursorSessionId(resumeCursor: unknown): string | undefined {
  const record = asRecord(resumeCursor);
  const sessionId = asString(record?.sessionId)?.trim();
  return sessionId && sessionId.length > 0 ? sessionId : undefined;
}

function buildClaudeResumeCursor(sessionId: string): ClaudeResumeCursor {
  return { sessionId };
}

function toRaw(message: SDKMessage): ProviderRuntimeEvent["raw"] {
  const subtype = "subtype" in message ? asString(message.subtype) : undefined;
  return {
    source: "claude.sdk.message",
    ...(subtype ? { method: subtype } : {}),
    messageType: message.type,
    payload: message,
  };
}

function toolApprovalType(
  toolName: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" {
  switch (toolName) {
    case "Agent":
    case "Bash":
    case "Config":
    case "EnterWorktree":
    case "ExitPlanMode":
    case "ExitWorktree":
    case "ListMcpResources":
    case "Mcp":
    case "SubscribeMcpResource":
    case "SubscribePolling":
    case "Task":
    case "TaskOutput":
    case "TaskStop":
    case "UnsubscribeMcpResource":
    case "UnsubscribePolling":
    case "WebFetch":
    case "WebSearch":
      return "command_execution_approval";
    case "Read":
    case "Glob":
    case "Grep":
    case "LS":
    case "ReadMcpResource":
      return "file_read_approval";
    case "NotebookEdit":
    case "TodoWrite":
    case "Edit":
    case "Write":
    case "MultiEdit":
      return "file_change_approval";
    default:
      // Unknown Claude tools should still require explicit approval instead of
      // silently bypassing the approval-required flow.
      return "command_execution_approval";
  }
}

function questionLabelFromPropertyName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toUserInputQuestions(request: ElicitationRequest) {
  if (request.mode === "url") {
    return [
      {
        id: "url",
        header: "Browser",
        question: request.message.trim() || "Open the authentication URL and continue?",
        options: [
          {
            label: "Continue",
            description: request.url ?? "Continue after completing the external flow.",
          },
        ],
      },
    ] as const;
  }

  const schema = asRecord(request.requestedSchema);
  const properties = asRecord(schema?.properties);
  if (!properties || Object.keys(properties).length === 0) {
    return [
      {
        id: "response",
        header: "Input",
        question: request.message.trim() || "Provide the requested input.",
        options: [
          {
            label: "Enter value",
            description: "Use the free-form input field to provide the response.",
          },
        ],
      },
    ] as const;
  }

  return Object.entries(properties).map(([key, value]) => {
    const property = asRecord(value);
    const title = asString(property?.title)?.trim();
    const description = asString(property?.description)?.trim();
    const enumOptions = Array.isArray(property?.enum)
      ? property.enum.filter((option): option is string => typeof option === "string")
      : [];
    const baseQuestion = title || questionLabelFromPropertyName(key) || key;
    return {
      id: key,
      header: (title || key).slice(0, 24),
      question: description ? `${baseQuestion}: ${description}` : baseQuestion,
      options:
        enumOptions.length > 0
          ? enumOptions.map((option) => ({
              label: option,
              description: description || `Choose ${option}.`,
            }))
          : [
              {
                label: "Enter value",
                description: description || "Use the free-form input field to provide a value.",
              },
            ],
    };
  });
}

function normalizeElicitationAnswers(
  answers: ProviderUserInputAnswers,
): Record<string, unknown> | undefined {
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (typeof value === "string") {
      content[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      const normalized = value.filter((entry): entry is string => typeof entry === "string");
      if (normalized.length > 0) {
        content[key] = normalized.length === 1 ? normalized[0] : normalized;
      }
      continue;
    }
    const record = asRecord(value);
    const answerList = Array.isArray(record?.answers)
      ? record.answers.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (answerList.length > 0) {
      content[key] = answerList.length === 1 ? answerList[0] : answerList;
    }
  }
  return Object.keys(content).length > 0 ? content : undefined;
}

function resolvePermissionConfig(
  runtimeMode: ProviderSession["runtimeMode"],
  interactionMode: ProviderInteractionMode | undefined,
): {
  readonly permissionMode: "default" | "plan" | "bypassPermissions";
  readonly allowDangerouslySkipPermissions?: true;
  readonly requiresToolApprovalCallback: boolean;
} {
  if (interactionMode === "plan") {
    return {
      permissionMode: "plan",
      requiresToolApprovalCallback: false,
    };
  }

  if (runtimeMode === "full-access") {
    return {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      requiresToolApprovalCallback: false,
    };
  }

  return {
    permissionMode: "default",
    requiresToolApprovalCallback: true,
  };
}

function resolveClaudeSessionOptions(
  input: ProviderSessionStartInput,
  existing?: ClaudeCodeSessionOptions,
): ClaudeCodeSessionOptions {
  const binaryPath = input.providerOptions?.claudeCode?.binaryPath ?? existing?.binaryPath;
  return {
    ...(binaryPath ? { binaryPath } : {}),
    settingSources: input.providerOptions?.claudeCode?.settingSources ??
      existing?.settingSources ?? ["user", "project", "local"],
  };
}

function buildSession(
  input: ProviderSessionStartInput,
  overrides?: Partial<ProviderSession>,
): ProviderSession {
  const timestamp = nowIso();
  return {
    provider: PROVIDER,
    status: "ready",
    runtimeMode: input.runtimeMode,
    threadId: input.threadId,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function sessionNotFound(threadId: ThreadId): ProviderAdapterSessionNotFoundError {
  return new ProviderAdapterSessionNotFoundError({
    provider: PROVIDER,
    threadId,
  });
}

function sessionClosed(threadId: ThreadId): ProviderAdapterSessionClosedError {
  return new ProviderAdapterSessionClosedError({
    provider: PROVIDER,
    threadId,
  });
}

function unsupportedRequest(method: string): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: "Claude Code provider does not support provider-native rollback yet.",
  });
}

const makeClaudeCodeAdapter = (options?: ClaudeCodeAdapterLiveOptions) =>
  Effect.gen(function* () {
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const eventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, ClaudeCodeSessionContext>();

    const emit = (event: ProviderRuntimeEvent) =>
      PubSub.publish(eventPubSub, event).pipe(Effect.asVoid);

    const logRaw = (threadId: ThreadId, event: unknown) =>
      nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void;

    const getSessionContext = (
      threadId: ThreadId,
    ): Effect.Effect<ClaudeCodeSessionContext, ProviderAdapterSessionNotFoundError> => {
      const context = sessions.get(threadId);
      if (!context) {
        return Effect.fail(sessionNotFound(threadId));
      }
      return Effect.succeed(context);
    };

    const updateSession = (
      context: ClaudeCodeSessionContext,
      patch: Partial<ProviderSession>,
    ): ProviderSession => {
      context.session = {
        ...context.session,
        ...patch,
        updatedAt: nowIso(),
      };
      return context.session;
    };

    const publishSessionStarted = (context: ClaudeCodeSessionContext, message?: string) =>
      emit({
        eventId: makeEventId(),
        provider: PROVIDER,
        threadId: context.session.threadId,
        createdAt: nowIso(),
        type: "session.started",
        payload: {
          ...(message ? { message } : {}),
          ...(context.session.resumeCursor !== undefined
            ? { resume: context.session.resumeCursor }
            : {}),
        },
      });

    const publishSessionConfigured = (
      context: ClaudeCodeSessionContext,
      extra?: Record<string, unknown>,
    ) =>
      emit({
        eventId: makeEventId(),
        provider: PROVIDER,
        threadId: context.session.threadId,
        createdAt: nowIso(),
        type: "session.configured",
        payload: {
          config: {
            cwd: context.session.cwd ?? null,
            model: context.session.model ?? null,
            ...extra,
          },
        },
      });

    const finalizePending = (context: ClaudeCodeSessionContext, errorMessage: string) =>
      Effect.sync(() => {
        for (const pending of context.pendingApprovals.values()) {
          pending.reject(new Error(errorMessage));
        }
        for (const pending of context.pendingUserInputs.values()) {
          pending.reject(new Error(errorMessage));
        }
        context.pendingApprovals.clear();
        context.pendingUserInputs.clear();
      });

    const shutdownActiveTurn = (
      context: ClaudeCodeSessionContext,
      reason: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const activeTurn = context.activeTurn;
        if (!activeTurn) {
          return;
        }
        context.activeTurn = null;
        activeTurn.abortController.abort(reason);
        activeTurn.query.close();
        yield* finalizePending(context, reason);
      });

    const onCanUseTool =
      (
        context: ClaudeCodeSessionContext,
        turnId: TurnId,
        runtimeMode: "approval-required" | "full-access",
      ) =>
      async (
        toolName: string,
        input: Record<string, unknown>,
        options: {
          signal: AbortSignal;
          suggestions?: PermissionUpdate[];
          blockedPath?: string;
          decisionReason?: string;
          title?: string;
          displayName?: string;
          description?: string;
          toolUseID: string;
          agentID?: string;
        },
      ): Promise<ClaudeCodePermissionResult> => {
        const requestType = toolApprovalType(toolName);
        if (runtimeMode === "full-access") {
          return {
            behavior: "allow",
            ...(options.suggestions ? { updatedPermissions: options.suggestions } : {}),
          };
        }

        const rawRequestId = `claude-request:${randomUUID()}`;
        const requestId = ApprovalRequestId.makeUnsafe(rawRequestId);

        return await new Promise<ClaudeCodePermissionResult>((resolve, reject) => {
          const pending: PendingApprovalRequest = {
            requestId,
            rawRequestId,
            turnId,
            toolUseId: options.toolUseID,
            ...(options.suggestions ? { suggestions: [...options.suggestions] } : {}),
            requestType,
            resolve,
            reject,
          };
          context.pendingApprovals.set(requestId, pending);

          const abort = () => {
            context.pendingApprovals.delete(requestId);
            void Effect.runPromise(
              emit({
                eventId: makeEventId(),
                provider: PROVIDER,
                threadId: context.session.threadId,
                createdAt: nowIso(),
                turnId,
                requestId: RuntimeRequestId.makeUnsafe(rawRequestId),
                type: "request.resolved",
                payload: {
                  requestType,
                  decision: "cancel",
                },
                raw: {
                  source: "claude.sdk.message",
                  method: "can_use_tool",
                  payload: {
                    toolName,
                    input,
                    toolUseId: options.toolUseID,
                    aborted: true,
                  },
                },
              }),
            );
            reject(new Error("Permission request was aborted."));
          };

          if (options.signal.aborted) {
            abort();
            return;
          }

          options.signal.addEventListener("abort", abort, { once: true });

          void Effect.runPromise(
            emit({
              eventId: makeEventId(),
              provider: PROVIDER,
              threadId: context.session.threadId,
              createdAt: nowIso(),
              turnId,
              requestId: RuntimeRequestId.makeUnsafe(rawRequestId),
              type: "request.opened",
              payload: {
                requestType,
                ...(options.title?.trim() ? { detail: options.title.trim() } : {}),
                args: {
                  toolName,
                  input,
                  toolUseId: options.toolUseID,
                  blockedPath: options.blockedPath,
                  decisionReason: options.decisionReason,
                  description: options.description,
                  displayName: options.displayName,
                },
              },
              raw: {
                source: "claude.sdk.message",
                method: "can_use_tool",
                payload: {
                  toolName,
                  input,
                  toolUseId: options.toolUseID,
                },
              },
            }),
          );
        });
      };

    const onElicitation =
      (context: ClaudeCodeSessionContext, turnId: TurnId) =>
      async (request: ElicitationRequest): Promise<ClaudeCodeElicitationResult> => {
        const rawRequestId = `claude-user-input:${randomUUID()}`;
        const requestId = ApprovalRequestId.makeUnsafe(rawRequestId);
        return await new Promise<ClaudeCodeElicitationResult>((resolve, reject) => {
          context.pendingUserInputs.set(requestId, {
            requestId,
            rawRequestId,
            turnId,
            resolve,
            reject,
          });

          void Effect.runPromise(
            emit({
              eventId: makeEventId(),
              provider: PROVIDER,
              threadId: context.session.threadId,
              createdAt: nowIso(),
              turnId,
              requestId: RuntimeRequestId.makeUnsafe(rawRequestId),
              type: "user-input.requested",
              payload: {
                questions: toUserInputQuestions(request),
              },
              raw: {
                source: "claude.sdk.message",
                method: "elicitation",
                payload: request,
              },
            }),
          );
        });
      };

    const consumeQuery = async (
      context: ClaudeCodeSessionContext,
      activeTurn: ActiveTurnContext,
      interactionMode: ProviderInteractionMode | undefined,
    ): Promise<void> => {
      const { threadId } = context.session;
      const turnSnapshot: ProviderThreadTurnSnapshot = {
        id: activeTurn.turnId,
        items: [],
      };
      context.turns.push(turnSnapshot);

      try {
        for await (const message of activeTurn.query) {
          await Effect.runPromise(logRaw(threadId, message));

          if (context.activeTurn !== activeTurn) {
            break;
          }

          switch (message.type) {
            case "system": {
              if (message.subtype === "init") {
                updateSession(context, {
                  resumeCursor: buildClaudeResumeCursor(message.session_id),
                  cwd: message.cwd,
                  model: message.model,
                });
                activeTurn.onSessionInitialized?.(message.session_id);
                await Effect.runPromise(
                  emit({
                    eventId: makeEventId(),
                    provider: PROVIDER,
                    threadId,
                    createdAt: nowIso(),
                    type: "session.started",
                    payload: {
                      message: "Claude Code session initialized.",
                      resume: context.session.resumeCursor,
                    },
                    raw: toRaw(message),
                  }),
                );
                await Effect.runPromise(
                  emit({
                    eventId: makeEventId(),
                    provider: PROVIDER,
                    threadId,
                    createdAt: nowIso(),
                    type: "session.configured",
                    payload: {
                      config: {
                        cwd: message.cwd,
                        model: message.model,
                        tools: message.tools,
                        permissionMode: message.permissionMode,
                      },
                    },
                    raw: toRaw(message),
                  }),
                );
              } else if (message.subtype === "status") {
                await Effect.runPromise(
                  emit({
                    eventId: makeEventId(),
                    provider: PROVIDER,
                    threadId,
                    createdAt: nowIso(),
                    turnId: activeTurn.turnId,
                    type: "session.state.changed",
                    payload: {
                      state: message.status === "compacting" ? "waiting" : "running",
                      ...(message.status ? { detail: { status: message.status } } : {}),
                    },
                    raw: toRaw(message),
                  }),
                );
              } else if (message.subtype === "task_started") {
                await Effect.runPromise(
                  emit({
                    eventId: makeEventId(),
                    provider: PROVIDER,
                    threadId,
                    createdAt: nowIso(),
                    turnId: activeTurn.turnId,
                    type: "task.started",
                    payload: {
                      taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                      ...(message.description ? { description: message.description } : {}),
                      ...(message.task_type ? { taskType: message.task_type } : {}),
                    },
                    raw: toRaw(message),
                  }),
                );
              } else if (message.subtype === "task_progress") {
                await Effect.runPromise(
                  emit({
                    eventId: makeEventId(),
                    provider: PROVIDER,
                    threadId,
                    createdAt: nowIso(),
                    turnId: activeTurn.turnId,
                    type: "task.progress",
                    payload: {
                      taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                      description: message.description,
                      ...(message.usage ? { usage: message.usage } : {}),
                      ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
                    },
                    raw: toRaw(message),
                  }),
                );
              } else if (message.subtype === "task_notification") {
                await Effect.runPromise(
                  emit({
                    eventId: makeEventId(),
                    provider: PROVIDER,
                    threadId,
                    createdAt: nowIso(),
                    turnId: activeTurn.turnId,
                    type: "task.completed",
                    payload: {
                      taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                      status: message.status,
                      ...(message.summary ? { summary: message.summary } : {}),
                      ...(message.usage ? { usage: message.usage } : {}),
                    },
                    raw: toRaw(message),
                  }),
                );
              } else if (message.subtype === "files_persisted") {
                await Effect.runPromise(
                  emit({
                    eventId: makeEventId(),
                    provider: PROVIDER,
                    threadId,
                    createdAt: nowIso(),
                    turnId: activeTurn.turnId,
                    type: "files.persisted",
                    payload: {
                      files: message.files.map((file) => ({
                        filename: file.filename,
                        fileId: file.file_id,
                      })),
                      ...(message.failed.length > 0
                        ? {
                            failed: message.failed.map((file) => ({
                              filename: file.filename,
                              error: file.error,
                            })),
                          }
                        : {}),
                    },
                    raw: toRaw(message),
                  }),
                );
              } else if (message.subtype === "hook_started") {
                await Effect.runPromise(
                  emit({
                    eventId: makeEventId(),
                    provider: PROVIDER,
                    threadId,
                    createdAt: nowIso(),
                    turnId: activeTurn.turnId,
                    type: "hook.started",
                    payload: {
                      hookId: message.hook_id,
                      hookName: message.hook_name,
                      hookEvent: message.hook_event,
                    },
                    raw: toRaw(message),
                  }),
                );
              } else if (message.subtype === "hook_progress") {
                await Effect.runPromise(
                  emit({
                    eventId: makeEventId(),
                    provider: PROVIDER,
                    threadId,
                    createdAt: nowIso(),
                    turnId: activeTurn.turnId,
                    type: "hook.progress",
                    payload: {
                      hookId: message.hook_id,
                      ...(message.output ? { output: message.output } : {}),
                      ...(message.stdout ? { stdout: message.stdout } : {}),
                      ...(message.stderr ? { stderr: message.stderr } : {}),
                    },
                    raw: toRaw(message),
                  }),
                );
              } else if (message.subtype === "hook_response") {
                await Effect.runPromise(
                  emit({
                    eventId: makeEventId(),
                    provider: PROVIDER,
                    threadId,
                    createdAt: nowIso(),
                    turnId: activeTurn.turnId,
                    type: "hook.completed",
                    payload: {
                      hookId: message.hook_id,
                      outcome: message.outcome,
                      ...(message.output ? { output: message.output } : {}),
                      ...(message.stdout ? { stdout: message.stdout } : {}),
                      ...(message.stderr ? { stderr: message.stderr } : {}),
                      ...(message.exit_code !== undefined ? { exitCode: message.exit_code } : {}),
                    },
                    raw: toRaw(message),
                  }),
                );
              } else if (message.subtype === "api_retry") {
                await Effect.runPromise(
                  emit({
                    eventId: makeEventId(),
                    provider: PROVIDER,
                    threadId,
                    createdAt: nowIso(),
                    turnId: activeTurn.turnId,
                    type: "runtime.warning",
                    payload: {
                      message: `Claude API retry ${message.attempt}/${message.max_retries}.`,
                      detail: {
                        retryDelayMs: message.retry_delay_ms,
                        errorStatus: message.error_status,
                        error: message.error,
                      },
                    },
                    raw: toRaw(message),
                  }),
                );
              }
              break;
            }

            case "stream_event": {
              const event = asRecord(message.event);
              if (event?.type === "content_block_delta") {
                const delta = asRecord(event.delta);
                const text = asString(delta?.text);
                if (delta?.type === "text_delta" && text && text.length > 0) {
                  if (!activeTurn.assistantItemId) {
                    activeTurn.assistantItemId = RuntimeItemId.makeUnsafe(
                      `claude-assistant:${randomUUID()}`,
                    );
                  }
                  await Effect.runPromise(
                    emit({
                      eventId: makeEventId(),
                      provider: PROVIDER,
                      threadId,
                      createdAt: nowIso(),
                      turnId: activeTurn.turnId,
                      itemId: activeTurn.assistantItemId,
                      type: "content.delta",
                      payload: {
                        streamKind: "assistant_text",
                        delta: text,
                      },
                      raw: toRaw(message),
                    }),
                  );
                }
              }
              break;
            }

            case "assistant": {
              const assistantText = Array.isArray(message.message.content)
                ? message.message.content
                    .map((block: unknown) => {
                      const record = asRecord(block);
                      return record?.type === "text" ? (asString(record.text) ?? "") : "";
                    })
                    .join("")
                    .trim()
                : "";
              if (!activeTurn.assistantItemId) {
                activeTurn.assistantItemId = RuntimeItemId.makeUnsafe(
                  `claude-assistant:${message.uuid}`,
                );
              }
              await Effect.runPromise(
                emit({
                  eventId: makeEventId(),
                  provider: PROVIDER,
                  threadId,
                  createdAt: nowIso(),
                  turnId: activeTurn.turnId,
                  itemId: activeTurn.assistantItemId,
                  type: "item.completed",
                  payload: {
                    itemType: "assistant_message",
                    status: "completed",
                    ...(assistantText ? { detail: assistantText } : {}),
                    data: message.message,
                  },
                  raw: toRaw(message),
                }),
              );
              break;
            }

            case "tool_progress": {
              await Effect.runPromise(
                emit({
                  eventId: makeEventId(),
                  provider: PROVIDER,
                  threadId,
                  createdAt: nowIso(),
                  turnId: activeTurn.turnId,
                  itemId: RuntimeItemId.makeUnsafe(message.tool_use_id),
                  type: "tool.progress",
                  payload: {
                    toolUseId: message.tool_use_id,
                    toolName: message.tool_name,
                    elapsedSeconds: message.elapsed_time_seconds,
                  },
                  raw: toRaw(message),
                }),
              );
              break;
            }

            case "tool_use_summary": {
              await Effect.runPromise(
                emit({
                  eventId: makeEventId(),
                  provider: PROVIDER,
                  threadId,
                  createdAt: nowIso(),
                  turnId: activeTurn.turnId,
                  type: "tool.summary",
                  payload: {
                    summary: message.summary,
                    precedingToolUseIds: message.preceding_tool_use_ids,
                  },
                  raw: toRaw(message),
                }),
              );
              break;
            }

            case "auth_status": {
              await Effect.runPromise(
                emit({
                  eventId: makeEventId(),
                  provider: PROVIDER,
                  threadId,
                  createdAt: nowIso(),
                  type: "auth.status",
                  payload: {
                    isAuthenticating: message.isAuthenticating,
                    output: message.output,
                    ...(message.error ? { error: message.error } : {}),
                  },
                  raw: toRaw(message),
                }),
              );
              break;
            }

            case "rate_limit_event": {
              await Effect.runPromise(
                emit({
                  eventId: makeEventId(),
                  provider: PROVIDER,
                  threadId,
                  createdAt: nowIso(),
                  type: "account.rate-limits.updated",
                  payload: {
                    rateLimits: message.rate_limit_info,
                  },
                  raw: toRaw(message),
                }),
              );
              break;
            }

            case "result": {
              activeTurn.resultEmitted = true;
              const successful = !message.is_error && message.subtype === "success";
              updateSession(context, {
                status: successful ? "ready" : "error",
                activeTurnId: undefined,
                ...(successful
                  ? {}
                  : { lastError: toErrorMessage(message, "Claude turn failed.") }),
              });

              await Effect.runPromise(
                emit({
                  eventId: makeEventId(),
                  provider: PROVIDER,
                  threadId,
                  createdAt: nowIso(),
                  turnId: activeTurn.turnId,
                  type: "turn.completed",
                  payload: {
                    state: successful ? "completed" : "failed",
                    stopReason: message.stop_reason,
                    usage: message.usage,
                    modelUsage: message.modelUsage,
                    totalCostUsd: message.total_cost_usd,
                    ...(!successful && "errors" in message && message.errors.length > 0
                      ? { errorMessage: message.errors.join("; ") }
                      : {}),
                  },
                  raw: toRaw(message),
                }),
              );

              await Effect.runPromise(
                emit({
                  eventId: makeEventId(),
                  provider: PROVIDER,
                  threadId,
                  createdAt: nowIso(),
                  turnId: activeTurn.turnId,
                  type: "session.state.changed",
                  payload: {
                    state: successful ? "ready" : "error",
                    ...(!successful && "errors" in message && message.errors.length > 0
                      ? { reason: message.errors.join("; ") }
                      : {}),
                  },
                  raw: toRaw(message),
                }),
              );
              break;
            }
          }
        }

        if (
          context.activeTurn === activeTurn &&
          !activeTurn.resultEmitted &&
          interactionMode !== "plan"
        ) {
          updateSession(context, {
            status: "ready",
            activeTurnId: undefined,
          });
          await Effect.runPromise(
            emit({
              eventId: makeEventId(),
              provider: PROVIDER,
              threadId,
              createdAt: nowIso(),
              turnId: activeTurn.turnId,
              type: "turn.completed",
              payload: {
                state: "cancelled",
              },
            }),
          );
        }
      } catch (error) {
        updateSession(context, {
          status: "error",
          activeTurnId: undefined,
          lastError: toErrorMessage(error, "Claude Code query failed."),
        });
        await Effect.runPromise(
          emit({
            eventId: makeEventId(),
            provider: PROVIDER,
            threadId,
            createdAt: nowIso(),
            turnId: activeTurn.turnId,
            type: "runtime.error",
            payload: {
              message: toErrorMessage(error, "Claude Code query failed."),
              class: "provider_error",
            },
          }),
        );
        if (!activeTurn.resultEmitted) {
          await Effect.runPromise(
            emit({
              eventId: makeEventId(),
              provider: PROVIDER,
              threadId,
              createdAt: nowIso(),
              turnId: activeTurn.turnId,
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: toErrorMessage(error, "Claude Code query failed."),
              },
            }),
          );
        }
      } finally {
        context.activeTurn = null;
      }
    };

    const adapter: ClaudeCodeAdapterShape = {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-session",
      },

      startSession: (input) =>
        Effect.gen(function* () {
          const existing = sessions.get(input.threadId);
          if (existing?.activeTurn) {
            yield* shutdownActiveTurn(existing, "Claude Code session restarted.");
          } else if (existing) {
            yield* finalizePending(existing, "Claude Code session restarted.");
          }

          const session = buildSession(
            input,
            input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : undefined,
          );
          const context: ClaudeCodeSessionContext = {
            session,
            sessionOptions: resolveClaudeSessionOptions(input, existing?.sessionOptions),
            pendingApprovals: new Map(),
            pendingUserInputs: new Map(),
            turns: existing?.turns ?? [],
            activeTurn: null,
          };
          sessions.set(input.threadId, context);
          yield* publishSessionStarted(context, "Claude Code session ready.");
          yield* publishSessionConfigured(context, {
            binaryPath: context.sessionOptions.binaryPath ?? null,
            settingSources: context.sessionOptions.settingSources,
          });
          return session;
        }),

      sendTurn: (input) =>
        Effect.tryPromise({
          try: async () => {
            const context = sessions.get(input.threadId);
            if (!context) {
              throw sessionNotFound(input.threadId);
            }
            if (context.session.status === "closed") {
              throw sessionClosed(input.threadId);
            }
            if (context.activeTurn) {
              throw new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "sendTurn",
                detail: "Claude Code session is already processing a turn.",
              });
            }
            if ((input.attachments?.length ?? 0) > 0) {
              throw new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "sendTurn",
                detail: "Claude Code provider does not support image attachments yet.",
              });
            }

            const turnId = TurnId.makeUnsafe(randomUUID());
            const abortController = new AbortController();
            const sessionId = readClaudeResumeCursorSessionId(context.session.resumeCursor);
            const model = input.model ?? context.session.model;
            const interactionMode = input.interactionMode;
            const permissionConfig = resolvePermissionConfig(
              context.session.runtimeMode,
              interactionMode,
            );
            let resolveSessionInit: ((sessionId: string | undefined) => void) | null = null;
            const sessionInitPromise = new Promise<string | undefined>((resolve) => {
              resolveSessionInit = resolve;
            });
            const queryInstance = query({
              prompt: input.input ?? "",
              options: {
                abortController,
                cwd: context.session.cwd ?? process.cwd(),
                ...(model ? { model } : {}),
                ...(sessionId ? { resume: sessionId } : {}),
                ...(context.session.resumeCursor === undefined ? { persistSession: true } : {}),
                includePartialMessages: true,
                permissionMode: permissionConfig.permissionMode,
                ...(permissionConfig.allowDangerouslySkipPermissions
                  ? { allowDangerouslySkipPermissions: true }
                  : {}),
                ...(input.modelOptions?.claudeCode?.effort
                  ? { effort: input.modelOptions.claudeCode.effort }
                  : {}),
                ...(permissionConfig.requiresToolApprovalCallback
                  ? {
                      canUseTool: onCanUseTool(context, turnId, "approval-required"),
                    }
                  : {}),
                onElicitation: onElicitation(context, turnId),
                ...(context.sessionOptions.binaryPath
                  ? { pathToClaudeCodeExecutable: context.sessionOptions.binaryPath }
                  : {}),
                settingSources: [...context.sessionOptions.settingSources],
              },
            });

            const activeTurn: ActiveTurnContext = {
              turnId,
              abortController,
              query: queryInstance,
              onSessionInitialized: (initializedSessionId) => {
                resolveSessionInit?.(initializedSessionId);
                resolveSessionInit = null;
              },
              resultEmitted: false,
              assistantItemId: null,
            };

            context.activeTurn = activeTurn;
            updateSession(context, {
              status: "running",
              activeTurnId: turnId,
              ...(model ? { model } : {}),
            });

            await Effect.runPromise(
              emit({
                eventId: makeEventId(),
                provider: PROVIDER,
                threadId: input.threadId,
                createdAt: nowIso(),
                turnId,
                type: "turn.started",
                payload: {
                  ...(model ? { model } : {}),
                  ...(input.modelOptions?.claudeCode?.effort
                    ? { effort: input.modelOptions.claudeCode.effort }
                    : {}),
                },
              }),
            );
            await Effect.runPromise(
              emit({
                eventId: makeEventId(),
                provider: PROVIDER,
                threadId: input.threadId,
                createdAt: nowIso(),
                turnId,
                type: "session.state.changed",
                payload: {
                  state: interactionMode === "plan" ? "waiting" : "running",
                },
              }),
            );

            void consumeQuery(context, activeTurn, interactionMode).finally(() => {
              resolveSessionInit?.(readClaudeResumeCursorSessionId(context.session.resumeCursor));
            });

            if (!sessionId) {
              await Promise.race([
                sessionInitPromise,
                new Promise<void>((resolve) => {
                  setTimeout(resolve, 1_000);
                }),
              ]);
            }

            const resolvedResumeCursor =
              readClaudeResumeCursorSessionId(context.session.resumeCursor) ?? sessionId;
            return {
              threadId: input.threadId,
              turnId,
              ...(resolvedResumeCursor
                ? { resumeCursor: buildClaudeResumeCursor(resolvedResumeCursor) }
                : {}),
            };
          },
          catch: (cause): ProviderAdapterError =>
            isSessionNotFoundError(cause) || isSessionClosedError(cause) || isRequestError(cause)
              ? cause
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "sendTurn",
                  detail: toErrorMessage(cause, "Claude Code failed to start a turn."),
                  cause,
                }),
        }),

      interruptTurn: (threadId) =>
        Effect.tryPromise({
          try: async () => {
            const context = sessions.get(threadId);
            if (!context) {
              throw sessionNotFound(threadId);
            }
            const activeTurn = context.activeTurn;
            if (!activeTurn) {
              return;
            }
            try {
              await activeTurn.query.interrupt();
            } catch {
              activeTurn.abortController.abort();
              activeTurn.query.close();
            }
            updateSession(context, {
              status: "ready",
              activeTurnId: undefined,
            });
            await Effect.runPromise(
              emit({
                eventId: makeEventId(),
                provider: PROVIDER,
                threadId,
                createdAt: nowIso(),
                turnId: activeTurn.turnId,
                type: "turn.aborted",
                payload: {
                  reason: "Interrupted by user.",
                },
              }),
            );
          },
          catch: (cause): ProviderAdapterError =>
            isSessionNotFoundError(cause)
              ? cause
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "interruptTurn",
                  detail: toErrorMessage(cause, "Failed to interrupt Claude Code turn."),
                  cause,
                }),
        }),

      respondToRequest: (threadId, requestId, decision) =>
        Effect.tryPromise({
          try: async () => {
            const context = sessions.get(threadId);
            if (!context) {
              throw sessionNotFound(threadId);
            }
            const pending = context.pendingApprovals.get(requestId);
            if (!pending) {
              throw new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "respondToRequest",
                detail: "Unknown pending approval request.",
              });
            }
            context.pendingApprovals.delete(requestId);
            const response: ClaudeCodePermissionResult =
              decision === "accept"
                ? { behavior: "allow" }
                : decision === "acceptForSession"
                  ? {
                      behavior: "allow",
                      ...(pending.suggestions ? { updatedPermissions: pending.suggestions } : {}),
                    }
                  : {
                      behavior: "deny",
                      message:
                        decision === "cancel"
                          ? "Permission request cancelled."
                          : "Permission denied.",
                      interrupt: false,
                    };
            pending.resolve(response);
            await Effect.runPromise(
              emit({
                eventId: makeEventId(),
                provider: PROVIDER,
                threadId,
                createdAt: nowIso(),
                turnId: pending.turnId,
                requestId: RuntimeRequestId.makeUnsafe(pending.rawRequestId),
                type: "request.resolved",
                payload: {
                  requestType: pending.requestType,
                  decision,
                },
              }),
            );
          },
          catch: (cause): ProviderAdapterError =>
            isSessionNotFoundError(cause) || isRequestError(cause)
              ? cause
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "respondToRequest",
                  detail: toErrorMessage(cause, "Failed to resolve Claude Code approval request."),
                  cause,
                }),
        }),

      respondToUserInput: (threadId, requestId, answers) =>
        Effect.tryPromise({
          try: async () => {
            const context = sessions.get(threadId);
            if (!context) {
              throw sessionNotFound(threadId);
            }
            const pending = context.pendingUserInputs.get(requestId);
            if (!pending) {
              throw new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "respondToUserInput",
                detail: "Unknown pending user-input request.",
              });
            }
            context.pendingUserInputs.delete(requestId);
            const content = normalizeElicitationAnswers(answers);
            pending.resolve({
              action: "accept",
              ...(content ? { content } : {}),
            });
            await Effect.runPromise(
              emit({
                eventId: makeEventId(),
                provider: PROVIDER,
                threadId,
                createdAt: nowIso(),
                turnId: pending.turnId,
                requestId: RuntimeRequestId.makeUnsafe(pending.rawRequestId),
                type: "user-input.resolved",
                payload: {
                  answers: content ?? {},
                },
              }),
            );
          },
          catch: (cause): ProviderAdapterError =>
            isSessionNotFoundError(cause) || isRequestError(cause)
              ? cause
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "respondToUserInput",
                  detail: toErrorMessage(cause, "Failed to resolve Claude Code user input."),
                  cause,
                }),
        }),

      stopSession: (threadId) =>
        Effect.tryPromise({
          try: async () => {
            const context = sessions.get(threadId);
            if (!context) {
              throw sessionNotFound(threadId);
            }
            if (context.activeTurn) {
              context.activeTurn.abortController.abort();
              context.activeTurn.query.close();
            }
            await Effect.runPromise(finalizePending(context, "Claude Code session stopped."));
            updateSession(context, {
              status: "closed",
              activeTurnId: undefined,
            });
            sessions.delete(threadId);
            await Effect.runPromise(
              emit({
                eventId: makeEventId(),
                provider: PROVIDER,
                threadId,
                createdAt: nowIso(),
                type: "session.exited",
                payload: {
                  reason: "Session stopped.",
                  exitKind: "graceful",
                  recoverable: true,
                },
              }),
            );
          },
          catch: (cause): ProviderAdapterError =>
            isSessionNotFoundError(cause)
              ? cause
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "stopSession",
                  detail: toErrorMessage(cause, "Failed to stop Claude Code session."),
                  cause,
                }),
        }),

      listSessions: () =>
        Effect.sync(() => Array.from(sessions.values(), (context) => context.session)),

      hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),

      readThread: (threadId) =>
        getSessionContext(threadId).pipe(
          Effect.map((context) => ({
            threadId,
            turns: [...context.turns],
          })),
        ),

      rollbackThread: () => Effect.fail(unsupportedRequest("rollbackThread")),

      stopAll: () =>
        Effect.forEach(Array.from(sessions.keys()), (threadId) => adapter.stopSession(threadId), {
          concurrency: "unbounded",
          discard: true,
        }).pipe(Effect.asVoid),

      streamEvents: Stream.fromPubSub(eventPubSub),
    };

    return adapter;
  });

export function makeClaudeCodeAdapterLive(options?: ClaudeCodeAdapterLiveOptions) {
  return Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter(options));
}

export const ClaudeCodeAdapterLive = makeClaudeCodeAdapterLive();
