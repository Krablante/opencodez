# OpenCodez

OpenCodez is a small public fork of OpenCode. It preserves upstream behavior and
adds isolated runtime roots, managed System prompts, session-local context
pruning, fork-specific updates, safe project discovery, and multiserver web
operation.

## Runtime Roots

OpenCodez can run next to upstream OpenCode without sharing mutable state.

```text
~/.config/opencodez
~/.local/share/opencodez
~/.cache/opencodez
~/.local/state/opencodez
```

Upstream environment variables remain available for compatibility. Fork-owned
variables use the `OPENCODEZ_` prefix.

## Install and Update

Install from the public fork:

```bash
curl -fsSL https://raw.githubusercontent.com/Krablante/opencodez/main/install.sh | bash
```

Update an installed binary from GitHub Releases:

```bash
opencodez update
```

On Unix, the updater uses `sudo` only when the current binary is installed in a
protected system path. Installations older than `1.17.20+opencodez.2` require
one bootstrap run with `sudo opencodez update`; later releases elevate only the
atomic replacement step automatically.

Managed hosts can install `/usr/local/sbin/opencodez-install` with a scoped
sudoers rule. The updater prefers that helper for a non-interactive atomic
replacement of `/usr/local/bin/opencodez`, then falls back to the normal
interactive sudo flow when the helper is absent.

Release versions use the upstream base plus OpenCodez build metadata, for
example `1.18.4+opencodez.1`. The release tag and embedded binary version must
match exactly.

## System Prompt Library

OpenCodez has one managed prompt concept: System Prompt. User prompt files live
in:

```text
~/.config/opencodez/prompts/core/<name>.md
```

Bundled files are copied only when missing, so user edits are preserved. The
selector combines bundled Codex prompts, upstream OpenCode built-ins, and custom
files from this directory.

The same System selector is available in both generations of the Web/Desktop
prompt composer. New sessions carry the selected prompt in submission metadata;
existing sessions keep their server-side selection when models or layouts
change.

Bundled Codex-derived prompts include:

```text
codex_gpt_5_2
codex_gpt_5_2_codex
codex_gpt_5_3_codex
codex_gpt_5_4
codex_gpt_5_4_mini
codex_gpt_5_5
codex_gpt_5_6_luna_terra
codex_gpt_5_6_sol
```

The GPT 5.5, GPT 5.6 Luna/Terra, and GPT 5.6 Sol prompts come from the official
Codex `rust-v0.144.1` model catalog. Luna and Terra share one prompt. Sol has a
separate prompt. The official GPT 5.6 Personality sections remain embedded in
their System prompts.

## Model Defaults

OpenCodez selects these System prompts by default for OpenAI Responses GPT
models:

```text
gpt-5.2 -> codex_gpt_5_2
gpt-5.2-codex -> codex_gpt_5_2_codex
gpt-5.3-codex -> codex_gpt_5_3_codex
gpt-5.3-codex-spark -> codex_gpt_5_3_codex
gpt-5.4 -> codex_gpt_5_4
gpt-5.4-mini -> codex_gpt_5_4_mini
gpt-5.5 -> codex_gpt_5_5
gpt-5.6-luna -> codex_gpt_5_6_luna_terra
gpt-5.6-terra -> codex_gpt_5_6_luna_terra
gpt-5.6-sol -> codex_gpt_5_6_sol
```

Users can override defaults in `~/.config/opencodez/opencode.jsonc`:

```jsonc
{
  "opencodez": {
    "responses": {
      "system": {
        "default": "codex_gpt_5_5",
        "gpt-5.6-luna": "codex_gpt_5_6_luna_terra",
        "gpt-5.6-terra": "codex_gpt_5_6_luna_terra",
        "gpt-5.6-sol": "codex_gpt_5_6_sol"
      }
    }
  }
}
```

## Session Behavior

An inherited System choice follows the active model. Switching from Luna to Sol
therefore changes the effective prompt automatically. A manual `/system` choice
belongs to the session and remains active across model changes.

Choosing `None` explicitly disables the selectable System prompt for the
session. Older prompt metadata fields are ignored safely when historical
sessions are read.

## Commands

```text
/system
/system <name>
/system none
/pruning
/pruning on
/pruning off
/pruning size <count>
```

`/system` opens the System selector when no name is provided. The web composer
exposes the same `S: <id>` control.

## Context Pruning

Pruning changes only the request sent to the model. Stored messages remain
unchanged. Old reasoning payloads and tool results can be replaced with readable
placeholders while recent and protected tools remain intact.

```jsonc
{
  "opencodez": {
    "pruning": {
      "enabled": true,
      "pruning_size": 20000,
      "prune": {
        "reasoning": true,
        "tool": true
      },
      "preserve_tools": []
    }
  }
}
```

Session-local pruning changes do not rewrite this file.

## Web Operation

`OPENCODE_WEB_SERVERS_JSON` can seed managed server connections in the web app.
Valid user-stored servers remain authoritative and environment entries fill only
missing URLs.

OpenCodez can embed the built web UI as one packed binary asset. Runtime delivery
unpacks it in memory, applies SPA fallback, preserves MIME types, serves
compressed variants, and emits `Vary: Accept-Encoding`. A versioned on-disk UI
cache remains available when configured.

## Project Safety

Non-git projects remain scoped to the selected directory. Explicit filesystem
roots clamp to the user home directory, and FFF indexing is disabled by default.
This prevents accidental root-wide indexing.

## Implementation Map

```text
packages/core/src/opencodez/settings.ts
packages/core/src/opencodez/session.ts
packages/core/src/opencodez/slash.ts
packages/opencode/src/opencodez/prompt-library.ts
packages/opencode/src/opencodez/default-prompts/
packages/opencode/src/session/llm/request.ts
packages/opencode/src/session/llm/context-prune.ts
packages/opencode/src/server/routes/instance/httpapi/groups/opencodez.ts
packages/opencode/src/server/routes/instance/httpapi/handlers/opencodez.ts
packages/tui/src/component/opencodez-dialogs.tsx
packages/app/src/components/prompt-input.tsx
```

The OpenAPI document and JavaScript SDK are generated from the server contract.

## Release Verification

A release should confirm the mapped System prompts, old metadata tolerance,
pruning, generated SDK, one production Linux build, embedded web UI startup, and
desktop/mobile System selector behavior. The public release must contain all
platform archives plus one SHA-256 file per archive.
