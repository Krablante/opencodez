# OpenAI Responses WebSocket

ChatGPT OAuth uses the Codex stateful WebSocket transport by default. Set
`opencodez.responses.wire` to `legacy` to restore the previous request flow.
The upstream full-request WebSocket transport is enabled by default on `local`,
`dev`, and `beta`; on `latest` and `prod`, set
`OPENCODE_EXPERIMENTAL_WEBSOCKETS=true`.

## Flow

1. A streamed `POST /responses` request arrives.
2. If it has no `session-id` or `x-session-affinity` header, use HTTP.
3. Title requests use HTTP.
4. If that session's socket is busy or already in fallback mode, use HTTP.
5. Otherwise, reuse its open socket or open a new one.
6. In `legacy` mode, send the complete `response.create` body.
7. In `codex` mode, send the first request in full. Later matching requests send
   only new input items with `previous_response_id`.
8. Capture `x-codex-turn-state` from response metadata or HTTP fallback
   headers, plus WebSocket upgrade headers when the runtime exposes them. Bun's
   client does not expose upgrade response headers, so the standalone binary
   uses backend metadata without adding another handshake. Keep the state in
   `client_metadata` for follow-ups within the same logical user turn,
   including compaction, then clear it at the next turn without discarding
   compatible continuation state.
9. Return WebSocket events as SSE.

For ChatGPT OAuth, the fetch adapter supplies the Codex product originator.
Model-catalog Fast aliases already lower to the same base model with
`service_tier: "priority"`; the product originator is the only additional
routing requirement. API-key OpenAI requests do not pass through this adapter.

## Lifetime

- Connect timeout: 15 seconds.
- Idle timeout: 5 minutes.
- After a completed response, keep the socket for reuse.
- Reuse a socket for up to 55 minutes, then replace it on the next request.
- Reset Codex continuation state whenever the socket is replaced, aborted, or
  fails.
- Scope pool entries to both session ID and ChatGPT account ID. A login change
  therefore starts a full request chain instead of reusing account-scoped
  response or reasoning IDs. If the account id claim is absent, the OAuth
  subject is used only as an internal affinity fallback and is stripped before
  network I/O.

## Retries

- Retry sampling WebSocket stream/setup failures up to 5 times, then use HTTP
  until the session pool entry expires after its idle timeout. Compaction uses a
  smaller two-retry transport budget.
- `websocket_connection_limit_reached` consumes the same retry budget and HTTP fallback.
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
- OpenAI session retries are finite. The existing WebSocket-to-HTTP transition
  and the session-level policy share a seven-retry end-to-end ceiling.
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
turns continue incrementally from that branch. A restart also forces a full
request reconstructed from the edited local history. Forked sessions use new
message IDs, so their reverts cannot mutate the original session.

## Remote Compaction

ChatGPT OAuth compaction uses Codex Remote Compaction V2. The session layer
builds a normal streamed `/responses` request through the same context
preparation and lowering as sampling, then appends exactly one
`compaction_trigger`. The transport requires exactly one completed opaque
compaction item. That item plus at most 64,000 estimated tokens of newest
retained user messages is stored in `CompactionPart.remote`; stale reasoning,
tool, and instruction artifacts are not installed. Mid-turn compact uses the
same session/account socket and logical turn ID, so sticky routing survives the
request and mandatory post-compact continuation. Manual and pre-turn compact do
not inherit state from an earlier user turn.

On later turns, the request layer registers persisted items for the current
session and adds a private header. This fetch adapter removes that header before
network I/O and prepends the opaque items to the lowered tail. The session part
is the only persistent state; the in-memory map is a request-local transport
bridge and is cleared when the session is deleted.

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

The default trigger is 90% of the Codex-safe ChatGPT Responses context, capped
by the model and usable input limits. Codex `rust-v0.146.0` advertises a `272000`
context for the current models, making their default trigger `244800` even when
the general provider catalog is larger. `opencodez.responses.compaction.threshold`
may lower that percentage and `token_limit` may add a lower absolute cap. Both
settings affect only ChatGPT OAuth remote compaction; other providers continue
to use upstream OpenCode policy.

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
transient failures at most twice; manual compaction does not auto-continue.

Persisted opaque state records the source API model, account key, and Codex
`comp_hash`. A known backend-snapshot change first refreshes that state through
the same remote compaction path, then resumes the pending user turn. When the
pinned Codex version changes, update the model-to-`comp_hash` table in
`packages/core/src/opencodez/settings.ts` from its model metadata before rolling
out the fork.
