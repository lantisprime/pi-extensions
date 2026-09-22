# Status-line consolidation protocol

Extensions coordinate over pi's shared extension event bus (`pi.events`) so that
ONE footer segment can carry what used to be several scattered `setStatus` items.

Channel: `pi-extensions:status-line`

## Roles

- **Renderer** (currently `context-manager`): owns the single `setStatus` key
  `ctx-suite`. Announces itself and renders the combined segment.
- **Publisher** (currently `smart-compaction`): computes its own status text but
  hands it to the renderer when one is present. Falls back to its own
  `setStatus` segment when no renderer answers, so it works standalone.

## Messages (all plain objects on the channel)

| type              | from      | payload                                   | meaning                                   |
|-------------------|-----------|-------------------------------------------|-------------------------------------------|
| `renderer-hello`  | renderer  | —                                         | "I render; publishers switch to bus mode" |
| `publisher-hello` | publisher | `{ source: string }`                      | "just loaded; any renderer out there?"    |
| `status`          | publisher | `{ source, text?, short? }`               | current status; `text: undefined` clears  |

- `short` is the decluttered variant (e.g. smart-compaction drops its context
  percent because pi's built-in footer already shows `ctx NN%`); the renderer
  prefers `short` over `text`.
- Handshake covers both load orders: the renderer emits `renderer-hello` on
  `session_start`; a publisher emits `publisher-hello` on `session_start`, and
  the renderer answers it with `renderer-hello`.
- On receiving `renderer-hello`, a publisher clears its own segment
  (`setStatus(key, undefined)`) and re-publishes its current status on the bus.

## Rendered segment (context-manager, `ctx-suite`)

Parts joined with ` · `, empty parts omitted:

```
sc balanced · f100 · CH99
```

- `sc …` — smart-compaction short text (mode + transient state).
- `f<n>` plus any NONZERO of `s<n> d<n> e<n>` — context-health shares
  (fresh/stale/dup/error), condensed: zero shares are omitted.
- `CH<n>` — per-call cache health from the last assistant message.
- `p:<n>%⚠(queued)` — purity-budget flush warning, when queued.

Legacy behavior is preserved per extension: `statusLine.consolidate: false`
in `.pi/context-manager.json` restores the standalone `ctx-health` segment
(and context-manager stops announcing itself, so smart-compaction falls back
to its own `smart-compact` segment automatically).
