/**
 * Session Inspector trace projection (#1625).
 *
 * Run: `npm --workspace @maka/runtime run test`
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { projectSessionTrace } from '../session-trace-projection.js';

function attempt(overrides: Partial<ModelCallAttempt> = {}): ModelCallAttempt {
  return {
    schemaVersion: MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
    logicalCallId: 'call-1',
    attemptId: 'attempt-1',
    traceId: 'trace-1',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    step: 0,
    attempt: 0,
    callKind: 'main',
    providerId: 'anthropic',
    modelId: 'claude-test',
    startedAt: 1_000,
    completedAt: 1_500,
    latencyMs: 500,
    status: 'completed',
    usageBasis: 'reported',
    inputTokens: 10,
    outputTokens: 5,
    costBasis: 'priced',
    costUsd: 0.002,
    ...overrides,
  };
}

function event(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id: 'event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1_000,
    partial: false,
    role: 'model',
    author: 'agent',
    ...overrides,
  };
}

describe('session trace projection', () => {
  test('groups retries of one logical call into a single step', () => {
    // Retries share a `logicalCallId` by contract, so "this call was retried"
    // is a grouping rather than something the reader has to reconstruct.
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [],
      modelCallAttempts: [
        attempt({
          attemptId: 'a-0',
          attempt: 0,
          status: 'failed',
          costUsd: undefined,
          costBasis: 'unpriced',
        }),
        attempt({ attemptId: 'a-1', attempt: 1, startedAt: 1_600, completedAt: 2_000 }),
      ],
    });

    assert.equal(trace.turns.length, 1);
    const steps = trace.turns[0]!.steps;
    assert.equal(steps.length, 1, 'one logical call is one step');
    const call = steps[0]!;
    assert.equal(call.kind, 'model_call');
    if (call.kind !== 'model_call') return;
    assert.equal(call.attempts.length, 2);
    assert.equal(call.status, 'completed', 'the step carries the last attempt outcome');
    assert.equal(trace.totals.modelAttempts, 2);
    assert.equal(trace.totals.retries, 1, 'attempts beyond the first are retries');
    // Only the second attempt was priced, so the step's cost is that one.
    assert.equal(call.costUsd, 0.002);
    assert.equal(trace.totals.unpricedAttempts, 1);
  });

  test('a session of entirely unpriced calls totals to no price, not to zero', () => {
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [],
      modelCallAttempts: [attempt({ costUsd: undefined, costBasis: 'unpriced' })],
    });

    assert.equal(trace.totals.costUsd, undefined, 'absent price is not a zero price');
    assert.equal(trace.totals.unpricedAttempts, 1);
    assert.equal(trace.turns[0]?.steps[0]?.kind, 'model_call');
  });

  test('counts compaction calls made inside a turn', () => {
    // The compaction kinds settle through the same seam as the send they
    // interrupt (#1877), so a compacted turn shows what compacting cost.
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [],
      modelCallAttempts: [
        attempt({ logicalCallId: 'call-main', attemptId: 'a-main' }),
        attempt({
          logicalCallId: 'call-compact',
          attemptId: 'a-compact',
          callKind: 'history_compact',
          startedAt: 1_600,
          completedAt: 1_900,
          costUsd: 0.001,
        }),
      ],
    });

    const totals = trace.turns[0]!.totals;
    assert.equal(totals.compactions, 1);
    assert.equal(totals.modelAttempts, 2);
    assert.equal(totals.costUsd, 0.003, 'compaction cost belongs to the turn it interrupted');
  });

  test('pairs a tool dispatch with the result that answers it', () => {
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [
        event({
          id: 'dispatch-1',
          ts: 1_000,
          actions: {
            toolDispatch: {
              protocol: 't1_after_preflight_v1',
              operationId: 'op-1',
              providerToolCallId: 'tool-call-1',
              toolName: 'Bash',
              canonicalArgsHash: 'hash',
              recoveryMode: 'replay_safe',
            },
          },
        }),
        event({
          id: 'response-1',
          ts: 1_800,
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'tool-call-1',
            name: 'Bash',
            result: 'boom',
            isError: true,
          },
        }),
      ],
      modelCallAttempts: [],
    });

    const steps = trace.turns[0]!.steps;
    assert.equal(steps.length, 1, 'a call and its result are one step to a reader');
    const tool = steps[0]!;
    assert.equal(tool.kind, 'tool');
    if (tool.kind !== 'tool') return;
    assert.equal(tool.toolName, 'Bash');
    assert.equal(tool.status, 'failed');
    assert.equal(tool.durationMs, 800);
  });

  test('attributes a turn failure to what failed first, not to the terminal error', () => {
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [
        event({
          id: 'dispatch-1',
          ts: 1_000,
          actions: {
            toolDispatch: {
              protocol: 't1_after_preflight_v1',
              operationId: 'op-1',
              providerToolCallId: 'tool-call-1',
              toolName: 'Bash',
              canonicalArgsHash: 'hash',
              recoveryMode: 'replay_safe',
            },
          },
        }),
        event({
          id: 'response-1',
          ts: 1_200,
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'tool-call-1',
            name: 'Bash',
            result: 'boom',
            isError: true,
          },
        }),
        event({
          id: 'error-1',
          ts: 2_000,
          content: { kind: 'error', message: 'turn ended after tool failure' },
        }),
      ],
      modelCallAttempts: [],
    });

    const failure = trace.turns[0]!.failure;
    assert.ok(failure);
    assert.equal(failure.code, 'tool_failed');
    assert.equal(failure.attributedToStepId, 'dispatch-1', 'the symptom is not the cause');
    assert.equal(failure.message, 'turn ended after tool failure');
  });

  test('reports a backend that emits no canonical records instead of rendering an idle session', () => {
    // The pi backend emits `token_usage` and no `ModelCallAttempt` at all. An
    // empty timeline would be indistinguishable from a session that did nothing.
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [
        event({
          id: 'usage-1',
          ts: 1_000,
          actions: { tokenUsage: { input: 100, output: 20, total: 120 } },
        }),
      ],
      modelCallAttempts: [],
    });

    assert.equal(trace.coverage.modelCalls, 'absent');
    assert.deepEqual(trace.coverage.turnsMissingModelCalls, ['turn-1']);
    assert.equal(trace.totals.modelAttempts, 0);
    assert.equal(trace.totals.costUsd, undefined);
  });

  test('distinguishes a partially covered session from a wholly uncovered one', () => {
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [
        event({
          id: 'usage-1',
          turnId: 'turn-1',
          ts: 1_000,
          actions: { tokenUsage: { input: 100, output: 20, total: 120 } },
        }),
        event({
          id: 'usage-2',
          turnId: 'turn-2',
          ts: 3_000,
          actions: { tokenUsage: { input: 50, output: 10, total: 60 } },
        }),
      ],
      modelCallAttempts: [attempt({ turnId: 'turn-2', startedAt: 3_000, completedAt: 3_200 })],
    });

    assert.equal(trace.coverage.modelCalls, 'partial');
    assert.deepEqual(trace.coverage.turnsMissingModelCalls, ['turn-1']);
    assert.equal(trace.turns.map((turn) => turn.turnId).join(','), 'turn-1,turn-2');
  });

  test('a session with no model activity is uncovered rather than incomplete', () => {
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [event({ content: { kind: 'text', text: 'hi' } })],
      modelCallAttempts: [],
    });

    assert.equal(trace.coverage.modelCalls, 'none');
    assert.deepEqual(trace.coverage.turnsMissingModelCalls, []);
  });

  test('ignores partial streaming events', () => {
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [
        event({ id: 'partial-1', partial: true, content: { kind: 'error', message: 'transient' } }),
      ],
      modelCallAttempts: [attempt()],
    });

    const steps = trace.turns[0]!.steps;
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.kind, 'model_call');
    assert.equal(trace.turns[0]?.failure, undefined);
  });
});
