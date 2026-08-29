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
import type { WorkHubSessionSummary } from "../../renderer/workhub-controller.js";
import {
  deriveWorkHubAnchors,
  matchesWorkHubFilter,
  MAX_WORKHUB_ANCHORS,
} from "../../renderer/workhub-anchor-rail.js";

function session(
  sessionId: string,
  state: WorkHubSessionSummary["state"],
  updatedAt: number,
  archived = false,
): WorkHubSessionSummary {
  return {
    target: { sessionId },
    projectName: "Maka",
    sessionName: sessionId,
    archived,
    state,
    updatedAt,
  };
}

const sessions = [
  session("recent", "active", 100),
  session("focus", "running", 10),
  session("delegated", "waiting_for_user", 20),
  session("blocked", "blocked", 90),
  session("stopped", "aborted", 80),
  session("archived", "active", 110, true),
];

test("anchors prioritize focus and delegation before recent Session facts", () => {
  const anchors = deriveWorkHubAnchors({
    sessions,
    focusSessionId: "focus",
    delegatedSessionIds: ["delegated", "focus", "missing"],
    filter: "all",
  });
  assert.deepEqual(
    anchors.map(({ session: value, reason }) => [
      value.target.sessionId,
      reason,
    ]),
    [
      ["focus", "focus"],
      ["delegated", "delegated"],
      ["archived", "recent"],
      ["recent", "recent"],
      ["blocked", "recent"],
      ["stopped", "recent"],
    ],
  );
});

test("filters are derived from Session state and archive facts only", () => {
  assert.deepEqual(
    sessions
      .filter((value) => matchesWorkHubFilter(value, "active"))
      .map((value) => value.target.sessionId),
    ["recent", "focus"],
  );
  assert.deepEqual(
    sessions
      .filter((value) => matchesWorkHubFilter(value, "attention"))
      .map((value) => value.target.sessionId),
    ["delegated", "blocked"],
  );
  assert.deepEqual(
    sessions
      .filter((value) => matchesWorkHubFilter(value, "stopped"))
      .map((value) => value.target.sessionId),
    ["stopped", "archived"],
  );
});

test("anchor projection is deduplicated and hard-bounded", () => {
  const many = Array.from({ length: 20 }, (_, index) =>
    session(`session-${index}`, "active", index),
  );
  const anchors = deriveWorkHubAnchors({
    sessions: many,
    delegatedSessionIds: many.map((value) => value.target.sessionId),
    filter: "all",
    limit: 99,
  });
  assert.equal(anchors.length, MAX_WORKHUB_ANCHORS);
  assert.equal(
    new Set(anchors.map(({ session: value }) => value.target.sessionId)).size,
    anchors.length,
  );
});

test("filtering never mutates the authoritative projection", () => {
  const before = structuredClone(sessions);
  deriveWorkHubAnchors({
    sessions,
    delegatedSessionIds: [],
    filter: "attention",
  });
  assert.deepEqual(sessions, before);
});
