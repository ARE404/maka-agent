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

import type { DesktopRuntimeHostProfileChangedEvent } from '../preload/bridge-contract.js';

export type WorkHubCoordinationHostChange = Pick<
  DesktopRuntimeHostProfileChangedEvent,
  'isDefault' | 'readiness'
>;

/** Keeps active WorkHub resolution aligned with the current default Runtime Host. */
export function startWorkHubCoordinationLifecycle(input: {
  readonly resolve: () => Promise<string>;
  readonly subscribeHostChanges: (
    handler: (event: WorkHubCoordinationHostChange) => void,
  ) => () => void;
  readonly onResolving: () => void;
  readonly onResolved: (sessionId: string) => void;
  readonly reportFailure: (error: unknown) => void;
}): () => void {
  let stopped = false;
  let generation = 0;
  const resolve = () => {
    const currentGeneration = ++generation;
    input.onResolving();
    void input.resolve()
      .then((sessionId) => {
        if (!stopped && currentGeneration === generation) input.onResolved(sessionId);
      })
      .catch((error) => {
        if (!stopped && currentGeneration === generation) input.reportFailure(error);
      });
  };
  const unsubscribe = input.subscribeHostChanges((event) => {
    if (!stopped && event.isDefault && event.readiness === 'ready') resolve();
  });
  resolve();
  return () => {
    stopped = true;
    generation += 1;
    unsubscribe();
  };
}
