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
8. Return WebSocket events as SSE.

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
  response or reasoning IDs.

## Retries

- Retry WebSocket stream/setup failures up to 5 times, then use HTTP for that session until the pool entry is idle-pruned.
- `websocket_connection_limit_reached` consumes the same retry budget and HTTP fallback.
- If a WebSocket fails after its first event, fail it as retryable rather than replaying partial output in transport.
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

ChatGPT OAuth compaction uses `POST /responses/compact` regardless of the
selected Responses wire mode. The session layer builds the request through the
same Responses lowering as normal model turns, stores the returned canonical
items in `CompactionPart.remote`, and starts a new full request chain.

On later turns, the request layer registers persisted items for the current
session and adds a private header. This fetch adapter removes that header before
network I/O and prepends the opaque items to the lowered tail. The session part
is the only persistent state; the in-memory map is a request-local transport
bridge and is cleared when the session is deleted.

Remote endpoint errors are returned as session errors. There is no local-summary
fallback for ChatGPT OAuth.

For Zero Data Retention credentials, compact input is lowered with `store:
false`. Encrypted reasoning state is therefore sent inline instead of as a
non-persisted `rs_*` item reference. When the returned state is replayed, its
echoed system item is discarded and the current request's system prefix remains
first. Remote errors remain visible and still have no local fallback.

The default trigger is 90% of the model input window, capped by the usable input
limit. `opencodez.responses.compaction.threshold` may lower that percentage and
`token_limit` may add a lower absolute cap. Both settings affect only ChatGPT
OAuth remote compaction; other providers continue to use upstream OpenCode
policy.

Pre-turn automatic compaction replays the pending user turn after compacting
the older history. A provider context-overflow is an internal trigger while
automatic compaction is enabled, so it does not emit a transient session error.
Manual compaction does not auto-continue.
