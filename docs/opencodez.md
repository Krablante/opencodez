# OpenCodez

OpenCodez is a small public fork of OpenCode. It preserves upstream behavior and
adds isolated runtime roots, managed System prompts, a default Codex-compatible
Responses wire mode for ChatGPT OAuth, fork-specific updates, safe project
discovery, and multiserver web operation.

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
example `1.18.11+opencodez.1`. The release tag and embedded binary version must
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

Session creation carries the same optional metadata through both the current
Protocol API and the App compatibility adapter, so a selection made before the
first message survives creation, reload, and later protocol upgrades.

The Web prompt control stays in the compact model-control row. In the TUI the
same selection is secondary status: it is rendered as `S: <name>`, omitted
below 72 terminal columns, and capped at 24 columns so the model, agent, and
workspace indicators keep priority. Only the System selector is exposed;
upstream command templates remain an internal slash-command payload.

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
      "wire": "codex",
      "compaction": {
        "threshold": 0.9,
        "token_limit": 300000,
      },
      "system": {
        "default": "codex_gpt_5_5",
        "gpt-5.6-luna": "codex_gpt_5_6_luna_terra",
        "gpt-5.6-terra": "codex_gpt_5_6_luna_terra",
        "gpt-5.6-sol": "codex_gpt_5_6_sol",
      },
    },
  },
}
```

## Responses Wire Mode

ChatGPT OAuth sessions can use the stateful Responses WebSocket protocol from
Codex `rust-v0.146.0`. The first request in a fresh transport chain sends the
full conversation. Later compatible requests send only new input items together
with `previous_response_id` when the conversation prefix and model settings
still match. This continuation can cross a logical user-turn boundary, while
the turn-scoped `x-codex-turn-state` routing token is reset. A reconnect,
interruption, incompatible history, or relevant request-setting change starts a
new full chain without requiring a different local session.

The default is `codex`. Set `opencodez.responses.wire` to `legacy` to restore the
previous OpenCode request lifecycle: full authenticated HTTP requests, upstream
partial-output handling, and local text-summary compaction. The setting applies
only to OpenAI models authenticated through ChatGPT OAuth; OpenAI API-key access
and other providers are unchanged. Start a new CLI process or restart a
long-running server after changing the value so its provider adapter is rebuilt
with one unambiguous mode.

In `codex` mode, the authenticated Codex `/models` catalog is the live source
for model context, automatic-compaction limits, `comp_hash`, and Responses Lite
support. OpenCodez caches one account-scoped catalog for five minutes, deduplicates concurrent
refreshes, and marks it stale whenever a Responses stream reports a different
`x-models-etag`. A request without verified account identity can use its fresh
catalog response but never stores it for reuse. A failed account-scoped refresh
uses known fallback profiles for one minute instead of blocking model access;
an uncached failure applies that fallback only to its current request.

When a model advertises Responses Lite, OpenCodez applies the Codex Lite shape at
the authenticated fetch boundary. Tools become an `additional_tools` developer
item, base instructions become a developer message, top-level instructions are
empty, parallel tool calls are disabled, reasoning context is `all_turns`, and
image `detail` fields are removed. HTTP carries the Lite header and WebSocket
requests carry the matching client-metadata marker. Legacy wire mode bypasses
this transformation.

Fast aliases supplied by the model catalog keep the base model id and use
`service_tier: "priority"`. ChatGPT's Codex backend also requires the Codex
product originator for accelerated routing, so the OAuth adapter supplies it at
the existing authenticated fetch boundary. No extra request, entitlement probe,
warning, or UI state is involved. The response may still report
`service_tier: "default"`; paired Standard/Fast latency checks are the reliable
product-level validation.

OpenCodez automatically sends a full request after a reconnect, interrupted
response, context compaction, history edit, relevant model-setting change, or
failed compatibility check. A new logical user turn alone resets sticky routing
but does not invalidate an otherwise compatible continuation.
The existing HTTP fallback also receives the original full request rather than
an incremental body.

The WebSocket `response.create` envelope keeps the same `stream: true` field as
Codex, and the handshake identifies the conversation thread through
`x-client-request-id`. These values are supplied at the transport boundary so
HTTP request shaping and other providers remain unchanged.

Within one tool-driven turn, OpenCodez captures the Codex
`x-codex-turn-state` sticky-routing token from response metadata or HTTP
fallback headers, plus WebSocket upgrade headers when the runtime exposes them,
and returns it in subsequent sampling and remote-compaction requests. Bun's
client exposes neither rejected-upgrade status nor headers, so standalone
binaries switch an opaque non-101 handshake directly to HTTP for that request
and wait one minute before probing WebSocket again. Exact 426 responses and a
fully exhausted WebSocket retry cycle remain session-sticky HTTP fallbacks. This
keeps transient authentication and server failures recoverable without adding a
second socket stack or repeatedly probing an unsupported endpoint. The
logical turn ID survives synthetic compaction markers and is intentionally
cleared only when the next real user turn begins. The compatible WebSocket may
remain reusable, and `previous_response_id` may cross that boundary when strict
prefix and request-property checks succeed. If the server can no longer resolve
a `previous_response_id`, the transport internally opens a fresh socket and
retries that request once with the complete canonical input. Service metadata
before the error does not block recovery; the retry window closes only after
model output begins.

OpenCode persists streaming deltas immediately, unlike Codex's completed-item
history. In Codex wire mode, each sampling attempt therefore journals the IDs of
the text, reasoning, and step parts it creates. A retry first removes those
incomplete parts through the normal session event path, then replays the frozen
request; clients see retry state without an orphaned fragment or duplicated
answer. A tool call is the irreversible boundary for replaying the same provider
request, so an external side effect cannot run twice. If the tool result is
already durable when a transient stream failure arrives, OpenCodez marks that
assistant step as tool-driven and lets the normal session loop build the next
request from updated history. An unfinished or interrupted tool still stops the
turn rather than guessing whether its side effect completed. Other providers
keep the upstream partial-output behavior. Sampling follows Codex's finite
transport cycle: the initial WebSocket request plus five retries, one switch to
HTTP, then the initial HTTP request plus five retries. Retryable terminal error
frames consume the same WebSocket budget as connection failures. The terminal
error is surfaced after at most twelve network requests. A confirmed or
retry-exhausted HTTP fallback remains sticky for that session-and-account entry
until the session is removed or the bounded pool evicts it, avoiding periodic
WebSocket reprobes after a known transport failure.

Continuation state is keyed by both the local session and the ChatGPT account.
Changing accounts therefore opens a fresh chain and sends one full request
instead of reusing account-scoped response or reasoning IDs. When the login does
not expose a ChatGPT account id, OpenCodez uses the standard OAuth subject only
as an internal affinity fallback; it is never substituted into the provider's
`ChatGPT-Account-Id` header. Durable encrypted compaction is session history,
not continuation state: it remains in that full request after a login change,
as it does in Codex.

The model catalog profile is also turn-scoped. The bounded turn-settings journal
freezes the active account affinity, base API model, `comp_hash`, context limits,
Responses Lite capability, and the server reasoning-accounting signal. An ETag
refresh updates the account catalog in the background but affects only the next
logical user turn. ETags from both normal response metadata and the WebSocket
upgrade enter the same deduplicated refresh barrier. The next turn settles that
barrier before checking for a `comp_hash` transition and freezing its profile,
so it cannot make the transition decision from stale catalog data. This prevents
a long tool loop from changing wire shape or rejecting its own compacted state
halfway through execution. A login change during an active turn is rejected
before another account-scoped request can be sent; sending the next user message
starts a fresh account lane and retains any durable encrypted compaction state.

### History Revert and Branching

Session history remains canonical in the local OpenCode database. A staged
revert records only the target message and optional part; unrevert removes that
marker without changing stored messages. Sending a replacement prompt commits
the revert, removes the selected message and its later tail from the active
branch, and then creates the replacement user/assistant pair.

The shortened or edited input cannot match the previous Responses prefix, so
Codex wire deliberately omits `previous_response_id` and sends one full request
to start a new server-side branch. Later requests inside that active turn resume
incremental continuation normally. After a process restart, the in-memory continuation is
gone and the same local branch is reconstructed in another safe full request.
Forking a session copies message history under new IDs; reverting the fork does
not modify its original session.

### Server-Side Compaction

Automatic and manual compaction use Codex Remote Compaction V2 for ChatGPT
OAuth. OpenCodez sends a normal streamed `/responses` request through the same
transport as sampling and appends exactly one `compaction_trigger` input item.
The server must complete the stream with exactly one opaque compaction item.
This is the default ChatGPT wire implementation in Codex `rust-v0.146.0`; the
public [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction)
documents the related public API through `context_management` and standalone
`/responses/compact`, not this Codex-specific trigger. OpenCodez does not ask the
model for a local text summary.

The returned compaction item and at most 64,000 estimated tokens of newest
retained user messages are stored in the session's compaction part. Later model
requests discard the pre-compaction model-visible history, prepend this bounded
state to the new tail, and use the normal Responses transport. This survives
process restart and WebSocket reconnect without a second state store. The
original session history remains available locally for audit, but is no longer
sent to the model.

Remote compaction participates in `opencodez.responses.wire`: `codex` mode can
reuse the session/account WebSocket and incremental chain, while explicit
`legacy` mode creates the same local text summary as upstream OpenCode. A
session that already contains durable opaque OpenAI compaction state remains a
narrow compatibility exception: it continues that state over authenticated HTTP
instead of silently discarding context. Other providers always keep upstream
OpenCode local compaction. Switching opaque state to an incompatible provider
produces a clear error. Remote API failures are surfaced directly and never
fall back to a local summary.

For OpenAI Zero Data Retention credentials, remote compaction uses `store:
false`: encrypted reasoning state is included inline and non-persisted `rs_*`
IDs are not sent as item references. Replay always keeps the current request's
System prefix first, then inserts the bounded persisted state before the new
tail. Remote errors remain session-visible and never silently fall back to local
summarization.

Automatic compaction records whether pressure occurred before or during the
active turn. Pre-turn compaction keeps the pending user message outside the
compact request and replays it once after success without replacing media
attachments. The completed marker stores the exact replayed message ID rather
than comparing message content. If that replay still exceeds the provider
context, OpenCodez stops with a clear size error instead of repeating compact
and replay. Mid-turn
compaction sends the complete active turn to OpenAI,
including the current user request, assistant work, tool calls, and tool results.
The returned opaque state therefore contains the work already completed, and the
same loop continues without replaying the original task or adding a synthetic
continuation message. Both paths start a safe full Responses request after the
history replacement; later compatible turns can resume incremental continuation.

The post-sampling trigger also follows Codex: crossing the token limit starts
automatic compaction only when the model requires another sampling request,
such as after a tool call. A completed final answer is not compacted merely
because its final usage crossed the threshold. If the provider reports overflow
after emitting durable reasoning, text, or tool work, that partial turn is
treated as mid-turn and is included rather than discarded. Before a follow-up
request, OpenCodez also adds newly completed tool-output size to the provider's
last usage. A large result can therefore start mid-turn compaction before the
provider rejects the next request; if rejection still occurs, the durable
assistant/tool progress keeps recovery in the same mid-turn phase.

The active runner freezes the prepared effective System, transformed options,
and model-visible tool schemas used for sampling, then reuses that snapshot for
mid-turn compact while lowering the current history with all newly completed
tool work. Manual compaction and restart recovery reconstruct the same context
through the shared preparation boundary because no in-memory sampling snapshot
exists. If user steering arrives around compaction, it remains pending: it is
excluded from both compact input and the first mandatory post-compact
continuation, then admitted normally. This boundary remains tied to the original
active turn even if preflight underestimates the request and the provider itself
reports overflow; frozen request controls are then combined with history that
still excludes the pending steer. Before transport, OpenCodez estimates the
complete compact payload using a model-visible cost for inline images instead of
counting their base64 encoding as text. Text accounting uses UTF-8 bytes and
truncates only at Unicode code-point boundaries. Automatically resized images
use Codex's 1,844-token estimate; `detail: "original"` uses the provider's
conservative 10,000-patch maximum. Only when the payload would exceed the
Codex-safe request window does OpenCodez replace older tool outputs across the
request with a bounded marker. The authenticated Codex model catalog supplies
the current context and automatic compaction limit. Its fallback profiles mirror
Codex `rust-v0.146.0` with a `272000` context and a 90% trigger, so Luna, Terra,
and Sol use `244800` while the remote catalog is temporarily unavailable. Only
verbatim tool outputs receive a second conservative estimate because Codex caps
them on insertion while OpenCode preserves them durably. Ordinary text is not
globally doubled and can use the full safe window. Every tool result in the
active parallel-output batch keeps its image input even if its text must be
bounded, so the latest visual state cannot be lost merely because a short sibling
result was serialized later. If bounding all eligible tool outputs still cannot
fit the safe request window, OpenCodez fails before network I/O with a clear
remote-compaction input error. User
messages, tool calls, and pending input are never summarized or dropped locally,
and the durable local history remains unchanged. Each compaction stream retries
transient failure at most twice per transport inside one 20-minute cancellable
operation. A valid server `Retry-After` value replaces the local exponential
delay for that retry, and Stop does not leave a request running in the background.

Remote output follows pinned Codex V2 semantics: additional stream output items
are ignored, exactly one completed opaque compaction item is installed as-is,
and newest user messages are retained within the bounded budget. Current System
instructions are regenerated for each request instead of being owned by opaque
state; assistant, reasoning, and tool artifacts are not retained beside it. New
compaction state also records the source API model and the model catalog's
`comp_hash`. Standard, Fast, Pro, and base-model aliases sharing that hash remain
compatible. A login change keeps the encrypted item but starts a fresh full
request, so no response or reasoning ID crosses the account boundary. When the
known hash changes between logical turns, or the current model has a smaller
effective context window that cannot fit the active token state, OpenCodez
performs one remote pre-turn transition through the same compaction state machine
before sampling. This also applies when the history has never been compacted
before. The pending user message remains outside the compact request and is
replayed once afterward. The transition first uses the previous turn's model and
falls back once to the current model when the previous model is unavailable or
cannot complete the request. Its durable marker records whether the cause was a
hash change or model downshift, plus the target model and available target hash,
so restart recovery follows the same path. A bounded 32-entry journal in session
metadata preserves the recent model boundary across restart and normal history
edits without another state store. Older sessions without that journal can still
derive cross-model transitions from their durable user-model history; existing
opaque state remains protected by its persisted model and hash.

Codex reports whether server usage already includes retained encrypted
reasoning through `x-reasoning-included`. OpenCodez preserves that signal from
HTTP responses and WebSocket upgrade metadata in the active turn journal, then
resets it at the next user boundary. When it is absent, older encrypted
reasoning before the current user boundary is estimated with Codex's
base64-aware formula and added only to the compaction decision. Provider usage
and durable message accounting are not rewritten.

If the provider itself reports context overflow while automatic compaction is
enabled, that error is treated as an internal recovery trigger rather than
surfaced as a failed user turn. Manual compaction still stops after writing the
compacted state and waits for the next user message. A manual `/compact` uses
the model currently selected by the caller, even when the previous user turn
used another model. The UI renders the completed divider only after the remote
operation succeeds; a failed request remains an error rather than appearing as
a successful compaction.

#### Compaction Policy

`opencodez.responses.compaction.threshold` controls the fraction of the
Codex-safe ChatGPT Responses context at which compaction runs. That context is
the smaller of the provider input limit and the authenticated model catalog's
context or automatic-compaction limit. The threshold defaults to `0.9`, matching
Codex, and accepts values greater than `0` and no greater than `0.9`. This
permits earlier compaction without allowing a less safe threshold than Codex.

Optional `opencodez.responses.compaction.token_limit` is a positive integer and
acts like Codex's absolute `model_auto_compact_token_limit`. The effective limit
is:

```text
min(min(provider_input_window, catalog_context) * threshold, token_limit when set, usable_input_limit)
```

For the fallback Luna, Terra, and Sol profiles, the default trigger is `244800`
tokens. Setting `threshold` to `0.8` moves it to `217600`; setting `token_limit`
to `200000` lowers it further to `200000`.

The accounting scope is the full active context, which is the Codex default.
The advanced Codex `body_after_prefix` scope is intentionally not exposed
because OpenCode does not maintain Codex's carried-prefix token counter and an
approximation would make compaction timing unstable.

### Custom Responses Architecture

The fork-specific implementation stays inside the existing OpenAI plugin and
OpenCodez config boundary:

- `packages/core/src/v1/config/opencodez.ts` defines the public wire and
  compaction policy, while `packages/core/src/opencodez/settings.ts` owns the
  `codex` and 90% defaults without embedding live model metadata.
- `packages/opencode/src/plugin/openai/codex.ts` enables the mode only for
  ChatGPT OAuth, supplies the Codex product originator required by Fast routing,
  lowers the authenticated request once, and leaves API-key OpenAI access and
  other providers unchanged.
- `packages/opencode/src/opencodez/codex-responses/` is the complete
  ChatGPT-OAuth subsystem. It has no background worker or second durable store,
  and no other provider imports it.
- `protocol.ts` creates one canonical Codex metadata snapshot for each request:
  installation, session/thread, logical turn, compacted window, request kind,
  and compaction phase. It places that snapshot in
  `client_metadata["x-codex-turn-metadata"]` and derives the compatible HTTP/WS
  projections from the same value. Server control metadata stays on the stream;
  only turn state mutates the active transport lane and only model ETag mutates
  the matching account catalog.
- `catalog.ts` owns an eight-account least-recently-used catalog map. Each
  account has an independent five-minute cache, in-flight refresh, and short
  scheduling barrier for upgrade-header ETags; a missing verified identity uses
  an uncached request and cannot create reusable state.
- `request.ts` is the single raw request boundary for metadata, Responses Lite
  shaping, persisted-state injection, and removal of the internal continuation
  marker.
- `continuation.ts` owns prefix matching, response item normalization,
  `previous_response_id`, and continuation invalidation. Continuation is reused
  across compatible requests and logical user turns; the sticky routing token
  has a shorter turn-scoped lifetime, while the transport connection has a
  longer independent lifetime.
- `compact.ts` builds the canonical V2 trigger request with the existing
  Responses lowering, bounds only oversized tool output, requires exactly one
  completed `compaction`/`compaction_summary` item with encrypted content, and
  installs bounded retained user context.
- `compaction.ts` finds persisted compaction items without writing a second
  state store, keeps the bounded turn-settings journal and frozen catalog
  profile, and checks model/backend-snapshot compatibility. A random one-shot
  handoff moves durable context across the AI SDK request boundary; it expires
  after one minute and the process retains at most 128 handoffs. Direct mid-turn
  continuation uses one internal non-network marker to satisfy the AI SDK's non-empty prompt
  validation; the request adapter removes it before network I/O.
- `attempt.ts` owns request kinds, bounded retry policy, and the lightweight
  sampling-attempt journal. It records only part IDs, permits rollback before a
  tool-call side-effect barrier, resumes from durable tool results without
  replaying their side effects, and prevents nested WebSocket-plus-HTTP retry
  multiplication.
- `transport.ts` owns one continuation per session-and-account lane, the
  turn-scoped sticky-routing token, finite fallback state, and the single
  full-request recovery for an unavailable previous response. A 426 upgrade
  response selects HTTP immediately; an opaque rejected upgrade uses a one-minute
  HTTP cooldown; retryable terminal frames consume the same fallback budget as
  broken connections; a 401 returns to the OAuth owner for one token refresh and
  one safe pre-output replay. Codex-mode handshakes carry the thread request id,
  expose model-catalog ETags to the refresh barrier, and WebSocket frames retain
  the explicit streaming flag. A new logical user turn resets sticky routing
  without discarding compatible continuation or a healthy socket.
- `packages/opencode/src/session/model-context.ts` is the shared preparation
  boundary for effective System context, transformed history, and model-visible
  tools used by both sampling and compact requests. The active runner retains
  the prepared request controls through a pending mid-turn compact without a
  second storage layer.
- `packages/opencode/src/session/prompt.ts` owns the explicit follow-up and
  durable-output decision, while `packages/opencode/src/session/compaction.ts`
  owns pre-turn replay, previous-model-first hash transitions with one
  current-model fallback, complete mid-turn history, and the pending-input
  boundary through the first post-compact continuation.
- The transport pool retains at most 256 session entries; transport fallback
  remains sticky until explicit removal or bounded eviction.
  Continuation resets on reconnect, login change, abort, failure, or concurrent
  HTTP fallback; sticky routing is accepted from metadata events, HTTP response
  headers, and WebSocket upgrade headers on runtimes that expose them, then
  resets independently at the next logical user turn. WebSocket handshake
  metadata also carries the server reasoning-accounting signal back to the
  normal AI SDK response boundary.
- `packages/opencode/src/plugin/openai/ws.ts` remains the low-level WebSocket to
  SSE adapter, distinguishes service events from model output for safe recovery,
  and exposes raw response events to the continuation state.

The shared provider and `packages/llm` abstractions are unchanged, keeping this
custom layer small and easy to rebase onto future OpenCode versions.

The wire capability is decided once from four facts: provider id `openai`, the
official `@ai-sdk/openai` model adapter, OAuth authentication, and
`opencodez.responses.wire: "codex"`. Session continuation, retry rollback,
Codex-only unknown-finish recovery, catalog accounting, and new remote
compaction all use that same decision. This is a hard isolation boundary rather
than a transport hint: API-key OpenAI, compatible third-party adapters, other
providers, and explicit `legacy` mode retain the upstream lifecycle.

Pinned Codex also contains WebSocket prewarming, which is a latency optimization
rather than a correctness requirement. OpenCodez keeps its existing lazy,
session-affine pool to avoid an idle connection and additional lifecycle state.
Remote Compaction V2 uses the same `/responses` transport and
`compaction_trigger` contract as pinned Codex while adapting installed history
to OpenCode's durable session model. Persisted opaque state follows the
`comp_hash` published by the authenticated Codex model catalog, while reusable
transport and catalog state remain account-scoped. Responses carry the catalog
ETag, so a backend-snapshot change schedules one deduplicated refresh without a
service restart. Known profiles remain only as a short-lived fallback for
catalog outages; maintainers update those profiles when adding a supported base
model, not for routine backend metadata changes.

A pre-output 401 performs one deduplicated OAuth refresh. OpenCodez replays the
already lowered request only when the refreshed account affinity is unchanged;
if identity changed, the failed attempt returns normally and the next request is
rebuilt from canonical session state under the new account.

Remote compaction retry timing follows the same bounded policy as sampling but
prefers a valid server `Retry-After` value over local exponential backoff. This
keeps overload recovery cooperative without adding another scheduler or queue.

## Session Behavior

An inherited System choice follows the active model. Switching from Luna to Sol
therefore changes the effective prompt automatically. A manual `/system` choice
belongs to the session and remains active across model changes.

Choosing `None` explicitly disables the selectable System prompt for the
session.

## Commands

```text
/system
/system <name>
/system none
```

`/system` opens the System selector when no name is provided. The web composer
exposes the same `S: <id>` control.

## Web Operation

`OPENCODE_WEB_SERVERS_JSON` can seed managed server connections in the web app.
Valid user-stored servers remain authoritative and environment entries fill only
missing URLs.

The v2 composer keeps Agent, System, Model, Variant, and Send controls in one
bounded row. Controls shrink and truncate on narrow/mobile layouts while
desktop spacing remains unchanged; Agent, System, and Variant become icon-only
below the `sm` breakpoint so the Model stays readable and the Send action never
leaves the composer.

OpenCodez can embed the built web UI as one packed binary asset. Runtime delivery
unpacks it in memory, applies SPA fallback, preserves MIME types, serves
compressed variants, and emits `Vary: Accept-Encoding`. A versioned on-disk UI
cache remains available when configured.

## Project Safety

Non-git projects remain scoped to the selected directory. Explicit filesystem
roots clamp to the user home directory, and background file indexing is
disabled by default.

`OPENCODE_DISABLE_FFF=1` selects a no-op file-search layer. It starts neither
FFF nor the upstream `rg --files` fallback and retains no background path list.
Consequently Web/TUI fuzzy file suggestions return no entries, but direct
directory listing, file reads, drag-and-drop, and explicit agent `glob`/`grep`
tools continue to work. Set `OPENCODE_DISABLE_FFF=0` to opt into upstream FFF;
when FFF is unavailable, upstream's ripgrep fallback remains available for that
explicit opt-in mode.

## Implementation Map

```text
packages/core/src/opencodez/settings.ts
packages/core/src/opencodez/session.ts
packages/core/src/opencodez/slash.ts
packages/core/src/filesystem/search.ts
packages/opencode/src/opencodez/prompt-library.ts
packages/opencode/src/opencodez/default-prompts/
packages/opencode/src/plugin/openai/codex.ts
packages/opencode/src/opencodez/codex-responses/attempt.ts
packages/opencode/src/opencodez/codex-responses/catalog.ts
packages/opencode/src/opencodez/codex-responses/compact.ts
packages/opencode/src/opencodez/codex-responses/compaction.ts
packages/opencode/src/opencodez/codex-responses/continuation.ts
packages/opencode/src/opencodez/codex-responses/protocol.ts
packages/opencode/src/opencodez/codex-responses/request.ts
packages/opencode/src/opencodez/codex-responses/transport.ts
packages/opencode/src/plugin/openai/ws.ts
packages/opencode/src/session/llm/request.ts
packages/opencode/src/server/routes/instance/httpapi/groups/opencodez.ts
packages/opencode/src/server/routes/instance/httpapi/handlers/opencodez.ts
packages/tui/src/component/opencodez-dialogs.tsx
packages/app/src/components/prompt-input.tsx
packages/session-ui/src/v2/components/prompt-input/index.tsx
```

The OpenAPI document and JavaScript SDK are generated from the server contract.

## Release Verification

A release should confirm the mapped System prompts, both Responses wire modes,
strict legacy local-compaction and partial-output parity, non-OpenAI provider
isolation, default and configured compaction thresholds, one streamed V2
compaction trigger with exactly one opaque result, logical-turn sticky routing, exact per-transport
retry budgets, partial-attempt rollback before the tool side-effect barrier,
compatible cross-turn incremental requests with safe full-request resets, frozen
same-turn catalog behavior, provider-isolated post-turn compaction,
reasoning-aware usage accounting, oversized-replay failure, both `comp_hash` and
model-downshift transitions, cooperative compaction retry delay, remote state
persistence across restart, generated SDK, one production Linux build, embedded
web UI startup, and desktop/mobile System selector behavior. The public release
must contain all platform archives
plus one SHA-256 file per archive.
