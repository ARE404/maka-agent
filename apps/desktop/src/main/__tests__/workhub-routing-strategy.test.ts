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

import assert from "node:assert/strict";
import test from "node:test";
import type { WorkHubSessionFacts } from "../../renderer/workhub-controller.js";
import type { WorkHubRoutePolicy } from "../../renderer/workhub-route-policy.js";
import {
  createWorkHubR24RoutingStrategy,
  createWorkHubR3ARoutingStrategy,
  createWorkHubR3BRoutingStrategy,
  WORKHUB_R24_ROUTING_STRATEGY_ID,
  WORKHUB_R3A_ROUTING_STRATEGY_ID,
  WORKHUB_R3B_ROUTING_STRATEGY_ID,
  type WorkHubModelDisposition,
  type WorkHubModelRoutingRequest,
} from "../../renderer/features/workhub/index.js";

const sessions: WorkHubSessionFacts[] = [
  {
    target: { sessionId: "session-secret-alpha" },
    projectName: "Maka",
    sessionName: "Alpha release",
    kind: "ordinary",
    archived: false,
    state: "active",
    latestResult: "Release checklist drafted",
    updatedAt: 2,
  },
  {
    target: { sessionId: "session-secret-beta" },
    projectName: "Maka",
    sessionName: "Beta migration",
    kind: "ordinary",
    archived: false,
    state: "blocked",
    updatedAt: 1,
  },
];

const baseInput = {
  text: "Continue the Alpha release checklist",
  sessions,
  originPromptBySessionId: new Map([
    ["session-secret-alpha", "Prepare the Alpha release"],
    ["session-secret-beta", "Migrate the Beta store"],
  ]),
  candidateRefBySessionId: new Map([
    ["session-secret-alpha", "candidate-a"],
    ["session-secret-beta", "candidate-b"],
  ]),
  coordinationTranscript: [
    { userText: "What is active?", assistantText: "Alpha release is active." },
  ],
};

test("R2.4 implements the shared versioned strategy interface", async () => {
  const strategy = createWorkHubR24RoutingStrategy();
  assert.equal(strategy.strategyId, WORKHUB_R24_ROUTING_STRATEGY_ID);
  assert.deepEqual(await strategy.resolve(baseInput), {
    kind: "target",
    target: { sessionId: "session-secret-alpha" },
    evidence: "exact_session_name",
  });
});

test("R3-A exposes only bounded candidate refs and accepts one listed target", async () => {
  let request: WorkHubModelRoutingRequest | undefined;
  const strategy = createWorkHubR3ARoutingStrategy({
    model: {
      async decide(input) {
        request = input;
        return {
          disposition: "delegate_existing",
          candidateRef: "candidate-b",
        };
      },
    },
  });
  strategy.initializeFocus(sessions.map((entry) => entry.target));

  assert.deepEqual(await strategy.resolve(baseInput), {
    kind: "target",
    target: { sessionId: "session-secret-beta" },
    evidence: "model_candidate",
  });
  assert.equal(strategy.strategyId, WORKHUB_R3A_ROUTING_STRATEGY_ID);
  assert.equal(request?.mayChooseCandidate, true);
  assert.deepEqual(
    request?.candidates.map((candidate) => candidate.candidateRef),
    ["candidate-a", "candidate-b"],
  );
  assert.equal(request?.candidates[0]?.focus, "current");
  assert.equal(request?.candidates[1]?.focus, "previous");
  assert.doesNotMatch(JSON.stringify(request), /session-secret/u);
  assert.deepEqual(
    request?.coordinationTranscript,
    baseInput.coordinationTranscript,
  );
});

test("R3-A fails closed when a model invents a candidate", async () => {
  const strategy = createWorkHubR3ARoutingStrategy({
    model: {
      async decide() {
        return { disposition: "delegate_existing", candidateRef: "invented" };
      },
    },
  });

  const decision = await strategy.resolve(baseInput);
  assert.equal(decision.kind, "clarification");
  if (decision.kind === "clarification")
    assert.deepEqual(decision.options, sessions);
});

test("R3 model input is bounded and cannot select a candidate outside that bound", async () => {
  const manySessions = Array.from(
    { length: 14 },
    (_, index): WorkHubSessionFacts => ({
      ...sessions[0]!,
      target: { sessionId: `secret-${index}` },
      sessionName: `Candidate ${index}`,
      latestResult: "r".repeat(900),
      updatedAt: 20 - index,
    }),
  );
  let request: WorkHubModelRoutingRequest | undefined;
  const strategy = createWorkHubR3ARoutingStrategy({
    model: {
      async decide(input) {
        request = input;
        return {
          disposition: "delegate_existing",
          candidateRef: "candidate-13",
        };
      },
    },
  });
  const boundedInput = {
    text: "x".repeat(2_500),
    sessions: manySessions,
    originPromptBySessionId: new Map(),
    coordinationTranscript: [],
    candidateRefBySessionId: new Map(
      manySessions.map((entry, index) => [
        entry.target.sessionId,
        `candidate-${index}`,
      ]),
    ),
  };
  const decision = await strategy.resolve(boundedInput);

  assert.equal(request?.candidates.length, 12);
  assert.equal(Array.from(request?.text ?? "").length, 2_000);
  assert.equal(
    Array.from(request?.candidates[0]?.latestResult ?? "").length,
    600,
  );
  assert.equal(decision.kind, "clarification");
  if (decision.kind === "clarification")
    assert.equal(decision.options.length, 5);

  const outsideCandidateInput = {
    ...boundedInput,
    text: "Continue Candidate 13",
  };
  const baselineDecision = await createWorkHubR24RoutingStrategy().resolve(
    outsideCandidateInput,
  );
  assert.deepEqual(baselineDecision, {
    kind: "target",
    target: { sessionId: "secret-13" },
    evidence: "exact_session_name",
  });
  assert.deepEqual(
    await createWorkHubR3BRoutingStrategy({
      model: {
        async decide() {
          return { disposition: "delegate_existing" };
        },
      },
    }).resolve(outsideCandidateInput),
    baselineDecision,
  );
});

test("R3-B lets the model choose disposition but R2.4 choose a delegated target", async () => {
  let request: WorkHubModelRoutingRequest | undefined;
  const strategy = createWorkHubR3BRoutingStrategy({
    model: {
      async decide(input) {
        request = input;
        return { disposition: "delegate_existing" };
      },
    },
  });

  assert.deepEqual(await strategy.resolve(baseInput), {
    kind: "target",
    target: { sessionId: "session-secret-alpha" },
    evidence: "exact_session_name",
  });
  assert.equal(strategy.strategyId, WORKHUB_R3B_ROUTING_STRATEGY_ID);
  assert.equal(request?.mayChooseCandidate, false);
});

test("R3-B invokes R2.4 only after the model selects delegation", async () => {
  for (const disposition of [
    "answer_here",
    "clarify",
    "create_new",
  ] satisfies WorkHubModelDisposition[]) {
    const tracked = trackingBaseline();
    const strategy = createWorkHubR3BRoutingStrategy({
      baseline: tracked.policy,
      model: {
        async decide() {
          assert.equal(tracked.resolveCalls(), 0);
          return { disposition };
        },
      },
    });
    await strategy.resolve(baseInput);
    assert.equal(tracked.resolveCalls(), 0);
  }

  const tracked = trackingBaseline();
  const strategy = createWorkHubR3BRoutingStrategy({
    baseline: tracked.policy,
    model: {
      async decide() {
        assert.equal(tracked.resolveCalls(), 0);
        return { disposition: "delegate_existing" };
      },
    },
  });
  assert.equal((await strategy.resolve(baseInput)).kind, "target");
  assert.equal(tracked.resolveCalls(), 1);
});

test("R3-B never turns an R2.4 create result into an executable create", async () => {
  const strategy = createWorkHubR3BRoutingStrategy({
    model: {
      async decide() {
        return { disposition: "delegate_existing" };
      },
    },
  });

  const decision = await strategy.resolve({
    ...baseInput,
    text: "Create a brand-new session called Gamma launch",
  });
  assert.equal(decision.kind, "clarification");
});

test("R3-B freezes its R2.4 target before awaiting the model", async () => {
  let releaseModel: (() => void) | undefined;
  const modelPending = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  const strategy = createWorkHubR3BRoutingStrategy({
    model: {
      async decide() {
        await modelPending;
        return { disposition: "delegate_existing" };
      },
    },
  });
  strategy.initializeFocus(sessions.map((entry) => entry.target));

  const pending = strategy.resolve({
    ...baseInput,
    text: "Continue this work",
  });
  strategy.rememberTarget(sessions[1]!.target);
  releaseModel?.();

  assert.deepEqual(await pending, {
    kind: "target",
    target: sessions[0]!.target,
    evidence: "recent_focus",
  });
});

test("explicit user targets bypass both R3 model strategies", async () => {
  let calls = 0;
  const model = {
    async decide() {
      calls += 1;
      return { disposition: "clarify" as const };
    },
  };
  for (const strategy of [
    createWorkHubR3ARoutingStrategy({ model }),
    createWorkHubR3BRoutingStrategy({ model }),
  ]) {
    assert.deepEqual(
      await strategy.resolve({
        ...baseInput,
        explicitTarget: { sessionId: "session-secret-beta" },
      }),
      {
        kind: "target",
        target: { sessionId: "session-secret-beta" },
        evidence: "explicit_target",
      },
    );
  }
  assert.equal(calls, 0);
});

test("model failures fail closed without creating work", async () => {
  const strategy = createWorkHubR3ARoutingStrategy({
    model: {
      async decide() {
        throw new Error("provider unavailable");
      },
    },
  });
  assert.equal((await strategy.resolve(baseInput)).kind, "clarification");
  assert.equal(
    (await strategy.resolve({ ...baseInput, sessions: [] })).kind,
    "discussion",
  );
});

test("model creation requires trusted explicit creation intent", async () => {
  const strategy = createWorkHubR3ARoutingStrategy({
    model: {
      async decide() {
        return { disposition: "create_new" };
      },
    },
  });

  assert.equal((await strategy.resolve(baseInput)).kind, "clarification");
  assert.deepEqual(
    await strategy.resolve({
      ...baseInput,
      text: "Create a new session called Gamma launch",
    }),
    { kind: "new_session", title: "Gamma launch" },
  );
});

test("malformed or over-specified model responses fail closed", async () => {
  const malformedR3A: unknown[] = [
    null,
    "delegate_existing",
    { disposition: "delegate_existing" },
    { disposition: "delegate_existing", candidateRef: "invented" },
    { disposition: "answer_here", candidateRef: "candidate-a" },
    { disposition: "clarify", extra: true },
  ];
  for (const response of malformedR3A) {
    const strategy = createWorkHubR3ARoutingStrategy({
      model: {
        async decide() {
          return response as never;
        },
      },
    });
    assert.equal((await strategy.resolve(baseInput)).kind, "clarification");
  }

  for (const response of [
    null,
    { disposition: "delegate_existing", candidateRef: "candidate-a" },
    { disposition: "create_new", candidateRef: "candidate-a" },
  ]) {
    const strategy = createWorkHubR3BRoutingStrategy({
      model: {
        async decide() {
          return response as never;
        },
      },
    });
    assert.equal((await strategy.resolve(baseInput)).kind, "clarification");
  }
});

function trackingBaseline(): {
  readonly policy: WorkHubRoutePolicy;
  readonly resolveCalls: () => number;
} {
  let calls = 0;
  const policy: WorkHubRoutePolicy = {
    resolveStop() {
      return { kind: "not_requested" };
    },
    resolve() {
      calls += 1;
      return {
        kind: "target",
        target: sessions[0]!.target,
        evidence: "exact_session_name",
      };
    },
    initializeFocus() {},
    focusSnapshot() {
      return {};
    },
    snapshot() {
      return policy;
    },
    newVisit() {
      return policy;
    },
    rememberTarget() {},
  };
  return { policy, resolveCalls: () => calls };
}
