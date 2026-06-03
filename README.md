<h1 align="center">OpenCodez</h1>

<p align="center">
  A small, local-first OpenCode fork with explicit prompt control, bundled Codex-style prompts, and cleaner context handling.
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

OpenCodez is for people who want OpenCode to stay OpenCode, but with predictable prompt setup and less noisy model context.

| Area | What OpenCodez adds |
| --- | --- |
| Prompt control | `/system`, `/tone`, `/template`, and `/new` flags for explicit session setup. |
| Prompt library | Upstream built-ins, bundled Codex presets, and user prompt files in one shared selector. |
| Model defaults | Configurable System/Tone defaults, with Codex-style defaults only for OpenAI Responses GPT models out of the box. |
| Session state | Manual System/Tone/Template choices stay with the session and do not reset on `/model`. |
| Pruning | Reasoning and tool result payloads can be replaced with clear placeholders before context is sent to the model. |
| Updates | `opencodez update` uses GitHub Releases when public releases are enabled. |

Read the full public feature reference in [docs/opencodez.md](docs/opencodez.md).

## What OpenCodez Adds

OpenCodez keeps the normal OpenCode shape, but adds a few practical controls:

- `/system` selects the active Core/System prompt.
- `/tone` selects the active Tone preset.
- `/template` applies a saved System + Tone pair.
- `/new --system`, `/new --tone`, and `/new --template` start a new session with explicit prompt settings.
- Model-aware defaults can choose System/Tone presets automatically for OpenAI Responses GPT models, and users can configure defaults for other models too.
- Manual `/system`, `/tone`, and `/template` choices stay active when you switch models.
- The TUI shows a compact System + Tone indicator while you work.
- `/pruning` lets you view and change session-local pruning settings.
- Tool calls stay readable while tool result and reasoning payloads can be replaced with deterministic placeholders.

OpenCodez is meant to be a small fork, not a full rebrand. Upstream internals, docs, workflows, integrations, and package surfaces should stay as close to OpenCode as practical unless a fork-specific change is genuinely needed.

For detailed behavior, defaults, command semantics, pruning rules, and maintenance notes, use [OpenCodez Docs](docs/opencodez.md).

## Install & Update

OpenCodez is designed to install from GitHub Releases once public releases are enabled. It does not publish to npm and does not install over upstream `opencode`.

Install:

```bash
curl -fsSL https://raw.githubusercontent.com/Krablante/opencodez/main/install.sh | sh
```

Update:

```bash
opencodez update
```

Check for updates without installing:

```bash
opencodez update --check
```

The update path is intentionally simple: GitHub Releases are the source of truth, the installer downloads the right release artifact, and `opencodez update` uses the same release channel from inside the app.

## Run From Source

For local development before a public release exists, run the source-checkout launcher directly:

```bash
./packages/opencode/bin/opencodez --help
./packages/opencode/bin/opencodez
```

Future release builds should set `OPENCODEZ_BUILD=1` so the build script emits `opencodez-*` artifacts with an `opencodez` binary inside.

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

It covers prompt defaults, selectors, templates, pruning, config roots, session behavior, and maintenance expectations for this fork. Upstream OpenCode documentation remains the source for normal OpenCode behavior.

Prompt library paths:

```text
~/.config/opencodez/prompts/core/<name>.md
~/.config/opencodez/prompts/tone/<name>.md
~/.config/opencodez/prompts/templates/<name>.jsonc
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
```

Bundled Tone presets:

```text
codex_friendly
codex_pragmatic
```

Model defaults live in `~/.config/opencodez/opencode.jsonc`. Values can be one prompt name for all models, or a mapping keyed by model id, family, `provider/model`, or `default`:

```jsonc
{
  "opencodez": {
    "responses": {
      "system": {
        "default": "codex_gpt_5_5",
        "gpt-5.4": "codex_gpt_5_4",
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

## Commands

```text
/system
/system codex_gpt_5_5

/tone
/tone codex_pragmatic
/tone codex_friendly

/template
/template gpt55

/new --system codex_gpt_5_5 --tone codex_pragmatic
/new -s codex_gpt_5_5 -o codex_pragmatic
/new --template gpt55
/new -t gpt55

/prompts

/pruning
/pruning on
/pruning off
/pruning size 20000
```

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
