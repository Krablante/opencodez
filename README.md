<h1 align="center">OpenCodez</h1>

<p align="center">
  A local-first OpenCode fork for flexible System prompt control, token-saving pruning, and bundled Codex prompts for a Codex-like experience.
</p>

<p align="center">
  <strong>OpenCodez is not an official OpenCode project.</strong><br>
  It keeps upstream OpenCode recognizable while adding a few practical controls for prompt-heavy work.
</p>

<p align="center">
  <a href="docs/opencodez.md"><strong>OpenCodez Docs</strong></a>
  ·
  <a href="#install--update">Install & Update</a>
  ·
  <a href="#commands">Commands</a>
  ·
  <a href="#upstream-opencode-readme">Upstream README</a>
</p>

---

## At a Glance

OpenCodez is for people who want OpenCode to stay OpenCode, but with flexible prompt control, a ready-to-use Codex-style prompt set, and less noisy model context.

| Area           | What OpenCodez adds                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| Prompt control | TUI command and web composer control for the active System prompt.                                                |
| Prompt library | Upstream built-ins, bundled Codex presets, and user prompt files in one shared selector.                          |
| Model defaults | Configurable System defaults, with Codex-style defaults for OpenAI Responses GPT models out of the box.           |
| Session state  | A manual System choice stays with the session and does not reset on `/model`.                                    |
| Pruning        | Reasoning and tool result payloads can be replaced with clear placeholders before context is sent to the model.   |
| Updates        | `opencodez update` uses GitHub Releases.                                                                          |

Read the full public feature reference in [docs/opencodez.md](docs/opencodez.md).

## What OpenCodez Adds

OpenCodez keeps the normal OpenCode shape, but adds a few practical controls:

- `/system` selects the active Core/System prompt.
- The web composer has the same session-level System selector.
- `None` explicitly disables the selectable System prompt for the current session.
- Model-aware defaults choose System prompts automatically for OpenAI Responses GPT models, and users can configure defaults for other models too.
- A manual `/system` choice stays active when you switch models.
- The TUI shows the concrete active System prompt id while you work.
- `/pruning` lets you view and change session-local pruning settings.
- Tool calls stay readable while tool result and reasoning payloads can be replaced with deterministic placeholders.
- Non-git projects stay scoped to the selected directory, explicit filesystem
  roots clamp to `$HOME`, and FFF indexing is disabled by default.
- `opencodez update` prints GitHub release, download progress, and install
  stages instead of staying silent during large asset downloads.

OpenCodez is meant to be a small fork, not a full rebrand. Upstream internals, docs, workflows, integrations, and package surfaces should stay as close to OpenCode as practical unless a fork-specific change is genuinely needed.

For detailed behavior, defaults, command semantics, pruning rules, and maintenance notes, use [OpenCodez Docs](docs/opencodez.md).

## Install & Update

OpenCodez installs from GitHub Releases. It does not publish to npm and does not install over upstream `opencode`.

Linux and macOS install:

```bash
curl -fsSL https://raw.githubusercontent.com/Krablante/opencodez/main/install.sh | sh
```

Windows PowerShell install:

```powershell
irm https://raw.githubusercontent.com/Krablante/opencodez/main/install.ps1 | iex
```

Public release update:

```bash
opencodez update
```

Check for updates without installing:

```bash
opencodez update --check
```

The update path is intentionally simple: GitHub Releases are the source of truth, the installer downloads the right release artifact for the current OS and architecture, and `opencodez update` uses the same release channel from inside the app.
During the download, `opencodez update` prints progress to stderr. When GitHub
provides `Content-Length`, progress includes total MB and percent; otherwise it
prints downloaded MB only.
On Unix, OpenCodez asks for `sudo` only when the installed binary is in a
protected system path such as `/usr/local/bin`. Installations older than
`1.17.20+opencodez.2` need one bootstrap update with `sudo opencodez update`;
later releases handle the protected target automatically.
Managed deployments may install the narrow `/usr/local/sbin/opencodez-install`
helper. When present, `opencodez update` uses it non-interactively to replace
only `/usr/local/bin/opencodez`; ordinary public installs keep the interactive
sudo fallback.
If the installed binary is newer than the latest published release, `opencodez update` treats it as current instead of downgrading it.

## Run From Source

For local development, run the source-checkout launcher directly:

```bash
./packages/opencode/bin/opencodez --help
./packages/opencode/bin/opencodez
```

Release builds should set `OPENCODEZ_BUILD=1` so the build script emits `opencodez-*` artifacts with an `opencodez` binary inside.
Normal public releases should use the `publish` GitHub Actions workflow. Give it an OpenCodez release version such as `1.18.4+opencodez.3`; the release version must include `opencodez` so accidental upstream-looking tags are rejected. The workflow embeds that complete version by default, builds the `opencodez-*` assets, verifies their names and archive contents, uploads them to GitHub Releases, and publishes the release unless `draft` is enabled.

## Side-by-Side With OpenCode

OpenCodez is expected to live next to upstream OpenCode:

```text
opencode   # upstream OpenCode
opencodez  # this fork
```

It uses its own config, data, and cache roots:

```text
~/.config/opencodez/
~/.local/share/opencodez/
~/.cache/opencodez/
```

OpenCodez does not automatically read from or write to `~/.config/opencode/`. If you want to reuse upstream OpenCode settings or prompt files, copy only the pieces you want into the OpenCodez config root manually.

## OpenCodez Docs

The maintained public reference for OpenCodez-specific behavior is:

```text
docs/opencodez.md
```

It covers System prompt defaults, pruning, config roots, session behavior, and maintenance expectations for this fork. Upstream OpenCode documentation remains the source for normal OpenCode behavior.

Prompt library paths:

```text
~/.config/opencodez/prompts/core/<name>.md
```

Bundled Codex-derived prompt files use the `codex_` prefix. User-created prompt files do not need that prefix.

Bundled Core/System prompts:

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

Out-of-the-box OpenAI Responses GPT System defaults:

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

Model defaults live in `~/.config/opencodez/opencode.jsonc`. Values can be one prompt name for all models, or a mapping keyed by model id, family, `provider/model`, or `default`:

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
    },
  },
}
```

## Pruning Config

Pruning defaults also live in `~/.config/opencodez/opencode.jsonc`:

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

`enabled` turns pruning on or off. `pruning_size` is the payload budget, currently counted in characters. `prune.reasoning` and `prune.tool` decide which payload types can be replaced with placeholders. `preserve_tools` is a list of tool names or glob patterns that should never be pruned.

The `/pruning` TUI command changes only the current session's `enabled` state and `pruning_size`. It does not rewrite `opencode.jsonc`.

## Commands

| Command                 | What it does                                                              |
| ----------------------- | ------------------------------------------------------------------------- |
| `/system`               | Opens the Core/System prompt selector.                                    |
| `/system codex_gpt_5_5` | Sets the current session System prompt directly.                          |
| `/system none`          | Explicitly disables the selectable System prompt for the current session. |
| `/pruning`              | Opens the pruning settings view.                                          |
| `/pruning on`           | Enables pruning for the current session.                                  |
| `/pruning off`          | Disables pruning for the current session.                                 |
| `/pruning size 20000`   | Sets the current session pruning payload budget.                          |

## Upstream OpenCode README

The original OpenCode README is kept below for general upstream context. OpenCodez-specific behavior is described in the sections above.

---

<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download directly from the [releases page](https://github.com/anomalyco/opencode/releases) or [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.opencode/bin` - Default fallback

```bash
# Examples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
