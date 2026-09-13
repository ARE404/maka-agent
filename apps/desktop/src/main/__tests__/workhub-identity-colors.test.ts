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
import { allocateWorkHubHues } from '../../renderer/features/workhub/model/identity-colors.js';

function minimumGap(hues: readonly number[]) {
  const sorted = [...hues].sort((a, b) => a - b);
  return Math.min(...sorted.map((hue, index) => (sorted[(index + 1) % sorted.length]! + (index === sorted.length - 1 ? 360 : 0)) - hue));
}

test('two Works receive opposite hues, even when old hash buckets collide', () => {
  const hues = allocateWorkHubHues(['a', 'g']);
  assert.equal(minimumGap([...hues.values()]), 180);
  assert.deepEqual(allocateWorkHubHues(['g', 'a', 'g']), hues);
});

test('four and eight Works spread out before consuming nearby hues', () => {
  const four = allocateWorkHubHues(['a', 'b', 'c', 'd']);
  assert.equal(minimumGap([...four.values()]), 90);
  const eight = allocateWorkHubHues(['e', 'f', 'g', 'h'], four);
  assert.equal(minimumGap([...eight.values()]), 45);
  for (const [id, hue] of four) assert.equal(eight.get(id), hue);
});

test('filtering, reordering and adding Works never recolor known identities', () => {
  const initial = allocateWorkHubHues(['b', 'c', 'd']);
  assert.equal(allocateWorkHubHues(['d'], initial), initial);
  assert.equal(allocateWorkHubHues(['d', 'b', 'c'], initial), initial);
  const extended = allocateWorkHubHues(['a', 'd'], initial);
  for (const [id, hue] of initial) assert.equal(extended.get(id), hue);
  assert.equal(extended.size, 4);
});

test('large collections avoid exact collisions and stay inside the hue wheel', () => {
  const hues = allocateWorkHubHues(Array.from({length: 100}, (_, i) => String(i)));
  assert.equal(new Set(hues.values()).size, 100);
  for (const hue of hues.values()) assert.ok(hue >= 0 && hue < 360);
});
