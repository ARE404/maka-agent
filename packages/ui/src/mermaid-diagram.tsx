import { IconButton } from '@astryxdesign/core';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { useEffect, useRef, useState } from 'react';
import type { MermaidConfig } from 'mermaid';
import { Maximize2, Minimize2, Scan, ZoomIn, ZoomOut } from './icons.js';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';

export const MAX_MERMAID_SOURCE_LENGTH = 20_000;
export const MAX_MERMAID_EDGES = 500;
export const MIN_MERMAID_ZOOM = 0.5;
export const MAX_MERMAID_ZOOM = 3;
export const MERMAID_ZOOM_STEP = 0.25;

type MermaidTheme = 'default' | 'dark';

type MermaidRenderState =
  | { status: 'loading' }
  | { status: 'rendered'; svg: string; naturalWidth: number }
  | { status: 'error'; reason: 'invalid' | 'too-large' };

let mermaidModule: Promise<typeof import('mermaid').default> | undefined;
let renderQueue: Promise<void> = Promise.resolve();
let diagramSequence = 0;

export function createMermaidConfig(theme: MermaidTheme): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    maxTextSize: MAX_MERMAID_SOURCE_LENGTH,
    maxEdges: MAX_MERMAID_EDGES,
    htmlLabels: false,
    logLevel: 'fatal',
    theme,
  };
}

function loadMermaid() {
  mermaidModule ??= import('mermaid').then((module) => module.default);
  return mermaidModule;
}

/**
 * Mermaid owns global configuration, so initialization and rendering must be
 * one serialized operation. This also caps concurrent layout work when one
 * assistant turn contains several diagrams.
 */
function renderMermaid(code: string, theme: MermaidTheme): Promise<string> {
  const task = renderQueue.then(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize(createMermaidConfig(theme));
    const id = `maka-mermaid-${++diagramSequence}`;
    const { svg } = await mermaid.render(id, code);
    return svg;
  });

  renderQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

function currentMermaidTheme(): MermaidTheme {
  if (typeof document === 'undefined') return 'default';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'default';
}

function mermaidViewBoxWidth(svg: string): number {
  const viewBox = /\bviewBox=["']\s*[-+\d.e]+[\s,]+[-+\d.e]+[\s,]+([-+\d.e]+)/i.exec(svg);
  const width = Number(viewBox?.[1]);
  return Number.isFinite(width) && width > 0 ? width : 1200;
}

function clampMermaidZoom(value: number): number {
  return Math.min(MAX_MERMAID_ZOOM, Math.max(MIN_MERMAID_ZOOM, value));
}

function useMermaidTheme(): MermaidTheme {
  const [theme, setTheme] = useState<MermaidTheme>(currentMermaidTheme);

  useEffect(() => {
    const root = document.documentElement;
    const updateTheme = () => setTheme(currentMermaidTheme());
    const observer = new MutationObserver(updateTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    updateTheme();
    return () => observer.disconnect();
  }, []);

  return theme;
}

export function MermaidDiagram(props: { code: string; density: 'default' | 'compact' }) {
  const copy = getSharedUiCopy(useUiLocale()).markdown;
  const theme = useMermaidTheme();
  const [state, setState] = useState<MermaidRenderState>(() =>
    props.code.length > MAX_MERMAID_SOURCE_LENGTH
      ? { status: 'error', reason: 'too-large' }
      : { status: 'loading' },
  );
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [panning, setPanning] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

  useEffect(() => {
    if (props.code.length > MAX_MERMAID_SOURCE_LENGTH) {
      setState({ status: 'error', reason: 'too-large' });
      return;
    }

    let cancelled = false;
    setZoom(1);
    setState({ status: 'loading' });
    void renderMermaid(props.code, theme).then(
      (svg) => {
        if (!cancelled) setState({ status: 'rendered', svg, naturalWidth: mermaidViewBoxWidth(svg) });
      },
      () => {
        if (!cancelled) setState({ status: 'error', reason: 'invalid' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [props.code, theme]);

  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [expanded]);

  function updateZoom(nextZoom: number) {
    const next = clampMermaidZoom(nextZoom);
    if (next === zoom) return;
    const viewport = viewportRef.current;
    const centerX = viewport && viewport.scrollWidth > 0
      ? (viewport.scrollLeft + viewport.clientWidth / 2) / viewport.scrollWidth
      : 0.5;
    const centerY = viewport && viewport.scrollHeight > 0
      ? (viewport.scrollTop + viewport.clientHeight / 2) / viewport.scrollHeight
      : 0.5;
    setZoom(next);
    requestAnimationFrame(() => {
      if (!viewport) return;
      viewport.scrollLeft = centerX * viewport.scrollWidth - viewport.clientWidth / 2;
      viewport.scrollTop = centerY * viewport.scrollHeight - viewport.clientHeight / 2;
    });
  }

  function resetViewport() {
    setZoom(1);
    requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    });
  }

  const className = `maka-markdown-code maka-markdown-code-${props.density}`;
  if (state.status === 'rendered') {
    const zoomPercent = Math.round(zoom * 100);
    const canvasWidth = `min(${state.naturalWidth * zoom}px, ${zoomPercent}%)`;
    return (
      <figure
        className={`${className} maka-mermaid-diagram${expanded ? ' maka-mermaid-diagram-expanded' : ''}`}
        data-maka-contract="mermaid"
        data-maka-mermaid-state="rendered"
        data-maka-mermaid-zoom={zoom.toFixed(2)}
        aria-label={copy.mermaidDiagram}
      >
        <figcaption className="maka-mermaid-toolbar">
          <span className="maka-mermaid-title">{copy.mermaidDiagram}</span>
          <div className="maka-mermaid-actions" role="toolbar" aria-label={copy.mermaidToolbar}>
            <IconButton
              size="sm"
              variant="ghost"
              label={copy.mermaidZoomOut}
              tooltip={copy.mermaidZoomOut}
              isDisabled={zoom <= MIN_MERMAID_ZOOM}
              onClick={() => updateZoom(zoom - MERMAID_ZOOM_STEP)}
              icon={<ZoomOut aria-hidden="true" />}
            />
            <output className="maka-mermaid-zoom-level" aria-label={copy.mermaidZoomLevel(zoomPercent)}>
              {zoomPercent}%
            </output>
            <IconButton
              size="sm"
              variant="ghost"
              label={copy.mermaidZoomIn}
              tooltip={copy.mermaidZoomIn}
              isDisabled={zoom >= MAX_MERMAID_ZOOM}
              onClick={() => updateZoom(zoom + MERMAID_ZOOM_STEP)}
              icon={<ZoomIn aria-hidden="true" />}
            />
            <IconButton
              size="sm"
              variant="ghost"
              label={copy.mermaidResetView}
              tooltip={copy.mermaidResetView}
              onClick={resetViewport}
              icon={<Scan aria-hidden="true" />}
            />
            <IconButton
              size="sm"
              variant="ghost"
              label={expanded ? copy.mermaidCollapseView : copy.mermaidExpandView}
              tooltip={expanded ? copy.mermaidCollapseView : copy.mermaidExpandView}
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
              icon={expanded
                ? <Minimize2 aria-hidden="true" />
                : <Maximize2 aria-hidden="true" />}
            />
          </div>
        </figcaption>
        <div
          ref={viewportRef}
          className="maka-mermaid-viewport"
          data-maka-mermaid-panning={panning ? 'true' : 'false'}
          aria-label={copy.mermaidViewport}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === '+' || event.key === '=') {
              event.preventDefault();
              updateZoom(zoom + MERMAID_ZOOM_STEP);
            } else if (event.key === '-' || event.key === '_') {
              event.preventDefault();
              updateZoom(zoom - MERMAID_ZOOM_STEP);
            } else if (event.key === '0') {
              event.preventDefault();
              resetViewport();
            }
          }}
          onWheel={(event) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            updateZoom(zoom + (event.deltaY < 0 ? MERMAID_ZOOM_STEP : -MERMAID_ZOOM_STEP));
          }}
          onPointerDown={(event) => {
            const viewport = viewportRef.current;
            if (!viewport || event.button !== 0) return;
            if (viewport.scrollWidth <= viewport.clientWidth && viewport.scrollHeight <= viewport.clientHeight) return;
            panRef.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              scrollLeft: viewport.scrollLeft,
              scrollTop: viewport.scrollTop,
            };
            viewport.setPointerCapture(event.pointerId);
            setPanning(true);
          }}
          onPointerMove={(event) => {
            const viewport = viewportRef.current;
            const pan = panRef.current;
            if (!viewport || !pan || pan.pointerId !== event.pointerId) return;
            viewport.scrollLeft = pan.scrollLeft - (event.clientX - pan.x);
            viewport.scrollTop = pan.scrollTop - (event.clientY - pan.y);
          }}
          onPointerUp={(event) => {
            if (panRef.current?.pointerId !== event.pointerId) return;
            panRef.current = null;
            setPanning(false);
          }}
          onPointerCancel={() => {
            panRef.current = null;
            setPanning(false);
          }}
        >
          <div className="maka-mermaid-canvas" style={{ width: canvasWidth }}>
            <div
              className="maka-mermaid-svg"
              // Mermaid's strict security level disables link callbacks, encodes
              // HTML labels, and sanitizes the SVG before this trusted-library
              // output crosses React's HTML boundary. We never call bindFunctions.
              dangerouslySetInnerHTML={{ __html: state.svg }}
            />
          </div>
        </div>
      </figure>
    );
  }

  const message = state.status === 'loading'
    ? copy.mermaidRendering
    : state.reason === 'too-large'
      ? copy.mermaidTooLarge
      : copy.mermaidRenderFailed;

  return (
    <div
      className={`${className} maka-mermaid-fallback`}
      data-maka-contract="mermaid"
      data-maka-mermaid-state={state.status}
    >
      <CodeBlock
        code={props.code}
        language="mermaid"
        hasCopyButton
        isCollapsible
      />
      <span className="maka-mermaid-status" role="status">
        {message}
      </span>
    </div>
  );
}
