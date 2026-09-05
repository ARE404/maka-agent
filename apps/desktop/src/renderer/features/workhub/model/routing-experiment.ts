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
  createWorkHubR24RoutingStrategy,
  createWorkHubR3ARoutingStrategy,
  createWorkHubR3BRoutingStrategy,
  type WorkHubRoutingModelPort,
  type WorkHubRoutingSessionFacts,
  type WorkHubRoutingStrategy,
  type WorkHubRoutingStrategyId,
  type WorkHubRoutingTarget,
  type WorkHubRoutingTranscriptTurn,
} from './routing-strategy.js';

export interface WorkHubRoutingExperimentCase {
  readonly caseId: string;
  readonly text: string;
  readonly explicitTarget?: WorkHubRoutingTarget;
}

export interface WorkHubRoutingExperimentContext {
  readonly snapshotId: string;
  readonly sessions: readonly WorkHubRoutingSessionFacts[];
  readonly coordinationTranscript: readonly WorkHubRoutingTranscriptTurn[];
  /** Opaque Gate/runtime fixture shared by every arm. */
  readonly runtimeState: Readonly<Record<string, unknown>>;
}

export interface WorkHubRoutingExperimentShell<Result> {
  submit(input: {
    readonly requestId: string;
    readonly text: string;
    readonly explicitTarget?: WorkHubRoutingTarget;
  }): Promise<Result>;
}

export interface WorkHubRoutingExperimentObservation<Result> {
  readonly repetition: number;
  readonly caseId: string;
  readonly strategyId: WorkHubRoutingStrategyId;
  readonly result: Result;
}

/**
 * Comparison harness only: it selects no winner and computes no Slice 7
 * metrics. One model port, immutable context, case order, and shell factory are
 * reused across every arm; each arm gets fresh visit focus per repetition.
 */
export async function runWorkHubRoutingExperiment<
  Result extends { readonly strategyId: WorkHubRoutingStrategyId },
>(input: {
  readonly repetitions: number;
  readonly cases: readonly WorkHubRoutingExperimentCase[];
  readonly context: WorkHubRoutingExperimentContext;
  readonly model: WorkHubRoutingModelPort;
  readonly createShell: (input: {
    readonly repetition: number;
    readonly strategy: WorkHubRoutingStrategy;
    readonly context: WorkHubRoutingExperimentContext;
  }) => WorkHubRoutingExperimentShell<Result>;
}): Promise<Array<WorkHubRoutingExperimentObservation<Result>>> {
  if (!Number.isSafeInteger(input.repetitions) || input.repetitions < 1) {
    throw new Error('WorkHub routing experiment repetitions must be a positive integer');
  }
  const context: WorkHubRoutingExperimentContext = Object.freeze({
    ...input.context,
    sessions: Object.freeze(input.context.sessions.map((session) => Object.freeze({
      ...session,
      target: Object.freeze({ ...session.target }),
    }))),
    coordinationTranscript: Object.freeze(input.context.coordinationTranscript.map((turn) =>
      Object.freeze({ ...turn }))),
    runtimeState: Object.freeze({ ...input.context.runtimeState }),
  });
  const observations: Array<WorkHubRoutingExperimentObservation<Result>> = [];
  for (let repetition = 0; repetition < input.repetitions; repetition += 1) {
    const strategies = [
      createWorkHubR24RoutingStrategy(),
      createWorkHubR3ARoutingStrategy({ model: input.model }),
      createWorkHubR3BRoutingStrategy({ model: input.model }),
    ];
    for (const strategy of strategies) {
      const shell = input.createShell({ repetition, strategy, context });
      for (const experimentCase of input.cases) {
        const result = await shell.submit({
          requestId: [
            context.snapshotId,
            String(repetition),
            strategy.strategyId,
            experimentCase.caseId,
          ].join(':'),
          text: experimentCase.text,
          ...(experimentCase.explicitTarget
            ? { explicitTarget: experimentCase.explicitTarget }
            : {}),
        });
        if (result.strategyId !== strategy.strategyId) {
          throw new Error('WorkHub routing experiment shell changed the selected strategy');
        }
        observations.push({
          repetition,
          caseId: experimentCase.caseId,
          strategyId: strategy.strategyId,
          result,
        });
      }
    }
  }
  return observations;
}
