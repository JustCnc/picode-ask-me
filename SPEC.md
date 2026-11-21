# picode-ask-me — SPEC (ask v2, PiCode native Host API)

Port of [`pi-ask-me`](D:/Study/Code/Node/pi-ask-me) (a Pi extension) onto PiCode's **native plugin
Host API**, `ask` contribution version 2. Contract owner on the host side:
`docs/specs/picode-native-plugin-host-api.md` in PiCode. The old package is the behavioural
reference only.

## Goal

A dependency-free Node ESM entry (`src/native.mjs`) that the PiCode host spawns **per tool
invocation** and drives over private newline-delimited JSON (JSONL) on stdin/stdout:

1. the host sends the `ask_user_question` tool arguments;
2. the plugin validates and normalizes them, and sends the questionnaire to the host;
3. the host answers with the user's choice (or a cancellation);
4. the plugin returns the tool-result text, or a tool error.

No MCP server, no JSON-RPC, no Pi `ExtensionAPI`, no TUI, no dependencies, no build step, no timers.

## Non-goals / verified-unavailable (old behaviour intentionally dropped)

| Old surface                                       | Status in this package                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP stdio server, `picode/handshake`, `picode/ask` reverse request | **Removed.** `ask` v2 never falls back to MCP; the manifest declares no `mcpServers`. The host owns transport, permissions and session identity. |
| `before_agent_start` system-prompt nudge          | Unavailable: no prompt/system-prompt contribution kind; plugin hooks are shell commands and `UserPromptSubmit` can only block.                |
| `/prompt on\|off\|once` command                   | Unavailable: `command`/`prompt` kinds are manifest-valid but host-unsupported.                                                                |
| TUI widget (`ask-tui.ts`, arrow keys, notes rows) | PiCode renders questions in its own UI; hosted plugins get no widget/TUI surface.                                                             |
| `ctx.hasUI`, typed `Type something.` row          | Host appends its own custom row; authoring those labels stays rejected.                                                                       |
| Per-question `notes`, global note                 | The ask payload has no such fields. `parseAskResponse` still tolerates them and `formatAskResult` still renders them if a host sends them.     |

Ambiguity guidance lives in the tool `description` only. No skill contribution is shipped: a skill
cannot nudge a turn, and declaring one would imply an effect it does not have.

## Manifest

`.picode-plugin/plugin.json` (preferred path; `.zcode-plugin/plugin.json` is not shipped):

```json
{
  "name": "picode-ask-me",
  "version": "0.2.0",
  "contributions": {
    "schemaVersion": 1,
    "entries": [
      {
        "id": "ask",
        "kind": "ask",
        "version": 2,
        "entry": "src/native.mjs",
        "tool": {
          "name": "ask_user_question",
          "description": "<same string as ASK_TOOL_DESCRIPTION>",
          "inputSchema": { "...": "same object as ASK_INPUT_SCHEMA" }
        }
      }
    ]
  }
}
```

- The sole contribution is the ask v2 entry; there is no `mcpServers` block and no `server` field.
  v2 entries never resolve to an MCP connection.
- `entry` is a `.mjs` path inside the plugin root. The host resolves it against the install tree; the
  plugin does not choose its own cwd.
- `tool.description` / `tool.inputSchema` are the host-visible tool catalog. They are static JSON
  (the host must not run the plugin to know the tool), and duplicate `ASK_TOOL_DESCRIPTION` /
  `ASK_INPUT_SCHEMA` from `src/questions.mjs`. A test asserts the four fields stay identical, so the
  runtime validator and the advertised schema cannot drift.
- `name`/`version` mirror `package.json`. `version` is `0.2.0`.
- Install/enable/uninstall, the install-tree digest, the `ask` capability grant, revocation,
  re-grant after re-import, and the ask UI itself stay host-owned. The plugin only checks that the
  message it receives is a well-formed `invoke` for protocol version 1.

## Transport contract (one child process per invocation)

Newline-delimited JSON, one JSON object per line. stdout carries protocol lines only; stderr carries
diagnostics (`[picode-ask-me] …`) and is never parsed by the host.

| Direction     | Message                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- |
| host → plugin | `{"type":"invoke","version":1,"args":{"questions":[…]}}`                                    |
| plugin → host | `{"type":"ask","questions":[…]}` (normalized questions, at most one per invoke)              |
| host → plugin | `{"type":"answer","result":{…}}` where `result` is `{"cancelled":true}` or `{"answers":…}`   |
| plugin → host | `{"type":"result","text":"…"}` or `{"type":"error","message":"…"}`                          |

Rules:

- Protocol `version` is `1`. Any other value (or a missing one) is answered with a single
  `{"type":"error"}` naming the version this runtime speaks; no questionnaire is sent.
- Exactly one `ask` per `invoke`. The plugin never asks twice, never asks for a second question
  batch, and never sends an unsolicited message.
- Malformed JSON lines and unknown message `type`s are logged to stderr and dropped. A dropped line
  does not end the invocation.
- An `answer` with no pending question is dropped (logged), never turned into a result.
- After the terminal `result`/`error` the runtime stops reading stdin and lets the process exit
  normally (code 0), so the host sees one invocation per child. Pending stdout writes are flushed
  before exit; no `process.exit()` truncates the last line.
- If the host closes stdin (or kills the child) while a question is pending, the runtime exits
  without inventing an answer. Cancellation is host-owned: the host stops the child, clears its
  pending interaction and records the cancellation.
- **No timers.** Waiting for the user has no wall-clock deadline. The plugin sets no timeout, no
  heartbeat and no retry; the host still owns bounded budgets for the non-interactive phases
  (startup, pre-submit, post-answer).
- The plugin never claims a plugin id, session id or workspace; identity and routing come from the
  host binding, not from this protocol.

## Question contract (validated, never clamped)

- `questions`: 1–4 items; each needs a non-empty string `question` and 2–4 `options`.
- Two questions with the same text (case-insensitive, trimmed) are rejected: the host keys the
  `answers` record by question text, so duplicates would overwrite each other's answers.
- `question`, option `label`, `header`, `description` and `preview` must be strings when present;
  `multiSelect` must be a boolean when present. No `String(...)` coercion of numbers/objects.
- A JSON-stringified `questions` / `options` parameter is repaired (GLM-class models do this); a
  prose blob is rejected rather than guessed.
- option `label` non-empty, unique per question (case-insensitive), not one of the host-appended
  reserved labels (`other`, `type something.`, `next`, `自己输入`).
- `header` optional, trimmed to 16 chars. `description` optional, omitted from the payload when empty.
- `preview` optional markdown mockup of that one option. Preserved for single-select; dropped for
  `multiSelect`. A preview embedding a sibling question's text is dropped as a leaked argument.
- Invalid arguments become a single `{"type":"error","message":"Error: …"}` **without** an `ask`
  round-trip: the model can fix them without bothering the user.

## Answer mapping

`{"type":"answer","result":…}` carries the host ask result. `parseAskResponse` accepts, in order:

1. `{cancelled: true}` → cancelled.
2. `answers` as an array of `{question, answer, custom, selected?, preview?, notes?}`.
3. a nested content object (`{answers: <record|array>, answer_<i>, answer}`) → unwrapped.
4. a flat record (`{answers: {"<question>": "<text>"}}`).

Per question, `answer_<i>` is read first; only when it is absent does the `answers` record (then the
legacy single-question `answer`) get used:

- **Array** `answer_<i>` (multi-select): entries are atomic host values. Entries equal to an option
  label become `selected`; every other entry is the user's custom text. The array is never re-split
  on `", "`, so `["单元", "E2E", "手写, 带逗号"]` keeps `手写, 带逗号` as one custom answer.
- **String** fallback (record join, multi-select only): leading chunks that exactly match option
  labels become `selected`, the remainder is custom — the same `", "` join the UI uses.
- Single-select answers keep the matched option's `preview`; any custom text is answered verbatim.
- Answers carry the display text the user saw, custom text included. Unanswered questions are
  omitted, never invented.

Tool result text (`{"type":"result","text":…}`):

- cancelled → `User declined to answer questions`
- answers → `User has answered your questions: "<q>"="<a>". … You can now continue with the user's answers in mind.`
  (plus `selected preview: …`, `user notes: …`, `global note: …` when present)
- accepted-but-empty → `User submitted no answers; continue with your best judgment.`

Whether an empty submit reaches the plugin as `{answers:{}}` (accepted-empty) or `{cancelled:true}`
is decided by the host's interaction projection; this package renders whichever it receives and
claims neither.

## Packaging

`python scripts/pack.py [--out <dir>] [--base-url <url>]` builds a **deterministic, offline** ZIP
from an explicit runtime allowlist — `.picode-plugin/plugin.json`, `package.json`, `README.md`,
`src/native.mjs`, `src/questions.mjs` — with STORE (no compression), a fixed DOS timestamp
(1980-01-01), fixed order, Unix 0644 and no extra fields. No network, no install step, no
`node_modules`. It prints the SHA-256 and writes `<zip>.sha256`. Tests and the pack script are not
packaged. Two runs over the same sources produce identical bytes (covered by a test).

It also writes a local-use `dist/marketplace.json` (one plugin, `source: {source: "url", type:
"zip"}`) whose `url` is `--base-url` (default `http://127.0.0.1:8765`) plus the archive name and whose
`sha256` is the digest of the bytes just written. No digest is committed in the source tree, and the
default origin is loopback because `zip-source.ts` allows plain `http` only for loopback hosts.

Install/trust: PiCode accepts a plugin ZIP only from an **HTTPS** URL (plain `http` for loopback)
whose `sha256` is supplied by the marketplace entry, and only a host-verified zip install is eligible
for native capability grants. The digest proves integrity, **not** publisher identity. Grants bind
the install-tree digest, so an up/downgrade or edited tree becomes `stale_digest` and needs
re-confirmation. This repo does not upload, publish, or modify host configuration.

Failure modes that need no plugin change:

- no `ask` grant / revoked / stale digest / invalid entry → the host does not invoke the entry, so
  the model simply has no tool and asks in chat;
- the child exits or the host stops it → the pending interaction is cleared by the host;
- an older host that only understands ask v1 (`server` + MCP) does not load this package: v2 never
  falls back. Install `0.1.0` for a v1-only host.

## Tests

Deterministic `node --test` suites (`tests/`):

- `questions.test.mjs` — schema and validation (reserved labels, duplicate options, duplicate
  question text, non-string fields, question/option limits, preview isolation), answer mapping
  (nested envelope, indexed-first, atomic multi-select arrays, comma-bearing custom text, partial
  answers, legacy `answer`, structured array, cancel vs empty), result wording.
- `manifest.test.mjs` — sole ask v2 contribution, no `mcpServers`/`server`, entry exists inside the
  plugin root, manifest tool description/schema identical to `src/questions.mjs`, versions aligned.
- `native.test.mjs` — real child process over JSONL: invoke → ask → answer → result; multi-select
  atomic answers; cancellation wording; invalid arguments rejected without an ask; unsupported
  invoke version; malformed/unknown lines dropped; an answer with nothing pending ignored; a long
  wait (no timer) still answered; natural exit 0 after the terminal message; clean exit 0 when the host
  closes stdin with a question pending.
- `pack.test.mjs` — byte-identical archives, sidecar digest, runtime-only allowlist, loopback
  catalogue whose digest matches the built archive.

Node is pinned to `24.14.0` (see `mise.toml`, same pin as PiCode), `engines` requires
`>=24.14.0 <25`. `node --test` and `python` are the only requirements; the tests never contact a
PiCode host and never install anything.

## Open items (genuinely unknown, not guessed)

- The host-side v2 implementation (spawn, permission re-check, answer projection) is not in this
  package. The wire shapes above are the published Host API contract; a host that deviates must be
  reconciled on the host side, not papered over with plugin fallbacks.
- Desktop/phone UI specifics for the questionnaire (preview side panel, custom row) are host-owned
  and not exercised here.