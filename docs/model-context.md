# Model context

Open **Settings → Model context** to set a model's working window and the token
count that starts automatic compaction. On phones, tap the chat's context
indicator to open this menu directly. On larger screens, **Adjust limits** in the
chat's context view opens it. Changes belong to the selected server and configuration
profile; the header identifies that server.

## Set the window and compaction threshold

Choose **Models** or **Families**, then find the target by name, ID, or provider.
Enter the **Context window** and **Auto-compact after** values in tokens and save.
For example, a model supporting a million-token window can use `1000000` with
automatic compaction after `500000`. Numbers can be pasted with ordinary
thousands separators. Decimal, negative, and unsafe integer values are rejected.

The window and threshold are independent. Lowering the threshold starts
compaction earlier without shrinking the request budget available to compact the
existing history. The automatic-compaction switch can disable the trigger for a
target while retaining its saved numbers. Manual compaction remains available.

Blank fields inherit the existing defaults. **Reset to defaults** clears the
target's personal rule when saved. A family rule overrides configuration defaults;
a base-model rule overrides its family, and an exact alias rule overrides its
base. Fields inherit independently. A family change preserves exact personal
exceptions and shows the effective range plus the individual models beneath it.
Identical family names at different providers remain separate.

**Effective limits** shows the window and threshold that can actually apply. A
requested value cannot bypass the provider input limit, ChatGPT catalog ceiling,
or the space needed for an answer. For an account advertising an `872000` ChatGPT
working maximum, requesting `1000000` still applies `872000`; an independent
`520000` compaction threshold can fit that window. A window with no room for a
response is rejected. Models without a known context limit keep their ordinary
behavior unless a personal window is supplied.

On phones, the model list and editor use separate views. The two numeric fields,
effective limits, and Save action have priority. Save occupies its own row, and
the editor scrolls inside the visible viewport when the keyboard reduces it.
Labels use compact 13 px text on phones and 14 px on larger screens. Numeric
inputs retain 16 px text and touch controls retain their tap areas. Wide screens
show the target list and editor together.
Unsaved edits are protected when navigating or closing the menu.

## When changes apply

A save does not restart the server, dispose projects, reconnect providers, or
stop tools. The active logical turn keeps its captured settings through tool
calls, retries, compaction, and persisted continuation. The next turn receives
the saved values. Clients refresh through their existing event stream and when
the menu reconnects or becomes visible.

The chat's context indicator uses the window from its most recent model request.
Saving a new window while the chat is idle therefore changes that indicator on
the next request. A smaller ChatGPT window can trigger a transition that first
compacts history with the previous working window, including when the model ID
stays the same.

Compaction is checked between model requests. Its count includes the active
history, instructions, cached input, and the normal provider-specific accounting
for tool results and reasoning. It is not a stop at an exact individual token.
ChatGPT retains its server-side compaction; other providers retain OpenCode's
text-summary mechanism. The menu changes their limits, not their summary format.

Existing configuration remains a fallback. Personal UI rules take precedence
without rewriting `opencode.jsonc`. Requests from Web, TUI, and API clients using
that server/profile receive the same settings.

## Import and export

**Export settings** opens a selection of saved personal model and family rules.
Download the selected rules as JSON. The bundle contains requested values,
automatic-compaction choices, and portable target identifiers. It contains no
credentials, server addresses, filesystem paths, or conversation data. Effective
limits are resolved again at the destination.

**Import settings** accepts an `opencodez-context` JSON bundle, version `1`.
Review the preview before applying it. New targets are selected by default;
unchanged targets are already present, and differing local rules are kept until
you explicitly choose their replacement. Re-importing an exported bundle creates
no duplicates. Unknown models and families can be retained as inactive rules.
They become applicable when the target is available in the profile.

Imports allow at most 1,000 rules and 1 MiB. Duplicate targets, invalid values,
unsupported formats, and unusable known windows leave stored settings intact.
Saving checks the document revision. A conflicting editor keeps its draft and
offers refresh; refreshing an import reevaluates its replacements.

## Storage and maintenance

Personal rules live in `models/context.json` beneath the active OpenCodez config
root. The file is user data: include it in profile backups and preserve it during
application updates and configuration reconciliation. Writes replace the file
atomically. No service, database dependency, recursive watcher, or polling loop
is added. Editing a value previews only the affected models, using the existing
catalog cache rather than rescanning conversation history.

The browser-safe contract is in `schema/src/opencodez-context.ts`. Rule resolution
and captured values belong to `core/src/opencodez/context-policy.ts`; storage,
portable bundles, and effective limits belong to
`opencode/src/opencodez/context-settings.ts`. The existing OpenCodez HTTP group
owns the endpoints, and both Settings layouts mount the same
`app/src/opencodez/context-settings.tsx` screen only while its tab is active.
Sampling and compaction reuse the captured model limits. Keep public API changes
and their generated SDK/client output together.
