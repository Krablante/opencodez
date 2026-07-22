# Changelog

## 1.18.4+opencodez.2

Fixed a ProjectV2 regression discovered during live fleet validation: non-git
directories now receive stable directory-scoped project IDs instead of sharing
the global project ID. This prevents a server process first opened at `/` from
widening later non-git workspaces back to the filesystem root.

## 1.18.4+opencodez.1

Merged upstream OpenCode `1.18.4` into OpenCodez.

Preserved the complete OpenCodez custom layer: isolated identity and runtime roots, bundled public Codex system prompts, per-session System selection, request-local pruning, locally packed Web UI, seeded server connections, MCP visibility, fork-specific updater and release assets, non-git project boundaries, and default-disabled FFF indexing. Politia-local prompts remain external to the public repository and release artifacts.

Adapted System selection to the upstream Web/Desktop v2 prompt composer through one shared control used by both composer generations. New-session prompt metadata and existing-session selection remain consistent across both interfaces.

Added an optional managed-host install helper for atomic passwordless replacement of `/usr/local/bin/opencodez`. Ordinary public installations keep the existing interactive sudo fallback, so `opencodez update` remains the only update command.

Upstream changes include the Web/Desktop v2 layout and prompt-input migration, configurable subagent depth, provider reasoning fixes, WSL and desktop reliability improvements, and refreshed SDK/OpenAPI surfaces.

## 1.17.20+opencodez.2

Fixed `opencodez update` for protected system-wide installations such as `/usr/local/bin/opencodez`. User-writable installations still use the existing direct atomic replacement; protected Unix targets now fall back to `sudo` for an atomic install without changing the update command.

## 1.17.20+opencodez.1

Merged upstream OpenCode `1.17.20` into OpenCodez.

Preserved the complete OpenCodez custom layer: isolated identity and runtime roots, bundled public Codex system prompts, per-session prompt selection, request-local context pruning, locally packed Web UI, seeded server connections, MCP visibility fixes, fork-specific updater and release assets, non-git project boundaries, and default-disabled FFF indexing. Politia-local prompts remain external to the public repository and release artifacts.

Upstream changes include terminal-only client and TUI fixes, refreshed web and desktop interfaces, provider and reasoning updates, GPT 5.6 model limits, Azure AI Foundry support, safer FFF cache defaults, and removal of the temporary Responses Lite compatibility layer now handled by the backend.

## 1.17.18+opencodez.3

Removed Tone and Template as OpenCodez concepts across config, session state, request preparation, TUI, web, API, SDK, bundled assets, and documentation. OpenCodez prompt control now selects only the active System prompt; legacy Tone/Template metadata is ignored safely.

Updated GPT 5.5 to the official Codex system prompt and added the official Codex `0.144.1` system prompts for GPT 5.6 Luna/Terra and Sol. Luna and Terra share one prompt; Sol uses its own prompt with its official embedded Personality section.

## 1.17.18+opencodez.2

Fixed self-update when the download workspace and installed binary are on different filesystems. The updater now copies into a temporary file beside the target before the atomic replacement.

## 1.17.18+opencodez.1

Merged upstream OpenCode `1.17.18` into OpenCodez.

Preserved the OpenCodez identity and isolated runtime roots, managed system/tone prompt controls, session inheritance, request pruning, web server seeding, UI asset caching, MCP visibility, project discovery guards, and fork-specific release updater. Adapted the prompt and web integrations to the latest upstream Effect, provider, MCP resource, and composer changes while dropping compatibility behavior now supplied by upstream.

Added `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-5.6-sol` defaults. All three reuse the bundled GPT 5.5 Codex system prompt and retain the existing tone/personality behavior.

Hardened the public release path with exact build-metadata versioning and an OpenCodez-aware Unix installer.

## 1.17.11+opencodez.4

Merged upstream OpenCode `1.17.11` into OpenCodez.

Kept the OpenCodez release/update path, branding, web server seeding, prompt controls, and project discovery/indexing safety guards. Fixed the OpenCodez updater to treat release build metadata such as `+opencodez.4` as a real update target.

Upstream changes include server-aware session routes, session snapshots/revert controls, MCP resource/template support, plugin API v2, desktop/web polish, and provider integration updates.

## 1.17.8+opencodez.2

Web can seed default server connections from environment config.
