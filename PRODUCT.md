# Maka Product Context

## Identity

- **Register:** product
- **Platform:** web UI rendered inside the Maka Electron desktop app
- **Purpose:** A local-first workspace where people collaborate with coding agents while keeping execution, permissions, artifacts, and recovery inspectable.

## Users

Maka serves people doing real project work across multiple local codebases. They want one calm place to state intent and continue work without manually managing chat routing, but they still need direct access to every underlying Session when precision or inspection matters.

## Positioning

Maka is a recoverable agent workspace, not a disposable chatbot. Unified Session extends that promise with one permanent default entry point across all Maka Workspaces. It understands which work the user means, coordinates or creates ordinary Sessions, and presents their progress without erasing the existing Session model.

## Personality

Calm, precise, capable, and human. The interface should feel like a focused collaborator: clear about scope and state, quiet when nothing needs attention, and explicit before consequential actions. Avoid mascots, fake emotion, decorative chrome, card soup, and novelty chat metaphors.

## Unified Session invariants

- Unified Session is a permanent global Work Orchestrator, not a merged super-transcript.
- Enabling it makes Unified the cold-start destination and starts with the normal Session sidebar collapsed, never removed.
- Discussion remains in Unified. Clear executable intent creates or resumes an ordinary target Session.
- Every executing work item owns an independent message block and stream labelled with Workspace, Work, and state.
- Unified-origin turns are projected into the target Session; work performed directly in a target Session produces only low-noise lifecycle events in Unified.
- The target Session remains authoritative for transcript, model, permission mode, runtime, artifacts, and recovery.
- Registered Workspaces are routable globally. Unknown locations require user confirmation before registration.
- Existing permission cards and privacy/incognito behavior remain authoritative.
- Users can jump into a target Session and return to Unified without losing either context.
- Disabling the feature is reversible and preserves all created work.

## Accessibility

Preserve the existing keyboard navigation, visible focus, semantic labels, reduced-motion behavior, and AA-level contrast targets. Streaming state must not rely on animation or color alone.
