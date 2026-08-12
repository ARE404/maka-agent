import { memo, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { HoverCard } from '@astryxdesign/core/HoverCard';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

/** Match Astryx scroll-spy: Chromium sub-pixel scroll end can read 1px short. */
const SCROLL_END_EPSILON_PX = 2;
/** Hover falloff radius in ticks (0 = hovered). */
const HOVER_FALLOFF_TICKS = 3;
/**
 * Astryx's HoverCard waits 300ms before opening, which guards against a
 * pointer crossing a wide row on its way somewhere else. A tick is 22px of
 * rail that nothing else is on the way to, and the wait is the one part of
 * this hover with no motion in it — 300ms of nothing reads as lag rather than
 * as restraint.
 */
const PREVIEW_DELAY_MS = 120;
/**
 * How long a click-driven jump suppresses the highlight's glide when no
 * `scrollend` arrives — a smooth scroll of the whole transcript takes a few
 * hundred milliseconds, and overshooting only means the next scroll-driven
 * move is placed rather than animated.
 */
const JUMP_SETTLE_TIMEOUT_MS = 700;

interface PromptRailResizeObserver {
  observe(target: Element): void;
  disconnect(): void;
}

type PromptRailResizeObserverFactory = (
  onResize: () => void,
) => PromptRailResizeObserver;

const createPromptRailResizeObserver: PromptRailResizeObserverFactory = (onResize) =>
  new ResizeObserver(onResize);

/** Keep the active tick reachable without scrolling the transcript ancestor. */
export function keepActivePromptRailTickVisible(rail: HTMLElement): void {
  const tick = rail.querySelector<HTMLElement>('.maka-prompt-rail-tick[data-active="true"]');
  if (!tick) return;
  const railBox = rail.getBoundingClientRect();
  const tickBox = tick.getBoundingClientRect();
  if (tickBox.top < railBox.top) rail.scrollTop -= railBox.top - tickBox.top;
  else if (tickBox.bottom > railBox.bottom)
    rail.scrollTop += tickBox.bottom - railBox.bottom;
}

/** Frame scheduler seam, so the jump hold can be driven by a test. */
export interface PromptRailFrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

const browserFrameScheduler: PromptRailFrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/**
 * Hold a jump's destination while the transcript grows under it.
 *
 * A jump into a part of the transcript the progressive mount has not reached
 * has to mount it first, and the fill that follows changes the scroller's
 * height for several frames afterwards. Astryx's auto-follow lock unlocks on a
 * scroll up, but deliberately ignores any scroll event that arrives with a
 * changed `scrollHeight`, reading it as a resize artefact rather than the
 * reader moving — so a jump landing mid-fill leaves the lock on, and the lock
 * pulls the transcript back to the bottom. Re-aiming on each height change
 * holds the destination until the fill stops, and the last of those scrolls
 * lands with a stable height, which is the one the lock finally reads.
 *
 * Only height changes re-aim: correcting every frame would flatten the smooth
 * scroll into a jump, and reacting to nothing at all is the bug.
 */
export function holdJumpDestination(
  root: Element,
  readTargetId: () => string | null,
  scheduler: PromptRailFrameScheduler = browserFrameScheduler,
): () => void {
  let handle = 0;
  let lastHeight = root.scrollHeight;
  const hold = (): void => {
    handle = scheduler.request(hold);
    if (root.scrollHeight === lastHeight) return;
    lastHeight = root.scrollHeight;
    const turnId = readTargetId();
    if (turnId === null) return;
    const target = root.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`);
    // `auto`: this is a correction, not a second journey.
    if (target) (target as HTMLElement).scrollIntoView({ behavior: 'auto', block: 'start' });
  };
  handle = scheduler.request(hold);
  return () => scheduler.cancel(handle);
}

export function observeActivePromptRailVisibility(
  rail: HTMLElement,
  createObserver: PromptRailResizeObserverFactory = createPromptRailResizeObserver,
): () => void {
  const observer = createObserver(() => keepActivePromptRailTickVisible(rail));
  observer.observe(rail);
  keepActivePromptRailTickVisible(rail);
  return () => observer.disconnect();
}

export interface PromptAnchorRailTurn {
  turnId: string;
  label: string;
  reply?: string;
}

export interface PromptAnchorRailProps {
  turns: readonly PromptAnchorRailTurn[];
  scrollRef: RefObject<HTMLElement | null>;
  scrollBehavior: ScrollBehavior;
  /** When progressive mount has not yet placed the turn in the DOM. */
  onNavigateFallback?: (turnId: string) => void;
  /** Bumped when turn DOM membership changes without `turns` changing. */
  mountedTurnsRevision?: number;
}

/** Right-edge rail: one tick per user prompt, scrolls to `[data-turn-id]`. */
export const PromptAnchorRail = memo(function PromptAnchorRail({ turns, scrollRef, scrollBehavior, onNavigateFallback, mountedTurnsRevision }: PromptAnchorRailProps): React.ReactElement | null {
  const copy = getConversationCopy(useUiLocale()).sessions;
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [safeArea, setSafeArea] = useState<{ scrollport: number; dock: number } | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [jumping, setJumping] = useState(false);
  // The turn a click aimed at, held until that click's scroll settles. A ref,
  // not state: the observer effect reads it on every scroll frame and must not
  // be torn down and rebuilt over the whole transcript when it changes.
  const jumpTargetRef = useRef<string | null>(null);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || turns.length === 0) return;

    const idByElement = new Map<Element, string>();
    for (const turn of turns) {
      const el = root.querySelector(`[data-turn-id="${CSS.escape(turn.turnId)}"]`);
      if (el) idByElement.set(el, turn.turnId);
    }
    if (idByElement.size === 0) return;

    const visible = new Set<string>();
    const resolveActive = (): void => {
      // A jump owns the highlight until its scroll settles. Without this the
      // observer walks the highlight through every prompt the scroll passes,
      // which is the travelling the click was meant to skip — suppressing the
      // glide alone would only turn one long slide into a burst of hops.
      if (jumpTargetRef.current !== null) return;
      if (root.scrollHeight - root.scrollTop - root.clientHeight <= SCROLL_END_EPSILON_PX) {
        setActiveTurnId(turns[turns.length - 1]!.turnId);
        return;
      }
      const firstVisible = turns.find((turn) => visible.has(turn.turnId));
      if (firstVisible) setActiveTurnId(firstVisible.turnId);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = idByElement.get(entry.target);
          if (!id) continue;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        resolveActive();
      },
      { root, rootMargin: '0px 0px -66% 0px', threshold: 0 },
    );
    for (const el of idByElement.keys()) observer.observe(el);

    let frame = 0;
    const onScroll = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        resolveActive();
      });
    };
    root.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      observer.disconnect();
      root.removeEventListener('scroll', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [scrollRef, turns, mountedTurnsRevision]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    // Astryx renders the dock as the scroll container's last child; the
    // scroll-geometry spec reads it the same way for want of a published hook.
    const dock = root.lastElementChild;
    const measure = (): void => {
      setSafeArea((previous) => {
        const next = {
          scrollport: root.clientHeight,
          dock: dock?.getBoundingClientRect().height ?? 0,
        };
        return previous && previous.scrollport === next.scrollport && previous.dock === next.dock
          ? previous
          : next;
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    if (dock) observer.observe(dock);
    measure();
    return () => observer.disconnect();
  }, [scrollRef]);

  // Past enough prompts the rail hits its cap and becomes a scroller of its own,
  // and then marking a tick active is not enough — the tick can be outside the
  // rail's own viewport, where it is neither visible nor clickable. Scrolling
  // the main transcript to the end of a 60-prompt conversation put the last
  // tick there while the rail sat at scrollTop 0.
  //
  // Deliberately arithmetic on the rail rather than `scrollIntoView`: that
  // walks every scrollable ancestor, and the nearest one here is the
  // transcript itself. Nudging the rail must never move the conversation the
  // reader is scrolling.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || activeTurnId === null) return;
    return observeActivePromptRailVisibility(rail);
  }, [activeTurnId, turns]);

  // The highlight glides between prompts because the reader is following it as
  // the transcript scrolls under it. A click is the opposite: the reader picked
  // the destination, so the highlight switches there once and holds, and the
  // scroll the click started moves underneath it without moving it. `jumping`
  // (the CSS side) kills the glide for that one switch; `jumpTargetRef` (read
  // by the observer above) is what keeps the scroll from walking the highlight
  // through every prompt it passes on the way.
  useEffect(() => {
    if (!jumping) return;
    const root = scrollRef.current;
    const settle = (): void => {
      jumpTargetRef.current = null;
      setJumping(false);
    };
    // `scrollend` alone would end the jump the moment the transcript grows
    // under it (see the frame loop below), so the jump holds for its full
    // window and the timer is what ends it.
    const timer = window.setTimeout(settle, JUMP_SETTLE_TIMEOUT_MS);
    if (!root) return () => window.clearTimeout(timer);

    // The other half of the same click: a jump into an unmounted part of the
    // transcript has to survive the fill that follows it. See
    // `holdJumpDestination`.
    const releaseHold = holdJumpDestination(root, () => jumpTargetRef.current);

    return () => {
      window.clearTimeout(timer);
      releaseHold();
    };
  }, [jumping, scrollRef]);

  function jumpTo(turnId: string): void {
    const el = scrollRef.current?.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`);
    // Claimed before the scroll starts: a same-frame `scroll` event would
    // otherwise reach the observer while the highlight is still unowned.
    jumpTargetRef.current = turnId;
    if (el && 'scrollIntoView' in el) {
      (el as HTMLElement).scrollIntoView({ behavior: scrollBehavior, block: 'start' });
    } else if (!el) {
      onNavigateFallback?.(turnId);
    }
    setJumping(true);
    setActiveTurnId(turnId);
  }

  // A rail is only useful once there are a few prompts to jump between.
  if (turns.length < 3) return null;

  return (
    <div
      className="maka-prompt-rail-anchor"
      style={
        safeArea
          ? ({
              '--maka-prompt-rail-scrollport': `${safeArea.scrollport}px`,
              '--maka-prompt-rail-dock': `${safeArea.dock}px`,
            } as CSSProperties)
          : undefined
      }
    >
      <nav
        className="maka-prompt-rail"
        aria-label={copy.promptRailAriaLabel}
        data-jumping={jumping ? 'true' : undefined}
        ref={railRef}
        onPointerLeave={() => setHoveredIndex(null)}
      >
        {turns.map((turn, index) => {
          const isActive = turn.turnId === activeTurnId;
          const preview = turn.label.trim() || copy.emptyPrompt;
          const replyPreview = (turn.reply ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
          const proximity =
            hoveredIndex === null
              ? HOVER_FALLOFF_TICKS
              : Math.min(Math.abs(index - hoveredIndex), HOVER_FALLOFF_TICKS);
          return (
            <HoverCard
              key={turn.turnId}
              placement="start"
              delay={PREVIEW_DELAY_MS}
              content={
                <span className="maka-prompt-rail-preview">
                  <span className="maka-prompt-rail-preview-prompt">{preview}</span>
                  {replyPreview ? (
                    <span className="maka-prompt-rail-preview-reply">{replyPreview}</span>
                  ) : null}
                </span>
              }
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                label={copy.jumpToPrompt(preview)}
                className="maka-prompt-rail-tick"
                data-active={isActive ? 'true' : undefined}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => jumpTo(turn.turnId)}
                onPointerEnter={() => setHoveredIndex(index)}
                style={
                  {
                    '--maka-prompt-rail-index': index,
                    '--maka-prompt-rail-proximity': proximity,
                  } as CSSProperties
                }
              >
                <span className="maka-prompt-rail-tick-bar" />
              </Button>
            </HoverCard>
          );
        })}
        <span className="maka-prompt-rail-indicator" aria-hidden="true" />
      </nav>
    </div>
  );
});
