/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import {
  boundedWorkHubText,
  createWorkHubRoutePolicy,
  workHubNewSessionName,
  type WorkHubRouteDecision,
  type WorkHubRoutePolicy,
} from "./route-policy.js";
import { readWorkHubRequestIntent } from "../../../application/contracts/workhub-request-intent.js";

export interface WorkHubRoutingTarget {
  readonly sessionId: string;
}

export interface WorkHubRoutingSessionFacts {
  readonly target: WorkHubRoutingTarget;
  readonly projectName: string;
  readonly sessionName: string;
  readonly state: "active" | "running" | "waiting_for_user" | "blocked" | "aborted";
  readonly latestResult?: string;
  readonly updatedAt: number;
}

export const WORKHUB_R24_ROUTING_STRATEGY_ID =
  "wh-r2.4-session-context-continuity" as const;
export const WORKHUB_R3A_ROUTING_STRATEGY_ID =
  "wh-r3.a-model-disposition-and-target" as const;
export const WORKHUB_R3B_ROUTING_STRATEGY_ID =
  "wh-r3.b-model-disposition-r2.4-target" as const;

export type WorkHubRoutingStrategyId =
  | typeof WORKHUB_R24_ROUTING_STRATEGY_ID
  | typeof WORKHUB_R3A_ROUTING_STRATEGY_ID
  | typeof WORKHUB_R3B_ROUTING_STRATEGY_ID;

export interface WorkHubRoutingInput {
  readonly text: string;
  readonly sessions: readonly WorkHubRoutingSessionFacts[];
  readonly originPromptBySessionId: ReadonlyMap<string, string | undefined>;
  readonly candidateRefBySessionId: ReadonlyMap<string, string>;
  readonly coordinationTranscript: readonly WorkHubRoutingTranscriptTurn[];
  readonly explicitTarget?: WorkHubRoutingTarget;
}

export interface WorkHubRoutingTranscriptTurn {
  readonly userText: string;
  readonly assistantText?: string;
}

export interface WorkHubRoutingStrategy {
  readonly strategyId: WorkHubRoutingStrategyId;
  resolveStop: WorkHubRoutePolicy["resolveStop"];
  resolve(input: WorkHubRoutingInput): Promise<WorkHubRouteDecision>;
  initializeFocus(targets: readonly WorkHubRoutingTarget[]): void;
  newVisit(): WorkHubRoutingStrategy;
  rememberTarget(target: WorkHubRoutingTarget): void;
}

export type WorkHubModelDisposition =
  | "answer_here"
  | "clarify"
  | "delegate_existing"
  | "create_new";

export interface WorkHubModelRoutingCandidate {
  /** Opaque, host-issued reference. A model never receives a Session ID. */
  readonly candidateRef: string;
  readonly projectName: string;
  readonly sessionName: string;
  readonly state: WorkHubRoutingSessionFacts["state"];
  readonly focus?: "current" | "previous";
  readonly latestResult?: string;
  readonly originPrompt?: string;
}

export interface WorkHubModelRoutingRequest {
  readonly strategyId:
    | typeof WORKHUB_R3A_ROUTING_STRATEGY_ID
    | typeof WORKHUB_R3B_ROUTING_STRATEGY_ID;
  readonly text: string;
  readonly coordinationTranscript: readonly WorkHubRoutingTranscriptTurn[];
  readonly candidates: readonly WorkHubModelRoutingCandidate[];
  readonly allowedDispositions: readonly WorkHubModelDisposition[];
  readonly mayChooseCandidate: boolean;
}

export interface WorkHubModelRoutingResponse {
  readonly disposition: WorkHubModelDisposition;
  readonly candidateRef?: string;
}

/**
 * Narrow model seam for the routing experiment. Production adapters own model
 * selection, prompt construction, structured-output parsing, retries, usage,
 * and cost telemetry. This module owns validation and fail-closed behavior.
 */
export interface WorkHubRoutingModelPort {
  decide(
    input: WorkHubModelRoutingRequest,
  ): Promise<WorkHubModelRoutingResponse>;
}

const MAX_ROUTING_CANDIDATES = 12;
const MAX_MODEL_TRANSCRIPT_TURNS = 12;
const MAX_MODEL_INPUT_CHARS = 2_000;
const MAX_MODEL_SUMMARY_CHARS = 600;
const MAX_FAIL_CLOSED_OPTIONS = 5;

export function createWorkHubR24RoutingStrategy(
  policy: WorkHubRoutePolicy = createWorkHubRoutePolicy(),
): WorkHubRoutingStrategy {
  return {
    strategyId: WORKHUB_R24_ROUTING_STRATEGY_ID,
    resolveStop: policy.resolveStop,
    async resolve(input) {
      return policy.resolve({
        text: input.text,
        sessions: [...input.sessions],
        originPromptBySessionId: input.originPromptBySessionId,
        ...(input.explicitTarget
          ? { explicitTarget: input.explicitTarget }
          : {}),
      });
    },
    initializeFocus(targets) {
      policy.initializeFocus(targets);
    },
    newVisit() {
      return createWorkHubR24RoutingStrategy(policy.newVisit());
    },
    rememberTarget(target) {
      policy.rememberTarget(target);
    },
  };
}

export function createWorkHubR3ARoutingStrategy(input: {
  readonly model: WorkHubRoutingModelPort;
  readonly baseline?: WorkHubRoutePolicy;
}): WorkHubRoutingStrategy {
  return createModelRoutingStrategy({
    strategyId: WORKHUB_R3A_ROUTING_STRATEGY_ID,
    model: input.model,
    baseline: input.baseline ?? createWorkHubRoutePolicy(),
  });
}

export function createWorkHubR3BRoutingStrategy(input: {
  readonly model: WorkHubRoutingModelPort;
  readonly baseline?: WorkHubRoutePolicy;
}): WorkHubRoutingStrategy {
  return createModelRoutingStrategy({
    strategyId: WORKHUB_R3B_ROUTING_STRATEGY_ID,
    model: input.model,
    baseline: input.baseline ?? createWorkHubRoutePolicy(),
  });
}

function createModelRoutingStrategy(input: {
  readonly strategyId:
    | typeof WORKHUB_R3A_ROUTING_STRATEGY_ID
    | typeof WORKHUB_R3B_ROUTING_STRATEGY_ID;
  readonly model: WorkHubRoutingModelPort;
  readonly baseline: WorkHubRoutePolicy;
}): WorkHubRoutingStrategy {
  const mayChooseCandidate =
    input.strategyId === WORKHUB_R3A_ROUTING_STRATEGY_ID;
  return {
    strategyId: input.strategyId,
    resolveStop: input.baseline.resolveStop,
    async resolve(routeInput) {
      const boundedInput = boundedRoutingInput(routeInput);
      if (boundedInput.explicitTarget) {
        return {
          kind: "target",
          target: boundedInput.explicitTarget,
          evidence: "explicit_target",
        };
      }
      const focus = input.baseline.focusSnapshot();
      const candidates = modelCandidates(boundedInput, focus);
      const requestIntent = readWorkHubRequestIntent(routeInput.text);
      const allowCreate = requestIntent.creation.explicit &&
        requestIntent.execution === "imperative";
      // Snapshot R2.4 before awaiting the model without resolving it. A later
      // UI focus change cannot alter this request, and non-delegation
      // dispositions never invoke the baseline resolver.
      const baseline = mayChooseCandidate
        ? undefined
        : input.baseline.snapshot();
      let untrustedResponse: unknown;
      try {
        untrustedResponse = await input.model.decide({
          strategyId: input.strategyId,
          text: boundedInput.text,
          coordinationTranscript: boundedInput.coordinationTranscript,
          candidates,
          allowedDispositions: [
            "answer_here",
            "clarify",
            "delegate_existing",
            ...(allowCreate ? ["create_new" as const] : []),
          ],
          mayChooseCandidate,
        });
      } catch {
        return failClosed(boundedInput.sessions);
      }
      const response = decodeModelRoutingResponse(untrustedResponse, {
        mayChooseCandidate,
        candidates,
        allowCreate,
      });
      if (!response) {
        return failClosed(boundedInput.sessions);
      }
      if (response.disposition === "answer_here") return { kind: "discussion" };
      if (response.disposition === "clarify") {
        return { kind: "clarification", options: [...boundedInput.sessions] };
      }
      if (response.disposition === "create_new") {
        return {
          kind: "new_session",
          title: workHubNewSessionName(routeInput.text, requestIntent),
        };
      }

      if (mayChooseCandidate) {
        const target = targetForCandidateRef(
          boundedInput,
          candidates,
          response.candidateRef,
        );
        return target
          ? { kind: "target", target, evidence: "model_candidate" }
          : failClosed(boundedInput.sessions);
      }

      // R3-B delegates target choice, and only target choice, to R2.4. A
      // baseline `new_session` result is deliberately not executable here.
      const baselineDecision = baseline?.resolve({
        text: routeInput.text,
        sessions: [...routeInput.sessions],
        originPromptBySessionId: routeInput.originPromptBySessionId,
      });
      if (!baselineDecision) return failClosed(boundedInput.sessions);
      if (
        baselineDecision.kind === "target" ||
        baselineDecision.kind === "clarification"
      ) {
        return baselineDecision;
      }
      return failClosed(boundedInput.sessions);
    },
    initializeFocus(targets) {
      input.baseline.initializeFocus(targets);
    },
    newVisit() {
      return createModelRoutingStrategy({
        ...input,
        baseline: input.baseline.newVisit(),
      });
    },
    rememberTarget(target) {
      input.baseline.rememberTarget(target);
    },
  };
}

function modelCandidates(
  input: WorkHubRoutingInput,
  focus: ReturnType<WorkHubRoutePolicy["focusSnapshot"]>,
): WorkHubModelRoutingCandidate[] {
  return [...input.sessions]
    .flatMap((session) => {
      const candidateRef = input.candidateRefBySessionId.get(
        session.target.sessionId,
      );
      if (!candidateRef) return [];
      return [
        {
          candidateRef,
          projectName: session.projectName,
          sessionName: session.sessionName,
          state: session.state,
          ...(focus.current?.sessionId === session.target.sessionId
            ? { focus: "current" as const }
            : focus.previous?.sessionId === session.target.sessionId
              ? { focus: "previous" as const }
              : {}),
          ...(session.latestResult
            ? { latestResult: session.latestResult }
            : {}),
          ...(input.originPromptBySessionId.get(session.target.sessionId)
            ? {
                originPrompt: input.originPromptBySessionId.get(
                  session.target.sessionId,
                )!,
              }
            : {}),
        },
      ];
    });
}

function targetForCandidateRef(
  input: WorkHubRoutingInput,
  candidates: readonly WorkHubModelRoutingCandidate[],
  candidateRef: string | undefined,
): WorkHubRoutingTarget | undefined {
  if (
    !candidateRef ||
    !candidates.some((candidate) => candidate.candidateRef === candidateRef)
  ) {
    return undefined;
  }
  for (const session of input.sessions) {
    if (
      input.candidateRefBySessionId.get(session.target.sessionId) ===
      candidateRef
    ) {
      return session.target;
    }
  }
  return undefined;
}

function failClosed(
  sessions: readonly WorkHubRoutingSessionFacts[],
): WorkHubRouteDecision {
  return sessions.length > 0
    ? {
        kind: "clarification",
        options: sessions.slice(0, MAX_FAIL_CLOSED_OPTIONS),
      }
    : { kind: "discussion" };
}

function boundedRoutingInput(input: WorkHubRoutingInput): WorkHubRoutingInput {
  const sessions = [...input.sessions]
    .filter((session) =>
      input.candidateRefBySessionId.has(session.target.sessionId),
    )
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        left.target.sessionId.localeCompare(right.target.sessionId),
    )
    .slice(0, MAX_ROUTING_CANDIDATES)
    .map((session) => ({
      ...session,
      projectName: boundedWorkHubText(
        session.projectName,
        MAX_MODEL_SUMMARY_CHARS,
      ),
      sessionName: boundedWorkHubText(
        session.sessionName,
        MAX_MODEL_SUMMARY_CHARS,
      ),
      ...(session.latestResult === undefined
        ? {}
        : {
            latestResult: boundedWorkHubText(
              session.latestResult,
              MAX_MODEL_SUMMARY_CHARS,
            ),
          }),
    }));
  return {
    text: boundedWorkHubText(input.text, MAX_MODEL_INPUT_CHARS),
    sessions,
    originPromptBySessionId: new Map(
      sessions.map((session) => {
        const originPrompt = input.originPromptBySessionId.get(
          session.target.sessionId,
        );
        return [
          session.target.sessionId,
          originPrompt === undefined
            ? undefined
            : boundedWorkHubText(originPrompt, MAX_MODEL_SUMMARY_CHARS),
        ] as const;
      }),
    ),
    candidateRefBySessionId: new Map(
      sessions.map((session) => [
        session.target.sessionId,
        input.candidateRefBySessionId.get(session.target.sessionId)!,
      ]),
    ),
    coordinationTranscript: input.coordinationTranscript
      .slice(-MAX_MODEL_TRANSCRIPT_TURNS)
      .map((turn) => ({
        userText: boundedWorkHubText(
          turn.userText,
          MAX_MODEL_SUMMARY_CHARS,
        ),
        ...(turn.assistantText === undefined
          ? {}
          : {
              assistantText: boundedWorkHubText(
                turn.assistantText,
                MAX_MODEL_SUMMARY_CHARS,
              ),
            }),
      })),
    ...(input.explicitTarget ? { explicitTarget: input.explicitTarget } : {}),
  };
}

function decodeModelRoutingResponse(
  value: unknown,
  input: {
    readonly mayChooseCandidate: boolean;
    readonly candidates: readonly WorkHubModelRoutingCandidate[];
    readonly allowCreate: boolean;
  },
): WorkHubModelRoutingResponse | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const response = value as Record<string, unknown>;
  if (!isValidDisposition(response.disposition)) return undefined;
  if (response.disposition === "create_new" && !input.allowCreate) return undefined;
  if (response.disposition !== "delegate_existing") {
    return hasExactKeys(response, ["disposition"])
      ? { disposition: response.disposition }
      : undefined;
  }
  if (!input.mayChooseCandidate) {
    return hasExactKeys(response, ["disposition"])
      ? { disposition: "delegate_existing" }
      : undefined;
  }
  if (
    !hasExactKeys(response, ["disposition", "candidateRef"]) ||
    typeof response.candidateRef !== "string" ||
    input.candidates.filter(
      (candidate) => candidate.candidateRef === response.candidateRef,
    ).length !== 1
  ) {
    return undefined;
  }
  return {
    disposition: "delegate_existing",
    candidateRef: response.candidateRef,
  };
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function isValidDisposition(value: unknown): value is WorkHubModelDisposition {
  return (
    value === "answer_here" ||
    value === "clarify" ||
    value === "delegate_existing" ||
    value === "create_new"
  );
}
