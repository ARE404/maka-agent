import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createArrivalBottomPin,
  releasesArrivalPin,
  type ArrivalPinSizeObserver,
} from '../arrival-bottom-pin.js';

/**
 * Clamps `scrollTop` the way a real scroller does, so the assertions below can
 * be written as the contract — flush against the bottom — rather than as the
 * literal value the pin happens to assign. Writing `scrollHeight` is how the
 * pin asks for "as far down as this goes"; an unclamping fake would let a pin
 * that overshot by a viewport still look correct.
 */
function fakeViewport(initial: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  let scrollTop = initial.scrollTop;
  return {
    scrollHeight: initial.scrollHeight,
    clientHeight: initial.clientHeight,
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
    },
    get distanceFromBottom() {
      return this.scrollHeight - scrollTop - this.clientHeight;
    },
    addEventListener(type: string, listener: (event: Event) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      listeners.get(type)?.delete(listener);
    },
    emit(type: string, event: Partial<Event> = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event as Event);
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

function fakeSizeObserver() {
  let notify: (() => void) | undefined;
  let observed: Element | undefined;
  let disconnected = false;
  return {
    factory: (callback: () => void): ArrivalPinSizeObserver => {
      notify = callback;
      return {
        observe: (element) => { observed = element; },
        disconnect: () => { disconnected = true; },
      };
    },
    grow: () => notify?.(),
    get observed() { return observed; },
    get disconnected() { return disconnected; },
  };
}

describe('releasesArrivalPin', () => {
  it('reads an upward scroll with unchanged geometry as the reader taking over', () => {
    assert.equal(
      releasesArrivalPin({
        scrollTop: 900,
        lastScrollTop: 1_400,
        scrollHeight: 2_000,
        lastScrollHeight: 2_000,
        clientHeight: 600,
        lastClientHeight: 600,
      }),
      true,
    );
  });

  it('ignores the synthetic scroll Chromium fires when the document grows', () => {
    // The arrival window is nothing but growth: every mounted chunk and every
    // warmed placeholder fires a scroll event whose scrollTop can read lower
    // than the pin's last write. Only geometry that held still is evidence.
    assert.equal(
      releasesArrivalPin({
        scrollTop: 900,
        lastScrollTop: 1_400,
        scrollHeight: 4_000,
        lastScrollHeight: 2_000,
        clientHeight: 600,
        lastClientHeight: 600,
      }),
      false,
    );
    assert.equal(
      releasesArrivalPin({
        scrollTop: 900,
        lastScrollTop: 1_400,
        scrollHeight: 2_000,
        lastScrollHeight: 2_000,
        clientHeight: 500,
        lastClientHeight: 600,
      }),
      false,
    );
  });

  it('holds the pin through a sub-pixel readback of its own write', () => {
    assert.equal(
      releasesArrivalPin({
        scrollTop: 1_399.5,
        lastScrollTop: 1_400,
        scrollHeight: 2_000,
        lastScrollHeight: 2_000,
        clientHeight: 600,
        lastClientHeight: 600,
      }),
      false,
    );
  });
});

describe('createArrivalBottomPin', () => {
  it('consumes every growth step instantly while pinned', () => {
    const viewport = fakeViewport({ scrollTop: 0, scrollHeight: 800, clientHeight: 600 });
    const observer = fakeSizeObserver();
    const content = {} as Element;
    const states: string[] = [];
    const pin = createArrivalBottomPin({
      viewport,
      content,
      onStateChange: (state) => { states.push(state); },
      createSizeObserver: observer.factory,
    });

    // Positioned on creation: the transcript's first commit is already growth.
    assert.equal(viewport.distanceFromBottom, 0);
    assert.equal(observer.observed, content);
    viewport.scrollHeight = 15_000;
    observer.grow();
    assert.equal(viewport.distanceFromBottom, 0);
    viewport.scrollHeight = 32_908;
    observer.grow();
    assert.equal(viewport.distanceFromBottom, 0);
    assert.deepEqual(states, ['pinned']);
    assert.equal(pin.isPinned(), true);
  });

  it('stops following once the reader scrolls up, and stays released', () => {
    const viewport = fakeViewport({ scrollTop: 0, scrollHeight: 4_000, clientHeight: 600 });
    const observer = fakeSizeObserver();
    const states: string[] = [];
    const pin = createArrivalBottomPin({
      viewport,
      content: {} as Element,
      onStateChange: (state) => { states.push(state); },
      createSizeObserver: observer.factory,
    });

    viewport.scrollTop = 1_000;
    viewport.emit('scroll');
    assert.equal(pin.isPinned(), false);
    viewport.scrollHeight = 9_000;
    observer.grow();
    assert.equal(viewport.scrollTop, 1_000);
    // A later growth step must not re-pin: releasing is permanent for this
    // arrival, the way Astryx's own unlock is.
    viewport.scrollHeight = 15_000;
    observer.grow();
    assert.equal(viewport.scrollTop, 1_000);
    assert.deepEqual(states, ['pinned', 'released']);
  });

  it('follows a growth, rides its synthetic scroll, and still yields to the reader after it', () => {
    const viewport = fakeViewport({ scrollTop: 0, scrollHeight: 800, clientHeight: 600 });
    const observer = fakeSizeObserver();
    const pin = createArrivalBottomPin({
      viewport,
      content: {} as Element,
      createSizeObserver: observer.factory,
    });

    viewport.scrollHeight = 15_000;
    observer.grow();
    assert.equal(viewport.distanceFromBottom, 0);
    // Chromium fires a scroll event for the resize itself. It reports a
    // position the reader never chose, and the pin must not read it as intent.
    viewport.emit('scroll');
    assert.equal(pin.isPinned(), true);

    viewport.scrollTop = 9_000;
    viewport.emit('scroll');
    assert.equal(pin.isPinned(), false);
  });

  it('takes its geometry snapshot from growth it did not write itself', () => {
    // Not every growth reaches the observed content element: the dock (graph
    // status, plan panel) lives inside the scroller but outside the message
    // list, so it moves scrollHeight with a scroll event and nothing else. The
    // snapshot has to follow that too, or the NEXT genuine upward scroll is
    // compared against a stale height, reads as "geometry changed", and the
    // reader silently loses control of the transcript.
    const viewport = fakeViewport({ scrollTop: 0, scrollHeight: 4_000, clientHeight: 600 });
    const pin = createArrivalBottomPin({ viewport, content: null });

    assert.equal(viewport.distanceFromBottom, 0);
    viewport.scrollHeight = 15_000;
    viewport.emit('scroll');
    assert.equal(pin.isPinned(), true);

    viewport.scrollTop = 700;
    viewport.emit('scroll');
    assert.equal(pin.isPinned(), false);
  });

  it('releases on an upward wheel and on a touch drag, before the scroll lands', () => {
    for (const [type, event] of [
      ['wheel', { deltaY: -120 }],
      ['touchmove', {}],
    ] as const) {
      const viewport = fakeViewport({ scrollTop: 0, scrollHeight: 800, clientHeight: 600 });
      const observer = fakeSizeObserver();
      const pin = createArrivalBottomPin({
        viewport,
        content: {} as Element,
        createSizeObserver: observer.factory,
      });
      viewport.emit(type, event as Partial<Event>);
      assert.equal(pin.isPinned(), false, type);
    }
  });

  it('keeps following through a downward wheel', () => {
    const viewport = fakeViewport({ scrollTop: 0, scrollHeight: 800, clientHeight: 600 });
    const observer = fakeSizeObserver();
    const pin = createArrivalBottomPin({
      viewport,
      content: {} as Element,
      createSizeObserver: observer.factory,
    });
    viewport.emit('wheel', { deltaY: 120 } as Partial<Event>);
    assert.equal(pin.isPinned(), true);
  });

  it('detaches every observer and listener on dispose', () => {
    const viewport = fakeViewport({ scrollTop: 0, scrollHeight: 800, clientHeight: 600 });
    const observer = fakeSizeObserver();
    const pin = createArrivalBottomPin({
      viewport,
      content: {} as Element,
      createSizeObserver: observer.factory,
    });
    pin.dispose();
    assert.equal(observer.disconnected, true);
    assert.equal(viewport.listenerCount('scroll'), 0);
    assert.equal(viewport.listenerCount('wheel'), 0);
    assert.equal(viewport.listenerCount('touchmove'), 0);
  });

  it('does nothing but position when the content element is missing', () => {
    const viewport = fakeViewport({ scrollTop: 0, scrollHeight: 800, clientHeight: 600 });
    const observer = fakeSizeObserver();
    createArrivalBottomPin({
      viewport,
      content: null,
      createSizeObserver: observer.factory,
    });
    assert.equal(viewport.distanceFromBottom, 0);
    assert.equal(observer.observed, undefined);
  });
});
