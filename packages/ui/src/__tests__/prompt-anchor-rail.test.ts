import assert from 'node:assert/strict';
import test from 'node:test';
import {
  holdJumpDestination,
  observeActivePromptRailVisibility,
  type PromptRailFrameScheduler,
} from '../prompt-anchor-rail.js';

test('a jump re-aims at its destination every time the transcript grows', () => {
  // The e2e suite cannot stage this: whether the lock wins depends on which
  // frame the progressive fill lands on relative to a smooth scroll still in
  // flight, and it went green against the unfixed renderer often enough to be
  // worthless as a guard. The mechanism is deterministic here.
  // The helper builds its selector with `CSS.escape`, which the renderer has
  // and Node does not. Stubbed rather than worked around in the source: the
  // escaping is what keeps a turn id safe inside a selector, and a fallback
  // that only exists for tests would be the wrong thing to ship.
  const priorCss = (globalThis as { CSS?: unknown }).CSS;
  (globalThis as { CSS?: unknown }).CSS = { escape: (value: string) => value };

  const frames: Array<() => void> = [];
  const scheduler: PromptRailFrameScheduler = {
    request: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancel: () => {},
  };
  const scrolled: Array<ScrollIntoViewOptions | undefined> = [];
  const target = {
    scrollIntoView: (options?: ScrollIntoViewOptions) => scrolled.push(options),
  };
  let scrollHeight = 1_000;
  let queried: string | undefined;
  const root = {
    get scrollHeight() {
      return scrollHeight;
    },
    querySelector: (selector: string) => {
      queried = selector;
      return target;
    },
  } as unknown as Element;

  const release = holdJumpDestination(root, () => 'turn-7', scheduler);
  const runFrame = (): void => frames.shift()?.();

  runFrame();
  assert.equal(scrolled.length, 0, 'a steady transcript is left alone');

  scrollHeight = 1_400;
  runFrame();
  assert.equal(scrolled.length, 1, 'a fill step re-aims the jump');
  assert.deepEqual(scrolled[0], { behavior: 'auto', block: 'start' });
  assert.equal(queried, '[data-turn-id="turn-7"]');

  runFrame();
  assert.equal(scrolled.length, 1, 'the same height does not re-aim again');

  scrollHeight = 1_800;
  runFrame();
  assert.equal(scrolled.length, 2, 'every later fill step re-aims too');

  // Once the jump is over its target is cleared, and a still-growing
  // transcript must no longer be pulled back to it. Started on its own queue:
  // the first hold has a frame pending, and shifting that one instead would
  // measure the loop this case is not about.
  release();
  frames.length = 0;
  const released = holdJumpDestination(root, () => null, scheduler);
  scrollHeight = 2_200;
  runFrame();
  assert.equal(scrolled.length, 2, 'a settled jump releases the transcript');
  released();
  (globalThis as { CSS?: unknown }).CSS = priorCss;
});

test('keeps the active tick visible when the rail viewport resizes', () => {
  let railBox = box(0, 600);
  let tickBox = box(570, 590);
  let onResize: (() => void) | undefined;
  let observed: Element | undefined;
  let disconnected = false;
  const tick = {
    getBoundingClientRect: () => tickBox,
  } as HTMLElement;
  const rail = {
    scrollTop: 384,
    getBoundingClientRect: () => railBox,
    querySelector: () => tick,
  } as unknown as HTMLElement;

  const cleanup = observeActivePromptRailVisibility(rail, (callback) => {
    onResize = callback;
    return {
      observe: (target) => {
        observed = target;
      },
      disconnect: () => {
        disconnected = true;
      },
    };
  });

  assert.equal(observed, rail);
  assert.equal(rail.scrollTop, 384, 'the initial visible tick does not move the rail');

  railBox = box(0, 286);
  onResize?.();
  assert.equal(rail.scrollTop, 688, 'a shorter rail brings the active tick back from below');

  tickBox = box(-30, -10);
  onResize?.();
  assert.equal(rail.scrollTop, 658, 'the same observer also restores a tick above the rail');

  cleanup();
  assert.equal(disconnected, true);
});

function box(top: number, bottom: number): DOMRect {
  return { top, bottom } as DOMRect;
}
