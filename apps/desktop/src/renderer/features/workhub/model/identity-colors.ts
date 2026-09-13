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

/** Extend a presentation-local palette without recoloring known Works.
 * Insert each new hue into the largest empty arc of the OKLCH hue wheel.
 * Equal lightness/chroma make this maximize the minimum OKLab distance.
 * Sorting new IDs makes input ordering irrelevant; duplicate/hidden Works
 * retain their allocation for the lifetime of the WorkHub surface.
 */
export function allocateWorkHubHues(sessionIds: readonly string[], previous: ReadonlyMap<string, number> = new Map()): ReadonlyMap<string, number> {
  const pending = [...new Set(sessionIds)].filter((id) => !previous.has(id)).sort();
  if (pending.length === 0) return previous;
  const next = new Map(previous);
  const hues = [...new Set(previous.values())].sort((a, b) => a - b);
  for (const id of pending) {
    let hue = 250;
    if (hues.length) {
      let largestGap = -1;
      for (let index = 0; index < hues.length; index++) {
        const start = hues[index]!;
        const end = index + 1 < hues.length ? hues[index + 1]! : hues[0]! + 360;
        if (end - start > largestGap) {
          largestGap = end - start;
          hue = (start + largestGap / 2) % 360;
        }
      }
    }
    next.set(id, hue);
    hues.push(hue);
    hues.sort((a, b) => a - b);
  }
  return next;
}
