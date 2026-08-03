import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { useEffect, useState } from 'react';
import type { MermaidConfig } from 'mermaid';
import { useUiLocale } from './locale-context.js';
import { getSharedUiCopy } from './shared-ui-copy.js';

export const MAX_MERMAID_SOURCE_LENGTH = 20_000;
export const MAX_MERMAID_EDGES = 500;

type MermaidTheme = 'default' | 'dark';

type MermaidRenderState =
  | { status: 'loading' }
  | { status: 'rendered'; svg: string }
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

  useEffect(() => {
    if (props.code.length > MAX_MERMAID_SOURCE_LENGTH) {
      setState({ status: 'error', reason: 'too-large' });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });
    void renderMermaid(props.code, theme).then(
      (svg) => {
        if (!cancelled) setState({ status: 'rendered', svg });
      },
      () => {
        if (!cancelled) setState({ status: 'error', reason: 'invalid' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [props.code, theme]);

  const className = `maka-markdown-code maka-markdown-code-${props.density}`;
  if (state.status === 'rendered') {
    return (
      <figure
        className={`${className} maka-mermaid-diagram`}
        data-maka-contract="mermaid"
        data-maka-mermaid-state="rendered"
        aria-label={copy.mermaidDiagram}
      >
        <div
          className="maka-mermaid-svg"
          // Mermaid's strict security level disables link callbacks, encodes
          // HTML labels, and sanitizes the SVG before this trusted-library
          // output crosses React's HTML boundary. We never call bindFunctions.
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
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
