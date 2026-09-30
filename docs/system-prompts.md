# System prompts

OpenCodez includes a prompt library for the agent's core instructions. Open
**Settings → System prompts**, or choose **Manage prompts…** in the chat's System
selector. Both open the same library. Text, model assignments, reasoning defaults,
and portable bundles are managed there without editing configuration files.

The library belongs to the selected server and configuration profile. Its header
shows the server being edited. An open editor stays attached to that server, so
changing the application's connection cannot send an old draft to a different
machine. Use export and import to move a set to another server.

## Read, create, and use

Built-in prompts are read-only resources supplied by OpenCodez. Their text,
identity, and name cannot be changed or deleted through the library API. Choose
**Create from this** to open an independent editable copy. Copying a prompt does
not copy its model assignments or switch the current chat.

For your own prompt, enter a name, an optional description under **Prompt details**, and the instructions,
then choose **Save**. The normal save keyboard shortcut also works. Renaming does
not change its identity, so existing chats and assignments remain connected.
Unsaved edits are protected when leaving the editor or closing its dialog.
Conflicting saves preserve the draft and offer refresh or a separate copy.
When opened from a chat, **Save and use in this chat** explicitly saves a draft
before selecting it for that session.

Opening an item in the library only opens its editor. When the library was opened
from a chat, **Use in this chat** makes an explicit session selection. In the
chat's quick selector, **Automatic** follows model defaults and **No core prompt**
disables the selectable instructions. Environment, project, agent, skill, and
tool instructions continue to use OpenCode's normal preparation mechanisms.

On a phone, both entry points fill the visible screen. The text gets the main
area; Save and Use share a single action row below it. The header's back arrow
returns to the list or the preceding editor. Description and context information
are under **Prompt details**. Copy, export, deletion, and reasoning defaults are
available from the action menu. On a wide screen, the list and editor are shown
together.

When the keyboard reduces or pans the visible area, the window follows that
area. A short editing viewport folds the metadata and assignment row while
retaining the prompt name, server, text, and actions. The editor scrolls
independently; actions occupy their own space and never float over the text.
Closing the keyboard restores the normal layout without leaving the editor.

## Model and family defaults

Open **Default for** in a prompt's card. Switch between **Models** and **Families**,
then search by name, ID, or provider. Each provider has one group heading.
**This prompt** assigns the open prompt to the selected target; **Inherit** removes
its personal rule, and **Built-in** explicitly returns that target to its bundled
choice. A family can be expanded to inspect its models and exact personal
exceptions, including staged exceptions before applying changes. Families use the
provider catalog; equally named families from different providers remain separate.

Choose the current prompt for one model or a whole family, then **Apply
assignments**. A personal family rule overrides bundled assignments for its
models. An exact personal model rule overrides that family rule. Standard/Fast
aliases can have their own exact rule; otherwise they inherit their base API
model's rule before family defaults.

**Remove rule** resumes inheritance. **Use built-in default** is an explicit
exception that bypasses personal inheritance for that target. This also prevents
a retired configuration rule from silently becoming active again.

The less common **All models** and **Models without an assignment** options are
under **Other defaults**. An all-model choice takes precedence over automatic
model and family rules. Changing specific assignments while that mode is active
shows that applying them will disable the all-model rule. A fallback only applies
when no more specific assignment exists.

A manually selected session prompt always wins over automatic defaults. Changing
model assignments does not replace it. Selecting **Automatic** returns that
session to the current rules.

Old `opencodez.responses.system` settings remain readable. Explicit model and
family entries keep their meaning. The old string form remains an all-model
choice. A mapping's `default` is a fallback: it no longer blocks new explicit
bundled model assignments. New changes made through the library are stored
separately, without rewriting the rest of `opencode.jsonc`.

## Reasoning defaults

Open **Default reasoning** from the library header. Each model offers only the
variants it actually supports, such as `medium`, `high`, or `max`. Save the
defaults once; they are used for automatic model choices and API requests that
omit an explicit variant. Unsupported values are rejected by the server.

A manual chat choice takes precedence. Existing saved session choices are
preserved. Selecting the ordinary model default in a chat is also explicit; it
does not accidentally reapply the library's override. Removing a library default
restores ordinary OpenCodez selection behavior. Reasoning defaults are independent
of prompt text and are not silently carried in a prompt bundle.

## Changes during work

Library operations do not restart the server, dispose projects, reconnect model
providers, or stop tools. Connected clients receive a small change event through
their existing stream. Opening a selector, reconnecting, or returning to the page
refreshes the catalog; no page reload is needed.

A logical user turn captures its selected core prompt before sampling. Its tool
loop, retries, and compaction continue with that snapshot even if the library is
edited. The next turn uses the saved new version. The active snapshot is persisted
with the session for reconstruction, then released when the drain finishes.

Changing instructions can require a fresh full Responses request. The existing
continuation check performs that reset without discarding conversation history
or opaque remote compaction state. Updating the application binary still follows
the normal install and service-restart procedure; this hot-update contract covers
prompt and default operations after the feature is installed.

## Import, export, and updates

Export one text as Markdown, or select prompts for an **OpenCodez bundle**. A
bundle is a versioned JSON file with texts, names, descriptions, stable IDs, and
optional model assignments. The export view shows the selection and lets you
explicitly include assignments. It does not include authentication, server
addresses, absolute filesystem paths, sessions, tools, or general configuration.

Import a Markdown file or a bundle. Review the items before applying them:

- An unchanged existing item is kept without creating a duplicate.
- An unedited imported item can receive the incoming update.
- A locally edited item is kept by default; replace it explicitly or import a copy.
- Built-ins and existing Markdown sources can be reused or copied. Import never
  writes over a built-in or an external Markdown file.

Assignments are off by default during import. If you enable them, the preview
lists the affected targets and replacements. Unknown models can retain inactive
rules after this explicit choice; their text does not require that model to be
installed. Import commits the selected managed items and assignments together.
Invalid data leaves the previous library intact.

The current format is `opencodez-prompts`, version `1`. A bundle can contain at
most 1,000 items. Library writes allow at most 1 MiB per prompt, 200 characters
per name, and 2,000 per description; the managed document is limited to 32 MiB.
Text, including Unicode and line breaks, is preserved exactly within those limits.

Built-ins update with the OpenCodez release. Personal copies do not follow their
source automatically. If a bundled source changes, its copy can show a source
update notice and let you inspect it or create another copy. No mandatory manual
merge is introduced. Personal assignments survive product updates; new bundled
defaults fill targets without personal rules.

Deleting a personal prompt moves it to **Deleted**, removes its personal
assignments, and keeps its text accessible to chats that already selected it.
Restore returns the same identity. Old assignments are not automatically revived.
Permanent destruction of retained items is not part of this interface.

## Storage and file compatibility

Managed prompts, their origin information, deletion state, assignments, and
reasoning defaults live in `prompts/library.json` under the active OpenCodez
configuration root. Writes replace that document atomically and check its revision.
It is user data and belongs in profile backups alongside the existing config and
prompt files. Application upgrades never treat it as generated disposable state.

Existing `prompts/core/*.md` remain live Markdown sources, identified as such in
the library. Editing one saves that file; renaming its display name does not move
it or break old references. These files can also be owned by an external editor
or deployment process. Such a process can replace their contents independently of
OpenCodez. Use **Create from this** for a managed personal copy with an independent
life cycle.

New operations use stable `user-…`, `builtin:…`, and `file:…` identities.
Previously saved names still resolve with the legacy file-over-bundle precedence.
An explicit `builtin:…` identity always addresses the embedded resource. A
user file with a matching old name is a separate editable object; it cannot
modify the embedded resource.

## Maintenance boundary

The implementation reuses the existing app, HTTP API, event streams, session
metadata, provider catalogs, and production build. It introduces no service,
database dependency, recursive filesystem watcher, or per-project polling loop.
Catalog responses contain metadata rather than all prompt bodies.

| Responsibility                                 | Owner                                                     |
| ---------------------------------------------- | --------------------------------------------------------- |
| Browser-safe contracts and change event        | `schema/src/opencodez-prompts.ts`                         |
| Rule and variant resolution                    | `core/src/opencodez/prompt-policy.ts` and `settings.ts`   |
| Atomic managed storage                         | `opencode/src/opencodez/prompt-store.ts`                  |
| Catalog, legacy sources, bundles, turn capture | `opencode/src/opencodez/prompt-library.ts`                |
| HTTP boundary and catalog validation           | Existing `opencodez` HttpApi group and handlers           |
| Shared responsive screen and client refresh    | `app/src/opencodez/`                                      |
| Active-turn lifetime                           | Narrow hooks in session preparation and remote compaction |

Viewport sizing is scoped to the library's dialog and is released when its screen
closes. Resize, viewport pan, and focus notifications are coalesced per animation
frame; the feature adds no keyboard service or polling loop. Preserve one native
textarea scroll area and a separate action row when changing the mobile layout.

The fork seams are the Settings entry, composer entry, variant selection,
unsaved-dialog navigation guard, and active-turn capture. Keep the implementation
behind those seams rather than duplicating behavior in each composer or provider.
The prompt-selection endpoint remains compatible with old names used by TUI and
OpenCodeBot. Public schema changes require the normal SDK/client generators.

The [Russian implementation specification](system-prompt-library-spec.ru.md)
records the product requirements and acceptance scenarios. The
[OpenCodez reference](opencodez.md) owns the rest of the fork's runtime contracts.
