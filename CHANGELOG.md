# Changelog

## Unreleased

### Changed

- Made default-disabled FFF a true zero-index mode: OpenCodez no longer starts the upstream `rg --files` fallback or retains a background path index when `OPENCODE_DISABLE_FFF=1`. Directory browsing and explicit agent file tools remain available.
- Made the v2 Web composer controls shrink and truncate inside narrow/mobile layouts, with icon-only Agent, System, and Variant controls and readable Model priority, so every control remains contained without changing desktop spacing.
- Updated the fork base from upstream OpenCode `1.18.4` to `1.18.11` while keeping the OpenCodez prompt, project, updater, embedded Web UI, Responses wire, and remote compaction layers isolated.
- Adopted upstream fixes for MCP SSE reconnect loops, configurable interleaved reasoning fields, stale prompt controls and session tabs, narrow file-tree tabs, directory selection, and external desktop links.
- Adopted upstream's current project-scoped MCP state loading.
- Ported OpenCodez prompt metadata into the current App prompt controller and session-creation flow.
- History edits now force one safe full request before incremental ChatGPT OAuth continuation resumes on the resulting branch.
- OpenAI Zero Data Retention remote compaction lowers compact input with `store: false`, sends encrypted reasoning state instead of non-persisted item references, and replays compacted state after the current system prefix.
- Made ChatGPT OAuth Fast aliases use real Codex product priority routing without extra probes or UI state. Standard/Fast switches still force a safe full request, and continuation is now account-scoped so a login change cannot reuse inaccessible response or reasoning IDs.
- Fixed automatic remote compaction to distinguish pre-turn from mid-turn pressure: pending input is replayed only before a turn starts, while in-flight user, assistant, and tool work is compacted and continued directly without a synthetic replacement message or restarted task. Provider context-overflow remains an internal recovery signal instead of a transient session error.
- Aligned remote autocompaction orchestration with Codex follow-up semantics: completed final answers no longer trigger redundant compaction, partial provider-overflow progress remains mid-turn, compact requests reuse the exact effective System and tool schemas, steering waits through the first post-compact continuation, and only oversized trailing tool outputs are bounded. The unary remote deadline now matches Codex so large contexts are not aborted after two minutes.
- Closed the remaining remote-compaction recovery edges: newly completed tool output participates in the preflight limit, rejected follow-up requests retain mid-turn history, active request controls remain frozen through compaction, Stop cancels the HTTP operation, unsupported compact output artifacts are discarded, and opaque state is checked against its base API model and ChatGPT account. Manual `/compact` now honors the selected model, and the UI reports completion only after success.
- Kept the TUI System indicator secondary and compact: it is hidden on narrow terminals, capped at 24 columns, and shows only System state.
- ChatGPT OAuth now uses the Codex-compatible stateful Responses WebSocket wire by default. Set `opencodez.responses.wire` to `legacy` to restore the previous full-request flow.
- Stateful continuation sends only new input items with `previous_response_id` while the request prefix, model settings, and live WebSocket remain compatible; reconnects, interruptions, concurrent HTTP fallback, and context changes safely start a new full-request chain.
- ChatGPT OAuth compaction now uses the server-side `responses/compact` endpoint. Opaque compaction output is persisted in the session, restored after restart, and prepended to later Responses requests without resending the pre-compaction history. Remote compaction errors remain visible and never silently downgrade to a local summary.
- Remote compaction defaults to the Codex 90% input-window threshold. `opencodez.responses.compaction.threshold` can compact earlier, while optional `token_limit` provides a lower absolute cap.

## 1.18.4+opencodez.3

Fixed the shared Web/Desktop System prompt selector in both composer
generations. The control now uses a small lifecycle-independent
Portal menu with outside-click and Escape handling, avoiding the v2 composer
slot's popover-anchor remount behavior.

Also fixed the upstream v2 `modelControl` slot to evaluate stateful controls
once. This prevents duplicate Portal content while preserving the existing
model selector contract.

## 1.18.4+opencodez.2

Fixed a ProjectV2 regression: non-git directories now receive stable
directory-scoped project IDs instead of sharing
the global project ID. This prevents a server process first opened at `/` from
widening later non-git workspaces back to the filesystem root.

The publish workflow is now manual-only, preventing a published draft's tag
from launching a second redundant build against an already existing release.

## 1.18.4+opencodez.1

Merged upstream OpenCode `1.18.4` into OpenCodez.

Preserved the complete OpenCodez custom layer: isolated identity and runtime roots, bundled public Codex system prompts, per-session System selection, locally packed Web UI, seeded server connections, MCP visibility, fork-specific updater and release assets, non-git project boundaries, and default-disabled FFF indexing.

Adapted System selection to the upstream Web/Desktop v2 prompt composer through one shared control used by both composer generations. New-session prompt metadata and existing-session selection remain consistent across both interfaces.

Added an optional managed-host install helper for atomic passwordless replacement of `/usr/local/bin/opencodez`. Ordinary public installations keep the existing interactive sudo fallback, so `opencodez update` remains the only update command.

Upstream changes include the Web/Desktop v2 layout and prompt-input migration, configurable subagent depth, provider reasoning fixes, WSL and desktop reliability improvements, and refreshed SDK/OpenAPI surfaces.

## 1.17.20+opencodez.2

Fixed `opencodez update` for protected system-wide installations such as `/usr/local/bin/opencodez`. User-writable installations still use the existing direct atomic replacement; protected Unix targets now fall back to `sudo` for an atomic install without changing the update command.

## 1.17.20+opencodez.1

Merged upstream OpenCode `1.17.20` into OpenCodez.

Preserved the complete OpenCodez custom layer: isolated identity and runtime roots, bundled public Codex system prompts, per-session prompt selection, locally packed Web UI, seeded server connections, MCP visibility fixes, fork-specific updater and release assets, non-git project boundaries, and default-disabled FFF indexing.

Upstream changes include terminal-only client and TUI fixes, refreshed web and desktop interfaces, provider and reasoning updates, GPT 5.6 model limits, Azure AI Foundry support, safer FFF cache defaults, and removal of the temporary Responses Lite compatibility layer now handled by the backend.

## 1.17.18+opencodez.3

Unified OpenCodez prompt control around the active System prompt across config, session state, request preparation, TUI, web, API, SDK, bundled assets, and documentation.

Updated GPT 5.5 to the official Codex system prompt and added the official Codex `0.144.1` system prompts for GPT 5.6 Luna/Terra and Sol. Luna and Terra share one prompt; Sol uses its own prompt with its official embedded Personality section.

## 1.17.18+opencodez.2

Fixed self-update when the download workspace and installed binary are on different filesystems. The updater now copies into a temporary file beside the target before the atomic replacement.

## 1.17.18+opencodez.1

Merged upstream OpenCode `1.17.18` into OpenCodez.

Preserved the OpenCodez identity and isolated runtime roots, System prompt controls, session inheritance, web server seeding, UI asset caching, MCP visibility, project discovery guards, and fork-specific release updater. Adapted the prompt and web integrations to the latest upstream Effect, provider, MCP resource, and composer changes.

Added `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-5.6-sol` System defaults.

Hardened the public release path with exact build-metadata versioning and an OpenCodez-aware Unix installer.

## 1.17.11+opencodez.4

Merged upstream OpenCode `1.17.11` into OpenCodez.

Kept the OpenCodez release/update path, branding, web server seeding, prompt controls, and project discovery/indexing safety guards. Fixed the OpenCodez updater to treat release build metadata such as `+opencodez.4` as a real update target.

Upstream changes include server-aware session routes, session snapshots/revert controls, MCP resource support, plugin API v2, desktop/web polish, and provider integration updates.

## 1.17.8+opencodez.2

Web can seed default server connections from environment config.
