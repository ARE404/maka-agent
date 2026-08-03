import type { ModelCallAttempt } from '@maka/core/model-call-attempt';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  emptyTraceTotals,
  mergeTraceTotals,
  SESSION_TRACE_SCHEMA_VERSION,
  type SessionTrace,
  type SessionTraceCoverage,
  type TraceFailureAttribution,
  type TraceModelAttempt,
  type TraceModelCallStep,
  type TraceStep,
  type TraceTotals,
  type TurnTrace,
} from '@maka/core/session-trace';

/**
 * Builds the per-session causal trace the Inspector renders (#1625).
 *
 * Pure and synchronous by construction: both ledgers are handed in already
 * read. The caller owns the I/O — `readSessionRuntimeEvents` for structure and
 * the AgentRun stream for canonical records — which keeps this file testable
 * against fixtures and keeps `@maka/storage` out of `@maka/runtime`.
 *
 * The two inputs are joined on `(runId, turnId)`, the identity both ledgers
 * carry. Nothing is inferred across that boundary: a turn with events and no
 * records renders its structure and reports the gap, rather than borrowing
 * numbers from a neighbouring turn.
 */
export interface SessionTraceInput {
  sessionId: string;
  /** Causal structure, from `RuntimeEventStore.readSessionRuntimeEvents`. */
  runtimeEvents: readonly RuntimeEvent[];
  /** Canonical metering, from the AgentRun stream's `model_call_attempt_recorded`. */
  modelCallAttempts: readonly ModelCallAttempt[];
}

export function projectSessionTrace(input: SessionTraceInput): SessionTrace {
  const events = input.runtimeEvents.filter((event) => !event.partial);
  const turnIds = orderedTurnIds(events, input.modelCallAttempts);
  const eventsByTurn = groupBy(events, (event) => event.turnId);
  const attemptsByTurn = groupBy(input.modelCallAttempts, (attempt) => attempt.turnId);

  const turns: TurnTrace[] = [];
  const turnsMissingModelCalls: string[] = [];
  let turnsWithModelActivity = 0;

  for (const turnId of turnIds) {
    const turnEvents = eventsByTurn.get(turnId) ?? [];
    const turnAttempts = attemptsByTurn.get(turnId) ?? [];
    const turn = projectTurn(turnId, turnEvents, turnAttempts);
    if (!turn) continue;
    turns.push(turn);

    // Aggregate usage on the ledger means the turn made model calls, whatever
    // the metering ledger holds. That disagreement is the coverage signal.
    const hasAggregateUsage = turnEvents.some((event) => event.actions?.tokenUsage !== undefined);
    if (hasAggregateUsage || turnAttempts.length > 0) turnsWithModelActivity += 1;
    if (hasAggregateUsage && turnAttempts.length === 0) turnsMissingModelCalls.push(turnId);
  }

  const totals = turns.reduce<TraceTotals>(
    (carry, turn) => mergeTraceTotals(carry, turn.totals),
    emptyTraceTotals(),
  );

  return {
    schemaVersion: SESSION_TRACE_SCHEMA_VERSION,
    sessionId: input.sessionId,
    turns,
    totals,
    coverage: resolveCoverage(turnsWithModelActivity, turnsMissingModelCalls),
  };
}

/**
 * Coverage is a session-level fact, because that is the scale at which the
 * dangerous case is legible: a backend outside canonical accounting produces a
 * trace that looks like an idle session unless something says otherwise.
 */
function resolveCoverage(
  turnsWithModelActivity: number,
  turnsMissingModelCalls: string[],
): SessionTraceCoverage {
  if (turnsWithModelActivity === 0) {
    return { modelCalls: 'none', turnsMissingModelCalls: [] };
  }
  if (turnsMissingModelCalls.length === 0) {
    return { modelCalls: 'complete', turnsMissingModelCalls: [] };
  }
  return {
    modelCalls: turnsMissingModelCalls.length === turnsWithModelActivity ? 'absent' : 'partial',
    turnsMissingModelCalls,
  };
}

function projectTurn(
  turnId: string,
  events: readonly RuntimeEvent[],
  attempts: readonly ModelCallAttempt[],
): TurnTrace | undefined {
  if (events.length === 0 && attempts.length === 0) return undefined;
  const runId = events[0]?.runId ?? attempts[0]?.runId ?? '';
  const steps = [...projectModelCallSteps(attempts), ...projectEventSteps(events)].sort(
    (left, right) => left.startedAt - right.startedAt,
  );

  const startedAt = Math.min(...steps.map((step) => step.startedAt));
  const endedAt = Math.max(...steps.map((step) => stepEndedAt(step)));
  const totals = turnTotals(steps, endedAt - startedAt);
  const failure = attributeTurnFailure(steps);

  return {
    turnId,
    runId,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    steps,
    totals,
    ...(failure ? { failure } : {}),
  };
}

/**
 * One step per logical call, attempts nested under it.
 *
 * Retries share a `logicalCallId` by contract, so this is a grouping rather
 * than a heuristic — the reason that field is explicit on the record instead of
 * reconstructed from `(traceId, step)` by every consumer.
 */
function projectModelCallSteps(attempts: readonly ModelCallAttempt[]): TraceModelCallStep[] {
  const byLogicalCall = groupBy(attempts, (attempt) => attempt.logicalCallId);
  const steps: TraceModelCallStep[] = [];

  for (const [logicalCallId, group] of byLogicalCall) {
    const ordered = [...group].sort((left, right) => left.attempt - right.attempt);
    const last = ordered[ordered.length - 1]!;
    const first = ordered[0]!;
    const startedAt = Math.min(...ordered.map((attempt) => attempt.startedAt));
    const endedAt = Math.max(...ordered.map((attempt) => attempt.completedAt));
    const priced = ordered.filter((attempt) => attempt.costUsd !== undefined);

    steps.push({
      kind: 'model_call',
      id: logicalCallId,
      turnId: first.turnId,
      runId: first.runId,
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      callKind: first.callKind,
      providerId: first.providerId,
      modelId: first.modelId,
      ...(first.connectionSlug !== undefined ? { connectionSlug: first.connectionSlug } : {}),
      step: first.step,
      attempts: ordered.map(toTraceAttempt),
      status: last.status,
      // Absent rather than zero when nothing in the group was priced: the sum of
      // no prices is not a price (#1679).
      ...(priced.length > 0
        ? { costUsd: priced.reduce((carry, attempt) => carry + (attempt.costUsd ?? 0), 0) }
        : {}),
    });
  }

  return steps;
}

function toTraceAttempt(attempt: ModelCallAttempt): TraceModelAttempt {
  return {
    attemptId: attempt.attemptId,
    attempt: attempt.attempt,
    status: attempt.status,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    latencyMs: attempt.latencyMs,
    ...(attempt.timeToFirstTokenMs !== undefined
      ? { timeToFirstTokenMs: attempt.timeToFirstTokenMs }
      : {}),
    ...(attempt.finishReason !== undefined ? { finishReason: attempt.finishReason } : {}),
    ...(attempt.errorClass !== undefined ? { errorClass: attempt.errorClass } : {}),
    ...(attempt.inputTokens !== undefined ? { inputTokens: attempt.inputTokens } : {}),
    ...(attempt.outputTokens !== undefined ? { outputTokens: attempt.outputTokens } : {}),
    ...(attempt.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: attempt.cacheReadInputTokens }
      : {}),
    ...(attempt.reasoningTokens !== undefined ? { reasoningTokens: attempt.reasoningTokens } : {}),
    ...(attempt.costUsd !== undefined ? { costUsd: attempt.costUsd } : {}),
    costBasis: attempt.costBasis,
    usageBasis: attempt.usageBasis,
  };
}

/** Causal steps the metering ledger knows nothing about. */
function projectEventSteps(events: readonly RuntimeEvent[]): TraceStep[] {
  const steps: TraceStep[] = [];
  const toolStarts = new Map<string, { id: string; startedAt: number }>();

  for (const event of events) {
    const dispatch = event.actions?.toolDispatch;
    if (dispatch) {
      toolStarts.set(dispatch.providerToolCallId, { id: event.id, startedAt: event.ts });
      steps.push({
        kind: 'tool',
        id: event.id,
        turnId: event.turnId,
        runId: event.runId,
        startedAt: event.ts,
        toolName: dispatch.toolName,
        toolCallId: dispatch.providerToolCallId,
        status: 'in_flight',
        ...(dispatch.recoveryMode ? { recoveryMode: dispatch.recoveryMode } : {}),
      });
      continue;
    }

    if (event.content?.kind === 'function_response') {
      // Settle the dispatch this result answers rather than emitting a second
      // step: a call and its result are one thing to a reader.
      const response = event.content;
      const started = toolStarts.get(response.id);
      const settled = steps.find(
        (step): step is Extract<TraceStep, { kind: 'tool' }> =>
          step.kind === 'tool' && step.id === started?.id,
      );
      if (settled) {
        settled.endedAt = event.ts;
        settled.durationMs = Math.max(0, event.ts - settled.startedAt);
        settled.status = response.isError === true ? 'failed' : 'completed';
      }
      continue;
    }

    const decision = event.actions?.permissionDecision;
    if (decision) {
      steps.push({
        kind: 'permission',
        id: event.id,
        turnId: event.turnId,
        runId: event.runId,
        startedAt: event.ts,
        ...(decision.toolName !== undefined ? { toolName: decision.toolName } : {}),
        decision: decision.decision,
      });
      continue;
    }

    if (event.content?.kind === 'error') {
      steps.push({
        kind: 'error',
        id: event.id,
        turnId: event.turnId,
        runId: event.runId,
        startedAt: event.ts,
        message: event.content.message,
      });
    }
  }

  return steps;
}

/**
 * The first thing that failed, not the last thing that happened.
 *
 * A turn that ends in an error usually ends there *because* of something
 * earlier — a tool that failed, a call that exhausted its retries. Pointing at
 * the terminal event would name the symptom.
 */
export function attributeTurnFailure(
  steps: readonly TraceStep[],
): TraceFailureAttribution | undefined {
  const terminalError = [...steps].reverse().find((step) => step.kind === 'error');
  const firstFailure = steps.find(
    (step) =>
      (step.kind === 'tool' && step.status === 'failed') ||
      (step.kind === 'model_call' && step.status === 'failed') ||
      step.kind === 'error',
  );
  if (!terminalError && !firstFailure) return undefined;

  const code =
    firstFailure?.kind === 'tool'
      ? 'tool_failed'
      : firstFailure?.kind === 'model_call'
        ? 'model_call_failed'
        : 'error';
  return {
    code,
    ...(terminalError?.kind === 'error' ? { message: terminalError.message } : {}),
    ...(firstFailure ? { attributedToStepId: firstFailure.id } : {}),
  };
}

function turnTotals(steps: readonly TraceStep[], durationMs: number): TraceTotals {
  const totals = emptyTraceTotals();
  totals.durationMs = Math.max(0, durationMs);

  for (const step of steps) {
    if (step.kind === 'model_call') {
      totals.modelAttempts += step.attempts.length;
      totals.retries += Math.max(0, step.attempts.length - 1);
      if (step.callKind === 'history_compact' || step.callKind === 'semantic_compact') {
        totals.compactions += 1;
      }
      for (const attempt of step.attempts) {
        totals.inputTokens += attempt.inputTokens ?? 0;
        totals.outputTokens += attempt.outputTokens ?? 0;
        if (attempt.costUsd === undefined) totals.unpricedAttempts += 1;
      }
      if (step.costUsd !== undefined) totals.costUsd = (totals.costUsd ?? 0) + step.costUsd;
    }
  }

  return totals;
}

function stepEndedAt(step: TraceStep): number {
  if (step.kind === 'model_call') return step.endedAt;
  if (step.kind === 'tool') return step.endedAt ?? step.startedAt;
  return step.startedAt;
}

/** Turn order follows first appearance, so a trace reads in the order it ran. */
function orderedTurnIds(
  events: readonly RuntimeEvent[],
  attempts: readonly ModelCallAttempt[],
): string[] {
  const seen = new Map<string, number>();
  for (const event of events) {
    const at = seen.get(event.turnId);
    if (at === undefined || event.ts < at) seen.set(event.turnId, event.ts);
  }
  for (const attempt of attempts) {
    const at = seen.get(attempt.turnId);
    if (at === undefined || attempt.startedAt < at) seen.set(attempt.turnId, attempt.startedAt);
  }
  return [...seen.entries()].sort((left, right) => left[1] - right[1]).map(([turnId]) => turnId);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    const group = groups.get(id);
    if (group) group.push(item);
    else groups.set(id, [item]);
  }
  return groups;
}
