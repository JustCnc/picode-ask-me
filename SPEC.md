# picode-ask-me — SPEC (V1 POC)

Feasibility port of `pi-ask-me` (a Pi extension) onto PiCode **native plugin capabilities**.
The old package (`D:/Study/Code/Node/pi-ask-me`) is the behavioural reference only.

## Goal

One dependency-free stdio MCP server that:

1. exposes the MCP tool `ask_user_question` (1–4 questions × 2–4 options, optional `header`,
   option `description`/`preview`, `multiSelect`);
2. turns each call into a native PiCode question via the plugin→host reverse request `picode/ask`
   on the **same MCP connection**, and
3. answers the host `picode/handshake` with `{version: 1, capabilities: ["ask"]}` so the host
   enables the `ask` contribution for that connection.

No runtime hooks, no TUI, no Pi `ExtensionAPI`, no dependencies, no build step.

## Non-goals / verified-unavailable (old behaviour intentionally dropped)

| Old surface                                       | PiCode native status                                                                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before_agent_start` system-prompt nudge          | **Unavailable.** No prompt/system-prompt contribution kind; plugin `hooks` are shell commands (`SessionStart`/`UserPromptSubmit`/…), and `UserPromptSubmit` can only block a prompt, never inject prompt text. |
| `/prompt on\|off\|once` command                   | **Unavailable.** `kind: "command"`/`"prompt"` are manifest-valid but host-unsupported (`PLUGIN_CONTRIBUTION_HOST_READY` excludes them; UI shows unsupported).            |
| TUI widget path (`ask-tui.ts`, arrow keys, notes) | Out of scope. PiCode renders questions through its own pending-interaction UI; hosted plugins get no widget/TUI surface.                                                  |
| `ctx.hasUI`, `Type something.` typed row          | Not applicable. The host appends its own custom row; those labels stay rejected in authoring.                                                                            |
| Per-question `notes`, global note                 | The native ask payload has no such fields. `parseAskResponse` still tolerates them (structured-answer hosts), `formatAskResult` still renders them; no host sends them.     |
| JSON-stringified args repair for GLM              | Kept (pure normalization, no host dependency).                                                                                                                            |

Ambiguity guidance therefore lives in the **tool description** and the `initialize.instructions`
string only. No automatic turn nudge is claimed, and no `skill` contribution is declared: a skill
cannot nudge a turn, and shipping one would imply an effect it does not have.

## Discoverability / exposure

PiCode's MCP server config defaults to `exposure: "codemode"`, so with the default host config the
tool is **not** a direct tool: the model reaches it by writing codemode that calls the MCP tool. That
codemode path is the verified one.

`tool_search` can also surface the tool, but only when the host config enables that host tool; it is
not part of this plugin's manifest and cannot be turned on from here. SPEC therefore claims codemode,
not `tool_search`, as the access path that always exists.

To keep the tool findable either way:

- tool name `ask_user_question`, and a description that says to pass questions as function
  parameters rather than chat text;
- `initialize` returns `instructions` (a short string naming the tool and its purpose), which
  `pi-mcp`'s `McpClient` validates and keeps on the server info.

## Manifest

`.picode-plugin/plugin.json` (preferred path; `.zcode-plugin/plugin.json` is only the legacy
fallback and is not shipped):

- `name`: `picode-ask-me` (matches `PLUGIN_NAME_PATTERN`), `version` mirroring `package.json`.
- `mcpServers.app`: `{ "type": "stdio", "command": "node", "args": ["${ZCODE_PLUGIN_ROOT}/src/server.mjs"] }`.
  Host resolution facts (from `adapters/src/plugins/mcp.ts`): `ZCODE_PLUGIN_ROOT` is injected from the
  install tree, `args` are **not** resolved relative to the plugin root, and an unset `cwd` means the
  **workspace** — a bare `server.mjs` would therefore break. `cwd` is left unset; `node` comes from
  `PATH`.
- `contributions`: `{ schemaVersion: 1, entries: [{ id: "ask", kind: "ask", version: 1, server: "app" }] }`.

Verified with `picode plugins validate` on both the source tree and the extracted archive.

## Transport contract (one Pi-held stdio MCP connection)

Newline-delimited JSON-RPC 2.0 on stdin/stdout; stderr is diagnostics only.

| Direction     | Method                     | Payload / result                                                                 |
| ------------- | -------------------------- | -------------------------------------------------------------------------------- |
| host → plugin | `initialize`               | standard; server echoes the requested version when supported, else `2025-11-25`  |
| host → plugin | `notifications/initialized`| ignored                                                                          |
| host → plugin | `tools/list`, `tools/call` | standard MCP                                                                     |
| host → plugin | `picode/handshake`         | `{version:1, pluginId, sessionId, workspaceIdentity, epoch, capabilities[]}`     |
| plugin → host | handshake result           | `{version: 1, capabilities: ["ask"]}`                                            |
| plugin → host | `picode/ask` (request)     | `{questions: Question[]}` → `{answers: …}` \| `{cancelled:true}` \| JSON-RPC error |
| client → plugin | `notifications/cancelled` | aborts the in-flight tool call and abandons its ask                              |

Handshake rules (host side, `pi-host/src/native-plugin-capabilities.ts`): missing `version`,
`version !== 1`, or a non-string `capabilities` ⇒ no dynamic capability. Failure is fail-closed; the
plugin always reports `version: 1` and only the capability it can actually serve.

Request ids for `picode/ask` are deterministic: `ask-1`, `ask-2`, … (monotonic per process). They do
not collide with the host's `picode:<n>` request space or Pi's numeric client ids. Responses are
correlated by stringified id on both sides; a late/unknown id is dropped without touching later calls.
Pending asks are rejected with `transport_closed` when the connection closes, when stdin EOFs, or when
a write fails (EPIPE), so no call can hang on a dead pipe.

## Cancellation

Per MCP, the client sends `notifications/cancelled {requestId}` for an aborted `tools/call`. The
signal handed to the tool handler is passed to the `picode/ask` request, which rejects and abandons
the pending id. Because Pi's `McpClient` has already dropped that id on abort, the server sends **no
response** for the cancelled call (spec: the receiver MAY skip replying); replying would be logged by
the host as a response for an unknown request.

## Question contract (validated, never clamped)

- `questions`: 1–4 items; each needs a non-empty string `question` and 2–4 `options`.
- Two questions with the same text (case-insensitive, trimmed) are **rejected**: the host keys the
  `answers` record by question text, so duplicates would overwrite each other's answers.
- `question`, option `label`, `header`, `description` and `preview` must be strings when present;
  `multiSelect` must be a boolean when present. No `String(...)` coercion of numbers/objects.
- option `label` non-empty, unique per question (case-insensitive), not one of the host-appended
  reserved labels (`other`, `type something.`, `next`, `自己输入`).
- `header` optional, trimmed to 16 chars. `description` optional, omitted from the payload when empty.
- `preview` optional markdown mockup of that one option. Preserved for single-select; dropped for
  `multiSelect`, matching the validated old package. A preview embedding a *sibling question's* text is
  dropped as a leaked argument.
- Invalid arguments become `isError` tool results **without** a host round-trip: the model can fix
  them without bothering the user.

## Answer mapping

The host `ask` port resolves `{ answers: response.content }` and `content` already carries `answers`,
so the wire result is usually **nested**:

```json
{ "answers": { "answers": { "<question>": "<display text>" }, "answer_0": "<text|string[]>" } }
```

`src/questions.mjs` (`parseAskResponse`) accepts, in order:

1. `{cancelled: true}` → cancelled.
2. `answers` as **array** of `{question, answer, custom, selected?, preview?, notes?}` (normalized
   shape, used by structured hosts/tests).
3. nested content object (`{answers: <record|array>, answer_<i>, answer}`) → unwrapped.
4. flat record (`{answers: {"<question>": "<text>"}}`) → accepted as-is.

Per question, `answer_<i>` is read first; only when it is absent does the `answers` record (then the
legacy single-question `answer`) get used:

- **Array** `answer_<i>` (multi-select): entries are atomic host values. Entries equal to an option
  label become `selected`; every other entry is the user's custom text. The array is never re-split on
  `", "`, so `["单元", "E2E", "手写, 带逗号"]` keeps `手写, 带逗号` as one custom answer.
- **String** fallback (record join, multi-select only): leading chunks that exactly match option
  labels become `selected`, the remainder is custom — the same `", "` join the UI uses.
- Single-select answers keep the matched option's `preview`; any custom text is answered verbatim.
- Answers carry the display text the user saw, custom text included. Missing questions are omitted,
  never invented.

Tool result text:

- cancelled → `User declined to answer questions`
- answers → `User has answered your questions: "<q>"="<a>". … You can now continue with the user's answers in mind.`
  (plus `selected preview: …`, `user notes: …`, `global note: …` when present)
- accepted-but-empty → `User submitted no answers; continue with your best judgment.` (see gap below)

Errors are tool results with `isError: true`, so the model sees text it can act on: invalid params,
unknown tool, tool-call cancellation, and host failures (`plugin_capability_not_granted`,
`plugin_capability_revoked`, `plugin_capability_unsupported`, `plugin_capability_detached`, and
JSON-RPC `-32601` when no host tap answers `picode/ask`).

## Known gap: an empty submit arrives as a cancellation (no host change made)

Reproduced from source, not guessed:

1. `packages/ui/src/ElicitationDialog.tsx` — submitting nothing builds `{answers: {}}` and calls
   `onRespond(requestId, "accept", content)`.
2. `bootstrap/src/picode-protocol-v4/commands/handlers/interaction-background.ts` —
   `questionnaireContent(content)` returns `undefined` (no named and no indexed answer) and
   `askSelection` finds no value, so `action === "accept"` falls through to
   `hosted.ui.respond({ id, interactionId, confirmed: true })`.
3. `pi-host/src/extension-ui-host.ts` — `{confirmed: true}` is delivered to the waiting dialog.
4. `pi-host/src/session-registry.ts` — the ask port returns
   `"content" in response ? { answers: response.content } : { cancelled: true }`; `{confirmed: true}`
   has no `content`, so the plugin receives `{cancelled: true}`.

Consequence: the plugin renders "User declined…" for an empty submit; the accepted-but-empty wording
is unreachable through the native ask port today. Separating them needs a host change (e.g. an
explicit accept marker or an empty `content` record flowing through `resolveInteraction` into the ask
port). This package does not modify the host, and does not claim to distinguish the two.

## Packaging

`python scripts/pack.py [--out <dir>] [--base-url <url>]` builds a **deterministic** ZIP from an
explicit runtime allowlist — `.picode-plugin/plugin.json`, `package.json`, `README.md`, `src/*.mjs` —
with STORE, a fixed DOS timestamp (1980-01-01), sorted entry order, Unix 0644 and no extra fields. It
prints the SHA-256 and writes `<zip>.sha256`. Tests and the pack script are not packaged. Two runs over
the same sources produce identical bytes (covered by a test).

It also writes a local-use `dist/marketplace.json` (one plugin, `source: { source: "url", type:
"zip" }`) whose `url` is `--base-url` (default `http://127.0.0.1:8765`) plus the archive name and
whose `sha256` is the digest of the bytes just written. No digest is committed in the source tree, and
the default origin is loopback because `zip-source.ts` allows plain `http` only for loopback hosts.
Serving `dist/` on that origin (`python -m http.server 8765 --bind 127.0.0.1 --directory dist`) is the
whole local setup; README has the copyable steps.

Install/trust: PiCode accepts a plugin ZIP only from an **HTTPS** URL (plain `http` for loopback)
whose `sha256` is supplied by the marketplace entry, and only a host-verified zip install is eligible
for native capability grants. The digest proves integrity, **not** publisher identity. Grants bind the
install-tree digest, so an up/downgrade or edited tree becomes `stale_digest` and needs
re-confirmation. This repo does not upload, publish, or modify host configuration.

Failure modes that need no plugin change: with MCP disabled the server is never started; when the
`ask` grant is missing the host rejects `picode/ask` and the tool already returns an actionable
`isError` (`plugin_capability_not_granted` → ask in chat), as it does for revoked / detached /
unsupported and `-32601`.

## Acceptance

Deterministic `node --test` suites (`tests/`), all passing on Node 24.14:

- `questions.test.mjs` — schema and validation (reserved labels, duplicate options, duplicate question
  text, non-string fields, question/option limits, preview isolation), answer mapping (nested
  envelope, indexed-first, atomic multi-select arrays, comma-bearing custom text, partial answers,
  legacy `answer`, structured array, cancel vs empty), result wording.
- `rpc.test.mjs` — pending rejection on stdin EOF / sync write throw / write-callback EPIPE, id
  correlation across JSON id types, silence after cancellation, error-code passthrough.
- `server.test.mjs` — real child process over stdio: initialize echo + `instructions`, tools/list,
  handshake grant, reciprocal `picode/ask`, answer/error/cancel forwarding, invalid-argument rejection
  without a host round-trip, unknown tool, stable/unique ids, late-answer robustness, clean exit while
  an ask is pending.
- `pack.test.mjs` — byte-identical archives, sidecar digest, runtime-only allowlist, loopback
  catalogue whose digest matches the built archive.

Real Desktop/IPC end-to-end acceptance is owned by the main agent, not this package.

## Open items (genuinely unknown, not guessed)

- Desktop renderer specifics for hosted-plugin asks (preview side panel, custom row) were not exercised
  here; the wire shapes above are taken from `pi-host/src/session-registry.ts` (`ports.ask`),
  `extension-ui-host.ts` (`toAsk`) and `packages/ui/src/ElicitationDialog.tsx`.
- `picode/session/shutdown` appears in the host spec but has no sender in this checkout; the server
  does not implement it.