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

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  startWorkHubCoordinationLifecycle,
  type WorkHubCoordinationHostChange,
} from '../../renderer/workhub-coordination-lifecycle.js';

test('WorkHub resolves on open and ready Host changes, then stops on feature disable', () => {
  let hostChange: ((event: WorkHubCoordinationHostChange) => void) | undefined;
  const calls: string[] = [];
  const stop = startWorkHubCoordinationLifecycle({
    resolve: () => {
      calls.push('resolve');
      return Promise.resolve('coordination-session');
    },
    subscribeHostChanges(handler) {
      hostChange = handler;
      return () => calls.push('unsubscribe');
    },
    onResolving: () => calls.push('resolving'),
    onResolved: (sessionId) => calls.push(`resolved:${sessionId}`),
    reportFailure: () => calls.push('failure'),
  });

  assert.deepEqual(calls, ['resolving', 'resolve']);
  hostChange?.({ isDefault: false, readiness: 'ready' });
  hostChange?.({ isDefault: true, readiness: 'reconnecting' });
  assert.deepEqual(calls, ['resolving', 'resolve']);

  hostChange?.({ isDefault: true, readiness: 'ready' });
  assert.deepEqual(calls, ['resolving', 'resolve', 'resolving', 'resolve']);

  stop();
  assert.deepEqual(calls, ['resolving', 'resolve', 'resolving', 'resolve', 'unsubscribe']);
  hostChange?.({ isDefault: true, readiness: 'ready' });
  assert.deepEqual(calls, ['resolving', 'resolve', 'resolving', 'resolve', 'unsubscribe']);
});

test('WorkHub reports resolver failures without stopping later Host changes', async () => {
  let hostChange: ((event: WorkHubCoordinationHostChange) => void) | undefined;
  const failures: unknown[] = [];
  const failure = new Error('offline');
  const stop = startWorkHubCoordinationLifecycle({
    resolve: () => Promise.reject(failure),
    subscribeHostChanges(handler) {
      hostChange = handler;
      return () => undefined;
    },
    onResolving: () => undefined,
    onResolved: () => undefined,
    reportFailure: (error) => failures.push(error),
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(failures, [failure]);

  hostChange?.({ isDefault: true, readiness: 'ready' });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(failures, [failure, failure]);
  stop();
});

test('WorkHub ignores a stale Host resolution that settles after a newer Host', async () => {
  let hostChange: ((event: WorkHubCoordinationHostChange) => void) | undefined;
  const pending: Array<(sessionId: string) => void> = [];
  const resolved: string[] = [];
  const stop = startWorkHubCoordinationLifecycle({
    resolve: () => new Promise<string>((resolve) => pending.push(resolve)),
    subscribeHostChanges(handler) {
      hostChange = handler;
      return () => undefined;
    },
    onResolving: () => undefined,
    onResolved: (sessionId) => resolved.push(sessionId),
    reportFailure: (error) => assert.fail(error instanceof Error ? error.message : String(error)),
  });

  hostChange?.({ isDefault: true, readiness: 'ready' });
  pending[1]?.('host-b-coordination');
  await Promise.resolve();
  pending[0]?.('host-a-coordination');
  await Promise.resolve();

  assert.deepEqual(resolved, ['host-b-coordination']);
  stop();
});
