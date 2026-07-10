# Changelog

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
