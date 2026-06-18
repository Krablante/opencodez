# OpenCodez Docs

This page is the public source of truth for OpenCodez-specific behavior.

OpenCodez is a small, maintainable fork of upstream OpenCode. It keeps the
normal OpenCode product shape, but adds explicit prompt control, bundled
Codex-style prompt presets, session-local prompt selection, and safer context
pruning.

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
They use the public release channel, not the local dogfooding path.

For local dogfooding of unreleased changes, build and install a local OpenCodez
binary, then test the installed `opencodez` command in the live TUI. Checking
only `--help` or `--version` is not enough because those commands do not render
the TUI.

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
```

`gpt-5.3-codex-spark` intentionally reuses `codex_gpt_5_3_codex` unless a
separate spark prompt is added later.

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
        "deepseek": "default"
      },
      "tone": {
        "default": "codex_pragmatic",
        "anthropic": "codex_friendly"
      }
    }
  }
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
        "tool": true
      },
      "preserve_tools": []
    }
  }
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

Focused tests:

```text
packages/opencode/test/opencodez/
```

## Verification Expectations

For docs-only changes, check links and search for stale prompt names.

For implementation changes, prefer a narrow test first and then broaden:

```bash
bun test packages/opencode/test/opencodez/*.test.ts
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
