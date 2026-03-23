/**
 * ClaudeCodeAdapter - Claude Code implementation of the generic provider adapter contract.
 *
 * This service owns Claude Agent SDK / Claude Code session semantics and emits
 * Claude provider events. It does not perform cross-provider routing or shared
 * orchestration concerns.
 *
 * @module ClaudeCodeAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface ClaudeCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "claudeCode";
}

export class ClaudeCodeAdapter extends ServiceMap.Service<
  ClaudeCodeAdapter,
  ClaudeCodeAdapterShape
>()("t3/provider/Services/ClaudeCodeAdapter") {}
