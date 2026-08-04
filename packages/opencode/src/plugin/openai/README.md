# OpenAI Responses WebSocket

ChatGPT OAuth uses the Codex stateful WebSocket transport by default. Set
`opencodez.responses.wire` to `legacy` to restore the previous request flow.
The upstream full-request WebSocket transport is enabled by default on `local`,
`dev`, and `beta`; on `latest` and `prod`, set
`OPENCODE_EXPERIMENTAL_WEBSOCKETS=true`.

## Flow

1. A streamed `POST /responses` request arrives. Request preparation enables
   Codex behavior only for provider `openai`, the official `@ai-sdk/openai`
   adapter, ChatGPT OAuth, and `wire: "codex"`. One private header carries that
   decision to this adapter and is removed before network I/O.
2. For an enabled Codex request, the request adapter installs one canonical
   metadata snapshot in `client_metadata`, with compatible HTTP/WS projections
   derived from it. A missing or false marker bypasses that lowering.
3. If it has no `session-id` or `x-session-affinity` header, use HTTP.
   Codex mode also uses HTTP when no verified account identity is available,
   preventing reusable response state from crossing an unknown account boundary.
4. Title requests use HTTP.
5. If that session's socket is busy or already in fallback mode, use HTTP.
6. Otherwise, reuse its open socket or open a new one. Codex-mode handshakes use
   the session/thread id as `x-client-request-id`.
7. In `legacy` mode, send the complete `response.create` body. WebSocket frames
   retain the explicit `stream: true` request field and do not acquire Codex
   continuation, turn-state, catalog, or replay semantics.
8. In `codex` mode, send the first request of each logical user turn in full.
   Later matching requests inside that turn send only new input items with
   `previous_response_id`; a healthy socket may remain open across the boundary.
9. Capture `x-codex-turn-state` from response metadata or HTTP fallback
   headers, plus WebSocket upgrade headers when the runtime exposes them. Bun's
   client exposes neither rejected-upgrade status nor headers, so the standalone
   binary switches an opaque non-101 handshake directly to HTTP for that request,
   waits one minute before trying WebSocket again, and uses backend metadata
   without adding another socket stack. Keep the state in
   `client_metadata` for follow-ups within the same logical user turn,
   including compaction, then clear it together with continuation at the next
   turn without discarding a healthy socket.
10. Return WebSocket events as SSE. Preserve the handshake's
    `x-reasoning-included` signal on the synthetic response so normal usage
    accounting can distinguish server-counted historical reasoning.
    Server-selected model, reasoning, rate-limit, moderation, verification, and
    safety metadata remains on that stream; it is advisory and is not persisted
    as local conversation state.

For ChatGPT OAuth, the fetch adapter preserves the established Codex product
originator in both wire modes.
Model-catalog Fast aliases already lower to the same base model with
`service_tier: "priority"`; the product originator is the only additional
routing requirement. API-key OpenAI requests do not pass through this adapter.
Alternate OpenAI model adapters can share OAuth but still fail closed into their
unchanged request path because they cannot receive a true capability marker.

The authenticated `/models` catalog supplies context, automatic-compaction
limits, `comp_hash`, and Responses Lite capability. It refreshes every five
minutes or when a stream reports a new `x-models-etag`, with one deduplicated
in-flight request and a short known-profile fallback. Responses Lite models move
tools and instructions into developer input items, use `all_turns` reasoning
context, strip image `detail`, and carry the required HTTP header or WebSocket
metadata marker. Without verified identity, a request can use its fresh catalog
response but does not add it to the reusable account cache. Legacy wire mode
keeps the unmodified request shape.

The first request records a bounded turn profile containing account affinity,
the base API model, context limits, `comp_hash`, and Responses Lite capability.
Every sampling and compaction request in that logical turn uses the same profile,
even if an ETag refresh updates the account catalog in the background. A login
change during the active turn fails before another request is sent; the next user
message starts a fresh lane while durable encrypted compaction remains portable.

## Lifetime

- Connect timeout: 15 seconds.
- Idle timeout: 5 minutes.
- After a completed response, keep the socket for reuse.
- Reuse a socket for up to 55 minutes, then replace it on the next request.
- Cool down WebSocket for one minute after an opaque Bun upgrade rejection.
- Reset Codex continuation state whenever the socket is replaced, aborted, or
  fails, and at every logical user-turn boundary. Turn changes do not close a
  healthy socket.
- Scope pool entries to both session ID and ChatGPT account ID. A login change
  therefore starts a full request chain instead of reusing account-scoped
  response or reasoning IDs. If the account id claim is absent, the OAuth
  subject is used only as an internal affinity fallback and is stripped before
  network I/O.

## Retries

- Retry sampling WebSocket stream/setup failures up to 5 times, switch once,
  then retry HTTP up to 5 times. This is at most 12 network requests. Compaction
  uses a smaller two-retry budget on each transport, at most 6 requests.
- `websocket_connection_limit_reached` consumes the same retry budget and HTTP fallback.
- WebSocket upgrade status 426 selects sticky HTTP fallback immediately without
  spending the WebSocket retry budget.
- An opaque Bun upgrade rejection uses HTTP immediately but is not treated as a
  permanent 426; WebSocket becomes eligible again after the one-minute cooldown.
- For a Codex-wire request, an HTTP or pre-output WebSocket 401 performs one
  deduplicated OAuth refresh and replays the request once only when account
  affinity is unchanged. Legacy mode returns the response through the upstream
  lifecycle without this response-driven replay. An identity change or second
  Codex 401 is returned normally so a later request is rebuilt from canonical
  session state.
- `previous_response_not_found` opens a fresh socket and retries the current
  canonical full request once without consuming the normal stream-failure
  budget. A repeated failure is returned normally.
- A service/control event does not block `previous_response_not_found` recovery;
  only the first model-output event closes that safe retry window.
- A Codex-wire attempt journals only the part IDs it creates. If transport fails
  after partial text or reasoning, those incomplete parts are removed before
  retry and the retry status remains visible through the normal session UI.
  Once a tool call has been admitted, the attempt is irreversible: automatic
  replay stops so a side effect cannot run twice. Other providers keep the
  upstream partial-output policy.
- OpenAI session retries are finite. One derived policy owns both sides of the
  WebSocket-to-HTTP transition, preventing nested retry multiplication.
- Remote compaction uses a valid server `Retry-After` value instead of local
  exponential delay for that retry; the existing attempt and operation limits
  remain authoritative.
- Abort or cancel closes the socket.

## Concurrency

Concurrent requests in one session use HTTP. Before that fallback starts, the
pool invalidates the session continuation so an in-flight WebSocket response
cannot later restore a stale `previous_response_id`. The next WebSocket request
therefore starts a new full-request chain. A second WebSocket is intentionally
not maintained.

## History Edits

Revert and edit keep local session history authoritative. Staging and clearing a
revert do not mutate messages. Committing a replacement deletes the selected
message and later tail, so the next Codex-wire request fails prefix matching by
design, omits `previous_response_id`, and starts a full-request branch. Later
requests inside that turn continue incrementally from the branch. A restart also forces a full
request reconstructed from the edited local history. Forked sessions use new
message IDs, so their reverts cannot mutate the original session.

## Remote Compaction

ChatGPT OAuth compaction uses Codex Remote Compaction V2. The session layer
builds a normal streamed `/responses` request through the same context
preparation and lowering as sampling, then appends exactly one
`compaction_trigger`. The transport requires exactly one completed opaque
`compaction` or compatible `compaction_summary` item containing encrypted
content. That item plus at most 64,000 estimated tokens of newest
retained user messages is stored in `CompactionPart.remote`; stale reasoning,
tool, and instruction artifacts are not installed. Mid-turn compact uses the
same session/account socket and logical turn ID, so sticky routing survives the
request and mandatory post-compact continuation. Manual and pre-turn compact do
not inherit state from an earlier user turn.

On later turns, the request layer creates a random one-shot handoff and adds it
as a private header. This fetch adapter consumes and removes that header before
network I/O, then prepends the opaque items to the lowered tail. The session part
is the only persistent state; the request-local bridge expires after one minute,
is capped at 128 entries, and cannot be reused.

Direct mid-turn continuation has no new model-visible user input. Because the
AI SDK rejects an empty local message list before transport, lowering inserts a
single internal marker and this adapter removes it before network I/O. The
Responses request therefore contains the opaque compacted state without a
synthetic continuation message.

Remote endpoint errors are returned as session errors. There is no local-summary
fallback for ChatGPT OAuth.

For Zero Data Retention credentials, compact input uses `store: false`.
Encrypted reasoning state is therefore sent inline instead of as a
non-persisted `rs_*` item reference. When persisted state is replayed, the
current request's System prefix remains first. Remote errors remain visible and
still have no local fallback.

The default trigger is 90% of the Codex-safe ChatGPT Responses context from the
authenticated model catalog, capped by the model and usable input limits. The
fallback profiles mirror Codex `rust-v0.146.0` at `272000`, making their default
trigger `244800` during a catalog outage.
`opencodez.responses.compaction.threshold` may lower that percentage and
`token_limit` may add a lower absolute cap. Both settings affect only ChatGPT
OAuth remote compaction; other providers continue to use upstream OpenCode
policy.

Automatic compaction persists an explicit phase. Pre-turn compaction excludes
the pending user message from compact input and replays it once after success.
The marker stores the exact replayed message ID; if that replay still overflows,
the session stops with a size error instead of entering another compact/replay
cycle.
Mid-turn compaction includes the complete active turn—current user input,
assistant work, tool calls, and tool results—and continues from the returned
opaque state in the same model loop, without a synthetic continuation message or
replayed task. A provider context-overflow is an internal trigger while
automatic compaction is enabled, so it does not emit a transient session error.
Post-sampling compaction runs only when another model request is required; a
finished answer never causes a redundant continuation. Steering input arriving
around compaction is withheld from both compact input and the first mandatory
continuation, then admitted normally. Inline images are estimated at their
model-visible cost rather than as base64 text; `detail: "original"` uses the
provider's 10,000-patch maximum. If the compact payload remains too large, a
transport-boundary pass replaces older tool outputs across the request with a
bounded marker while retaining image input from every result in the active
parallel-output batch. Only tool outputs receive a second conservative estimate,
so ordinary text can use the full safe window. If those eligible rewrites still
cannot fit, the request fails locally instead of sending a predictably rejected
payload. The durable history is not rewritten. A compaction stream retries
transient failures at most twice per transport and honors `Retry-After`; manual
compaction does not auto-continue.

Persisted opaque state records the source API model and catalog `comp_hash`.
Session metadata also keeps the latest 32 logical-turn model profiles and each
active turn's `x-reasoning-included` state. The signal resets at the next user
boundary. When the header is absent, encrypted reasoning before the current user
boundary receives Codex's base64-aware token estimate for the compaction
decision only. A hash change therefore creates a pre-turn compact even for raw
history. A switch from a larger effective context window also creates one when
the active token state no longer fits the current model. The previous model runs
first, the current model is tried once if that model is unavailable or fails,
and the pending user message remains outside the compact request until replay.
The durable transition marker carries the transition reason, target model, and
available target hash so restart recovery follows the same path. The
authenticated model catalog refreshes every five minutes and immediately after
an `x-models-etag` change; known fallback profiles cover temporary catalog
failure without becoming a second live source of truth.

A login change discards account-scoped continuation and sends a fresh full
request. The encrypted compaction item remains in that request as durable session
history, matching Codex without carrying response or reasoning IDs across the
account boundary.
