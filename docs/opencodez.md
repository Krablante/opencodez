# OpenCodez Docs

This page is the public source of truth for OpenCodez-specific behavior.

OpenCodez is a small, maintainable fork of upstream OpenCode. It keeps the
normal OpenCode product shape, but adds explicit prompt control, bundled
Codex-style prompt presets, session-local prompt selection, safer context
pruning, and bounded project discovery defaults.

The goal is not to turn OpenCodez into a separate product with renamed internals.
OpenCodez should stay easy to compare with upstream OpenCode, easy to rebase,
and easy to use side-by-side with the original `opencode` command.

## Documentation Model

The upstream OpenCode docs explain OpenCode itself.

This page explains only what OpenCodez adds or changes:

- prompt library behavior;
- `/system`, `/tone`, `/template`, `/prompts`, and `/pruning`;
- model-aware prompt defaults;
- session persistence for manual prompt choices;
- project discovery and indexing safety defaults;
- visible progress for release downloads in `opencodez update`;
- OpenCodez config roots, install, and update behavior;
- maintenance rules that keep the fork small.

The root `README.md` should stay as the public GitHub entry point. It should
summarize OpenCodez and link here for the full details.

## Fork Principles

OpenCodez should stay close to OpenCode.

When adding or changing OpenCodez features:

- prefer small additive layers over broad rewrites;
- keep upstream package names, command names, workflows, docs, and integrations
  recognizable;
- do not rename OpenCode internals just to make the fork feel branded;
- do not remove GitHub workflows, actions, locales, or upstream docs unless the
  user explicitly asks for that exact cleanup;
- keep OpenCodez useful outside any one private environment or workflow;
- keep public docs in English.

If a future upstream OpenCode release introduces a similar feature, compare it
against the behavior described here before deciding whether to keep the
OpenCodez version, adapt it, or move to the upstream implementation.

## Install, Update, and Config Roots

OpenCodez is expected to install side-by-side with upstream OpenCode:

```text
opencode   # upstream OpenCode
opencodez  # this fork
```

It uses separate config, data, and cache roots:

```text
~/.config/opencodez/
~/.local/share/opencodez/
~/.cache/opencodez/
```

OpenCodez does not automatically migrate `~/.config/opencode/`. Users who want
to reuse upstream OpenCode settings should copy only the settings and prompt
files they actually want into the OpenCodez config root.

OpenCodez does not publish to npm. Public installs and updates use GitHub
Releases:

```bash
curl -fsSL https://raw.githubusercontent.com/Krablante/opencodez/main/install.sh | sh
```

On Windows, use PowerShell:

```powershell
irm https://raw.githubusercontent.com/Krablante/opencodez/main/install.ps1 | iex
```

Updates use the same release channel:

```bash
opencodez update
opencodez update --check
```

These commands download ready-made release artifacts, not a source checkout.
They use the public release channel, not the local dogfooding path. If a local
binary is newer than the latest published GitHub Release, `opencodez update`
does not downgrade it.

Public OpenCodez releases should be created through the `publish` GitHub
Actions workflow. The workflow is intentionally small: it builds the OpenCodez
CLI with `OPENCODEZ_BUILD=1`, packages the `opencodez-*` archives expected by
the installer and updater, verifies those assets, uploads them to GitHub
Releases, and then publishes the release. It does not publish npm packages,
desktop apps, AUR packages, Homebrew formulae, Docker images, or upstream
`opencode-*` release assets. Release versions must include `opencodez`, for
example `1.17.18+opencodez.2`, so plain upstream-looking tags are rejected.

For local dogfooding of unreleased changes, build and install a local OpenCodez
binary, then test the installed `opencodez` command in the live TUI. Checking
only `--help` or `--version` is not enough because those commands do not render
the TUI.

Example release inputs:

```text
release_version: 1.17.18+opencodez.2
binary_version:  1.17.18+opencodez.2
draft:           false
```

For normal OpenCodez operator and user releases, omit `binary_version` or set it
to the same value as `release_version`. Both paths embed the complete OpenCodez
version, including build metadata, so the release tag and installed CLI agree.

## Public Release Cycle

OpenCodez release work is not finished when the code compiles. The public GitHub
repository, release assets, installed binaries, running multihost services, and
operator documentation must all agree before a release is considered done.

Start by fetching upstream tags and releases, identifying the latest upstream
OpenCode release, and inventorying the OpenCodez custom diff against that tag.
Preserve fork-specific behavior unless upstream has clearly replaced it with a
better universal implementation. Protected custom behavior includes the
OpenCodez identity and binary naming, GitHub release/update flow, web server
seeding, prompt controls, and project discovery/indexing safety guards.

After merging upstream, resolve conflicts by reading the local and upstream
intent, not by blindly choosing one side. Run focused package checks first, then
broaden to the affected package typechecks and tests. Build a local release
artifact with `OPENCODEZ_BUILD=1` and an explicit `OPENCODE_VERSION`, and verify
the built binary before publishing.

```bash
OPENCODEZ_BUILD=1 OPENCODE_VERSION=1.17.18+opencodez.2 bun --cwd packages/opencode run build
packages/opencode/dist/opencodez-linux-x64/bin/opencodez --version
packages/opencode/dist/opencodez-linux-x64/bin/opencodez update --check
```

Publish with the `publish` workflow after the local artifact has the expected
name and version. Use matching release and binary versions for normal OpenCodez
releases:

```text
release_version: 1.17.18+opencodez.2
binary_version:  1.17.18+opencodez.2
draft:           false
```

Once the GitHub release exists, verify that it is the latest release, has the
expected assets, has release notes that explain the upstream bump and preserved
custom layer, and has no superseded broken release siblings. Release tags should
point at the commit used to build the published assets; do not move a published
binary tag just to include a docs-only follow-up.

Politia multihost rollout has two distinct steps. First install or update the
`/usr/local/bin/opencodez` binary on each host from the GitHub release. Then use
the harness to restart/configure the services. The harness deploys runtime
configuration and restarts `opencodez-serve.service`; it does not install a new
binary by itself.

After rollout, verify the full public and operator surface:

```bash
/home/bloob/politia/services/harness/opencodez/health.sh
opencodez update --check
```

The final live pass should confirm installed and running versions on `nuc`,
`ser`, `dima`, `toma`, and `rtx`; health for every backend; browser CORS across
the LAN origins; web HTML and asset delivery; `/opencode-web-servers.js` seed
contents; basic session create/get/delete; updater current state; and recent
service logs without startup, plugin, BURO, or opencodebot errors.

Finish by cleaning up GitHub state. Merge or fast-forward the public `main`
branch, make sure the local checkout tracks it, remove merged release branches,
cancel stale queued runs, keep PR title/body/checks readable, and update release
notes if the automatically generated text is too thin. GitHub hygiene is part of
the release cycle, not a separate afterthought.

## Update Download Progress

`opencodez update` emits visible progress while it checks GitHub Releases,
downloads the selected release asset, and begins installation. This avoids the
silent wait that can happen on weak connections when a large asset is read into
memory.

During asset downloads, OpenCodez reads the response body as a stream. If GitHub
provides `Content-Length`, the CLI prints downloaded MB, total MB, and percent.
If the header is absent, the CLI prints downloaded MB only.

Progress is emitted as typed update events from `OpenCodezUpdate.run()` and
rendered by the CLI command. The update helper stays UI-agnostic so future UIs
can reuse the same stages without depending on terminal output.

## Project Discovery and Indexing Safety

OpenCodez keeps global projects scoped to the directory the user selected.
When project resolution starts from a directory outside a git checkout,
OpenCodez returns the global project for that directory instead of widening the
project directory to the filesystem root.

If the selected directory is the filesystem root itself, OpenCodez clamps the
global project directory to the user's home directory. This prevents web and
other project-aware surfaces from treating `/` as the project root and walking
the whole host filesystem.

OpenCodez also disables the native FFF file finder integration by default via
`OPENCODE_DISABLE_FFF`. Users can still opt into upstream-style FFF behavior by
setting `OPENCODE_DISABLE_FFF=false` or `OPENCODE_DISABLE_FFF=0`, but the fork
default favors bounded indexing over root-wide discovery.

## Prompt Library

OpenCodez exposes prompt files as a normal user-facing library.

Prompt files live under the OpenCodez config root:

```text
~/.config/opencodez/prompts/core/<name>.md
~/.config/opencodez/prompts/tone/<name>.md
~/.config/opencodez/prompts/templates/<name>.jsonc
```

The filename becomes the selectable name:

```text
prompts/core/review.md        -> /system review
prompts/tone/brief.md         -> /tone brief
prompts/templates/gpt55.jsonc -> /template gpt55
```

### Core/System Prompts

`/system` shows one shared list of available Core/System prompts.

That list includes:

- `None`, which disables the selectable Core/System prompt for the current
  session;
- upstream OpenCode built-in system prompts;
- bundled OpenCodez Codex presets;
- user-created prompts in `prompts/core/`.

Bundled OpenCodez Core/System prompts:

```text
codex_gpt_5_2
codex_gpt_5_2_codex
codex_gpt_5_3_codex
codex_gpt_5_4
codex_gpt_5_4_mini
codex_gpt_5_5
```

The selector is not model-filtered. A user can pick any available System prompt
for any model.

If a user prompt has the same name as a built-in prompt, the user prompt wins.
This keeps overrides simple and visible.

### Tone Presets

`/tone` shows one shared list of available Tone presets.

That list includes:

- `None`, which disables any separate Tone preset for the current session;
- bundled OpenCodez Tone presets;
- user-created tone files in `prompts/tone/`;
- any future tone/style prompts that are added to the shared library.

Bundled OpenCodez Tone presets:

```text
codex_friendly
codex_pragmatic
```

The selector is not model-filtered. A user can choose `codex_friendly` or
`codex_pragmatic` for DeepSeek, Anthropic, OpenAI, or any other model if that is
what they want.

### Templates

Templates apply a saved `System + Tone` pair.

Template files live in:

```text
~/.config/opencodez/prompts/templates/<name>.jsonc
```

The bundled starter template is:

```text
gpt55 -> system codex_gpt_5_5 + tone codex_pragmatic
```

A template should not silently change unrelated settings. It is a prompt setup
shortcut, not a hidden session profile.

## Commands

OpenCodez adds prompt and pruning commands to the normal OpenCode TUI.

Prompt commands:

```text
/system
/system <name>

/tone
/tone <name>

/template
/template <name>

/prompts
```

New-session flags:

```text
/new --system <name>
/new -s <name>

/new --tone <name>
/new -o <name>

/new --template <name>
/new -t <name>
```

`--system` and `--tone` can be combined.

`--template` cannot be combined with `--system` or `--tone` in the same command.
If the user tries that, OpenCodez should leave the current state unchanged and
show:

```text
--template cannot be combined with --system or --tone.
```

Using `/system` or `/tone` after `/template` is allowed. It simply overrides one
part of the current prompt selection for the same session.

`/prompts` is informational. It should show the prompt library paths and model
defaults location. It should not become a file manager.

## Prompt Defaults

OpenCodez uses a simple priority order:

```text
manual session choice
> user config default for the model or family
> built-in OpenCode/OpenCodez default resolution
```

There is no separate extra "OpenCodez default" priority layer.

Built-in default resolution works like this:

- OpenAI Responses GPT models get bundled Codex-style defaults.
- Other models keep the normal upstream OpenCode defaults unless the user
  config says otherwise.

For OpenAI Responses GPT models, OpenCodez chooses model-specific System
presets:

```text
gpt-5.2 -> codex_gpt_5_2
gpt-5.2-codex -> codex_gpt_5_2_codex
gpt-5.3-codex -> codex_gpt_5_3_codex
gpt-5.3-codex-spark -> codex_gpt_5_3_codex
gpt-5.4 -> codex_gpt_5_4
gpt-5.4-mini -> codex_gpt_5_4_mini
gpt-5.5 -> codex_gpt_5_5
gpt-5.6-luna -> codex_gpt_5_5
gpt-5.6-terra -> codex_gpt_5_5
gpt-5.6-sol -> codex_gpt_5_5
```

`gpt-5.3-codex-spark` intentionally reuses `codex_gpt_5_3_codex` unless a
separate spark prompt is added later.

The GPT 5.6 Luna, Terra, and Sol ChatGPT variants intentionally reuse the GPT
5.5 system prompt and the same Tone/personality behavior.

The built-in default Tone for those GPT models is:

```text
codex_pragmatic
```

For Anthropic, DeepSeek, Gemini, Kimi, and other non-Responses models, OpenCodez
must not force Codex prompts by default.

### User Config Defaults

Users can set default System and Tone values in:

```text
~/.config/opencodez/opencode.jsonc
```

Example:

```jsonc
{
  "opencodez": {
    "responses": {
      "system": {
        "default": "codex_gpt_5_5",
        "gpt-5.2-codex": "codex_gpt_5_2_codex",
        "gpt-5.3-codex-spark": "codex_gpt_5_3_codex",
        "gpt-5.4": "codex_gpt_5_4",
        "gpt-5.4-mini": "codex_gpt_5_4_mini",
        "deepseek": "default",
      },
      "tone": {
        "default": "codex_pragmatic",
        "anthropic": "codex_friendly",
      },
    },
  },
}
```

The config section is named `opencodez.responses` because the feature started
as OpenAI Responses GPT defaults. The mapping can still point to any available
model id, family, provider/model key, or `default`.

Config defaults can reference any prompt in the shared prompt library:

- upstream built-in prompts;
- bundled OpenCodez Codex presets;
- user-created custom prompt files.

If a user adds a custom prompt and assigns it as the default for a model or
family, that prompt becomes the normal default for that case.

## Session Behavior

Manual prompt choices belong to the session.

When a user applies `/system`, `/tone`, `/template`, or starts a session with
`/new --system`, `/new --tone`, or `/new --template`, OpenCodez stores the
selection in session metadata.

That means:

- switching models with `/model` does not reset manual System/Tone choices;
- closing and reopening the TUI should preserve the choice when the same session
  is resumed;
- new sessions without manual prompt flags start from config defaults or built-in
  defaults;
- already existing messages are not rewritten when the prompt selection changes.

If no manual prompt command was used yet in the session, changing the model can
change the effective defaults because the session is still following default
resolution.

Choosing `None` in the System or Tone selector is a manual session choice. It
does not clear the manual override back to defaults; it explicitly disables that
selectable prompt for the current session and is stored in metadata.

## Web Composer Controls

The web composer shows OpenCodez prompt controls in the same bottom control row
as the normal agent/model controls.

- `S: <id>` shows the concrete effective System prompt id, or `none` when the
  session explicitly disables the selectable System prompt.
- `T: <id>` shows the selected Tone prompt id, or `none` when no separate
  Tone preset is active.
- `Template` opens the template picker. Choosing a template applies that
  template's `System + Tone` pair; the concrete result is then visible in the
  `S:` and `T:` controls. The web UI does not keep or display a separate
  current template state.

The normal session/model controls stay to the left of OpenCodez prompt controls:

```text
Build · Model · Reasoning · S: ... · T: ... · Template
```

The System and Tone pickers include `None`. The Template picker does not include
`None`, because a template is an action rather than an active state.

Prompt lists are loaded through the OpenCodez server API when a picker opens.
The browser does not read prompt files directly.

For existing sessions, web prompt choices are written to session metadata. For a
new session before the first message, the choice stays in composer draft
metadata and is sent when the session is created.

## Web Default Servers

OpenCodez Web can seed its Settings -> Servers list from environment config.
This is a generic OpenCodez feature for multiserver setups; it is not tied to
Politia, BURO, or any private host names.

The server process accepts either plain JSON or base64-encoded JSON:

```text
OPENCODE_WEB_SERVERS_JSON
OPENCODE_WEB_SERVERS_JSON_B64
```

The JSON value is an array of entries. Two shapes are accepted:

```json
[{ "name": "ser", "url": "http://192.168.1.215:4096" }]
```

or the internal OpenCode Web connection shape:

```json
[
  {
    "type": "http",
    "displayName": "ser",
    "http": { "url": "http://192.168.1.215:4096" }
  }
]
```

On page load, OpenCodez merges these entries into the browser's normal server
storage by URL. Existing user entries are preserved unless a configured entry
uses the same URL, in which case the configured display name wins. The UI still
uses its normal health checks and project selection behavior after seeding.

When multiple web origins are used, the remote `opencodez serve` processes also
need matching `--cors` origins so browser health checks and API calls can reach
the selected server.

## Web Asset Delivery

OpenCodez serves the embedded web UI with caching and compression enabled by
default for hashed static assets. This keeps remote private links and mobile VPN
loads from downloading the same JavaScript and CSS repeatedly.

The runtime files stay uncached: `index.html`, `opencode-web-servers.js`, API
responses, and event streams are not treated as immutable assets.

Operators can turn the behavior off without changing code:

```text
OPENCODE_UI_ASSET_CACHE=0
OPENCODE_UI_ASSET_COMPRESSION=0
OPENCODE_UI_ASSET_CACHE_MAX_AGE=31536000
```

## Compact Indicator

The TUI shows the active System and Tone while the user works.

The indicator should be compact and permanent, for example:

```text
S: codex_gpt_5_5 · T: codex_pragmatic
```

`S:` always shows the concrete active System prompt id. If the current model is
using an upstream OpenCode built-in prompt without an explicit OpenCodez System
selection, the indicator still shows that prompt id:

```text
S: default · T: none
```

OpenAI Responses GPT defaults show the selected Codex prompt id, such as
`codex_gpt_5_5`. Manual `/system` choices update `S:` immediately.

`T: none` is normal when no separate Tone preset is active. Manual `/tone`
choices update `T:` immediately.

Explicit `System -> None` shows `S: none` and suppresses the selectable System
prompt fallback for the session. Explicit `Tone -> None` shows `T: none` and
suppresses any default Tone prompt for the session.

The indicator should stay simple. It should not invent a separate `/status`
command, and it should not use complicated truncation logic. `/system` and
`/tone` already provide the detailed selector view.

## Context Pruning

OpenCodez pruning changes what is sent back to the model as context. It does
not physically delete saved history.

Config lives in `~/.config/opencodez/opencode.jsonc` under:

```jsonc
{
  "opencodez": {
    "pruning": {
      "enabled": true,
      "pruning_size": 20000,
      "prune": {
        "reasoning": true,
        "tool": true,
      },
      "preserve_tools": [],
    },
  },
}
```

Runtime commands:

```text
/pruning
/pruning on
/pruning off
/pruning size 20000
```

Default behavior:

- pruning is enabled;
- `pruning_size` is `20000`;
- reasoning pruning is enabled;
- tool result pruning is enabled;
- `preserve_tools` is empty.

Rules:

- reasoning is counted inside the same `pruning_size` budget;
- `pruning_size = 0` removes the selected payload completely;
- if a payload does not fit the budget, OpenCodez replaces the whole payload
  with a deterministic placeholder instead of sending a partial slice;
- tool calls are not pruned;
- tool name, call id, status, and existing metadata stay readable;
- tool result/output/error payload can be replaced with a placeholder such as
  `[Tool output pruned: 58213 chars]`;
- tools matched by `preserve_tools` are not pruned and do not count against the
  pruning budget.

Pruning is separate from upstream `tool_output` behavior. If `tool_output` has
already stored only a preview or artifact path, pruning works with that current
content and does not restore the original raw output.

Runtime pruning changes are stored in session metadata for the current session.
They do not rewrite `opencode.jsonc`.

## Implementation Map

These paths are useful when maintaining the feature. They are waypoints, not a
reason to broadly rewrite upstream code.

OpenCodez currently follows the upstream package split introduced after the
older `packages/opencode`-only TUI layout. Fork-specific shared state that must
be used by both the server and TUI lives in core. File-backed prompt loading
stays in the opencode server package, and the web/TUI surfaces select prompts
through the OpenCodez HTTP API instead of reading prompt files directly.

Bundled prompt assets:

```text
packages/opencode/src/opencodez/default-prompts/
```

OpenCodez prompt library and request-time prompt loading:

```text
packages/opencode/src/opencodez/prompt-library.ts
```

OpenCodez shared identity, config defaults, session state, and slash parsing:

```text
packages/core/src/opencodez/
packages/core/src/v1/config/opencodez.ts
```

Project discovery and bounded indexing defaults live in upstream-shaped core
paths, not in an isolated OpenCodez adapter:

```text
packages/core/src/project.ts
packages/core/src/flag/flag.ts
packages/core/test/project.test.ts
```

Upstream System prompt integration still belongs to the opencode server package:

```text
packages/opencode/src/session/system.ts
```

Model request preparation:

```text
packages/opencode/src/session/llm/request.ts
packages/opencode/src/session/llm/context-prune.ts
```

TUI command and selector surface:

```text
packages/tui/src/component/prompt/index.tsx
packages/tui/src/component/opencodez-dialogs.tsx
packages/tui/src/app.tsx
```

Web composer and prompt API surface:

```text
packages/app/src/components/prompt-input.tsx
packages/opencode/src/server/routes/instance/httpapi/groups/opencodez.ts
packages/opencode/src/server/routes/instance/httpapi/handlers/opencodez.ts
packages/sdk/js/src/v2/gen/
```

Release update progress:

```text
packages/opencode/src/opencodez/update.ts
packages/opencode/src/cli/cmd/opencodez-update.ts
packages/core/src/opencodez/version.ts
packages/core/test/opencodez-version.test.ts
```

Focused tests:

```text
packages/opencode/test/opencodez/
packages/core/test/opencodez-version.test.ts
```

## Verification Expectations

For docs-only changes, check links and search for stale prompt names.

For implementation changes, prefer a narrow test first and then broaden:

```bash
bun test packages/opencode/test/opencodez/*.test.ts
bun test packages/core/test/opencodez-version.test.ts
bun run --cwd packages/core typecheck
bun run --cwd packages/opencode typecheck
bun run --cwd packages/tui typecheck
bun run --cwd packages/app typecheck
```

Before telling a user the product is ready to dogfood, install a fresh local
OpenCodez build and open the live installed TUI:

```bash
opencodez
```

The live TUI check should confirm that:

- the prompt opens without a fatal screen;
- `/system` shows upstream built-ins, Codex presets, and custom prompts;
- `/tone` shows bundled and custom tones;
- `/prompts` opens;
- `/pruning` opens;
- the compact System/Tone indicator reflects the current session state.

For web prompt-control changes, also open the web composer and confirm that:

- normal controls stay on the left: Build, Model, then Reasoning;
- `S:`, `T:`, and `Template` appear after the normal controls;
- System and Tone selectors include `None`;
- the Template selector does not include `None`;
- selecting System or Tone `None` updates the visible state to `S: none` or
  `T: none`.
