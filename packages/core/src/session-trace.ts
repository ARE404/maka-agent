import type { ModelCallAttemptStatus, ModelCallKind } from './model-call-attempt.js';

/**
 * Per-session causal trace: what happened inside a session's runs, in order,
 * with the cost and latency of the model calls that drove it (#1625).
 *
 * This is a **projection, not a record**. Two authorities feed it and neither is
 * restated here:
 *
 * - `RuntimeEvent` supplies causal structure — tool dispatch, permission
 *   decisions, errors, the shape of a turn.
 * - `ModelCallAttempt` supplies metering — one record per physical provider
 *   request, with the cost frozen at call time (#1679).
 *
 * The projection joins them and reports what it could not see. It never derives
 * a number the ledgers do not carry: an unpriced call has no cost here either,
 * and a backend that emits no canonical records produces a trace that says so
 * rather than one that looks idle.
 */
export const SESSION_TRACE_SCHEMA_VERSION = 1 as const;

/**
 * Why a step exists. Deliberately not the RuntimeEvent content kind: this is the
 * causal vocabulary a reader thinks in ("the model called a tool, the tool
 * failed, the context compacted"), which is a projection of several event
 * shapes rather than a rename of one.
 */
export type TraceStepKind = 'model_call' | 'tool' | 'permission' | 'compaction' | 'error';

/** One physical provider request, as metered. */
export interface TraceModelAttempt {
  attemptId: string;
  /** Retry ordinal within the logical call; 0 is the first dispatch. */
  attempt: number;
  status: ModelCallAttemptStatus;
  startedAt: number;
  completedAt: number;
  latencyMs: number;
  timeToFirstTokenMs?: number;
  finishReason?: string;
  errorClass?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningTokens?: number;
  /**
   * Absent when the record carries no price. Never rendered as zero: a call
   * nobody could price and a call that was free are different facts, and the
   * canonical record keeps them apart (#1679).
   */
  costUsd?: number;
  /** Whether the amount above is real, and if not, why there isn't one. */
  costBasis: 'priced' | 'unpriced';
  /** Whether the tokens above were reported by the provider or are partial. */
  usageBasis: 'reported' | 'partial' | 'missing';
}

/**
 * One logical model call and every attempt of it.
 *
 * Retries are nested rather than flattened because "this call was retried three
 * times" is the fact a reader is looking for; a flat list of four steps that
 * happen to share an id makes them reconstruct it.
 */
export interface TraceModelCallStep {
  kind: 'model_call';
  id: string;
  turnId: string;
  runId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  callKind: ModelCallKind;
  providerId: string;
  modelId: string;
  connectionSlug?: string;
  /** Runtime tool-loop step index within the turn. */
  step: number;
  attempts: TraceModelAttempt[];
  /** Terminal status of the last attempt. */
  status: ModelCallAttemptStatus;
  /** Sum over attempts that carry a price; absent when none do. */
  costUsd?: number;
}

export interface TraceToolStep {
  kind: 'tool';
  id: string;
  turnId: string;
  runId: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  toolName: string;
  toolCallId?: string;
  status: 'completed' | 'failed' | 'in_flight';
  /** Present when the dispatch was recovered rather than executed fresh. */
  recoveryMode?: string;
}

export interface TracePermissionStep {
  kind: 'permission';
  id: string;
  turnId: string;
  runId: string;
  startedAt: number;
  toolName?: string;
  decision: string;
}

export interface TraceCompactionStep {
  kind: 'compaction';
  id: string;
  turnId: string;
  runId: string;
  startedAt: number;
  /** Which compaction wrote here, when the trace can tell them apart. */
  compactionKind?: Extract<ModelCallKind, 'history_compact' | 'semantic_compact'>;
}

export interface TraceErrorStep {
  kind: 'error';
  id: string;
  turnId: string;
  runId: string;
  startedAt: number;
  message: string;
}

export type TraceStep =
  | TraceModelCallStep
  | TraceToolStep
  | TracePermissionStep
  | TraceCompactionStep
  | TraceErrorStep;

/**
 * What ended a turn badly, and what the trace believes caused it.
 *
 * `attributedToStepId` is a claim about *sequence*, not about intent: the step
 * that failed first. The projection does not diagnose; it points at evidence.
 */
export interface TraceFailureAttribution {
  code: string;
  message?: string;
  attributedToStepId?: string;
}

export interface TraceTotals {
  durationMs: number;
  /** Physical provider requests, retries included. */
  modelAttempts: number;
  /** Attempts beyond the first of their logical call. */
  retries: number;
  compactions: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * Summed over priced records only, and absent when none were priced.
   *
   * Same authority as Settings → Usage, read at a different scope: both sum
   * `ModelCallAttempt`. A total here that disagreed with that surface would be
   * a bug in one of them, not two defensible numbers (#1679).
   */
  costUsd?: number;
  /** Records that carried no price, and are therefore absent from `costUsd`. */
  unpricedAttempts: number;
}

export interface TurnTrace {
  turnId: string;
  runId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  steps: TraceStep[];
  totals: TraceTotals;
  failure?: TraceFailureAttribution;
}

/**
 * What the trace could not see.
 *
 * Stated per session rather than inferred per view, because incompleteness that
 * only shows as an empty timeline is indistinguishable from an idle session —
 * and the pi backend produces exactly that: `token_usage` events with no
 * canonical records behind them.
 */
export interface SessionTraceCoverage {
  /**
   * `complete` — every turn with model activity has canonical records.
   * `partial` — some turns have them and some do not.
   * `absent` — the session has model activity but no canonical records at all,
   * which is what a backend outside canonical accounting looks like.
   * `none` — no model activity to cover.
   */
  modelCalls: 'complete' | 'partial' | 'absent' | 'none';
  /** Turn ids with aggregate usage but no canonical record behind it. */
  turnsMissingModelCalls: string[];
}

export interface SessionTrace {
  schemaVersion: typeof SESSION_TRACE_SCHEMA_VERSION;
  sessionId: string;
  turns: TurnTrace[];
  totals: TraceTotals;
  coverage: SessionTraceCoverage;
}

/** Empty totals, so callers fold rather than special-case the first element. */
export function emptyTraceTotals(): TraceTotals {
  return {
    durationMs: 0,
    modelAttempts: 0,
    retries: 0,
    compactions: 0,
    inputTokens: 0,
    outputTokens: 0,
    unpricedAttempts: 0,
  };
}

/**
 * Folds one set of totals into another.
 *
 * `costUsd` stays absent until something priced arrives, so a session of
 * entirely unpriced calls totals to "no price", not to zero.
 */
export function mergeTraceTotals(base: TraceTotals, next: TraceTotals): TraceTotals {
  const costUsd =
    base.costUsd === undefined && next.costUsd === undefined
      ? undefined
      : (base.costUsd ?? 0) + (next.costUsd ?? 0);
  return {
    durationMs: base.durationMs + next.durationMs,
    modelAttempts: base.modelAttempts + next.modelAttempts,
    retries: base.retries + next.retries,
    compactions: base.compactions + next.compactions,
    inputTokens: base.inputTokens + next.inputTokens,
    outputTokens: base.outputTokens + next.outputTokens,
    unpricedAttempts: base.unpricedAttempts + next.unpricedAttempts,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}
