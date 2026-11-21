# picode-ask-me

Port of [`pi-ask-me`](D:/Study/Code/Node/pi-ask-me) (a Pi extension) onto **PiCode's native plugin
Host API**: one dependency-free Node entry that asks the user structured questions through the
host's own question UI.

- Contribution: `ask` version 2, tool `ask_user_question` — 1–4 questions × 2–4 options, optional
  `header`, option `description`/`preview`, `multiSelect`.
- Transport: the host spawns `src/native.mjs` **per invocation** and speaks private
  newline-delimited JSON (JSONL) on stdin/stdout: `invoke` → `ask` → `answer` → `result`/`error`.
- No MCP server, no JSON-RPC, no handshake, no `mcpServers`, no Pi `ExtensionAPI`, no TUI, no npm
  dependencies, no build step, no timers while waiting for the user.
- Host contract: `docs/specs/picode-native-plugin-host-api.md` in PiCode. Local contract:
  [`SPEC.md`](SPEC.md).

## Manifest

`.picode-plugin/plugin.json`:

```json
{
  "contributions": {
    "schemaVersion": 1,
    "entries": [
      {
        "id": "ask",
        "kind": "ask",
        "version": 2,
        "entry": "src/native.mjs",
        "tool": { "name": "ask_user_question", "description": "…", "inputSchema": { "…": "…" } }
      }
    ]
  }
}
```

That ask v2 entry is the only contribution; there is no `mcpServers` block and no `server` field.
`entry` is resolved inside the plugin root by the host and exports `main()`. `tool` is the catalog
published without running the plugin. `tool.description` / `tool.inputSchema` are duplicated from
`src/questions.mjs` because the manifest is static JSON; a test fails if they drift.

`0.1.0` was the ask v1 feasibility package (MCP stdio server + `picode/handshake`). It is not
compatible with this layout: v2 never falls back to MCP.

## Runtime protocol

One child process per tool call; stdout is protocol-only, stderr is diagnostics.

```text
host → plugin   {"type":"invoke","version":1,"args":{"questions":[…]}}
plugin → host   {"type":"ask","questions":[…]}                       (normalized, at most one)
host → plugin   {"type":"answer","result":{"cancelled":true}}        | {"answers":…}
plugin → host   {"type":"result","text":"…"}                          | {"type":"error","message":"…"}
```

- `invoke.version` other than `1` → a single `error` message, no question.
- Invalid arguments → a single `error` message (already prefixed `Error: …`), no question: the model
  can fix them without bothering the user.
- Malformed JSON lines and unknown message types are logged to stderr and dropped.
- An `answer` with no pending question is logged and dropped.
- After `result`/`error` the child stops reading stdin and exits 0. If the host closes stdin or stops
  the child while a question is pending, the child exits without inventing an answer.
- **No timers:** waiting for the user has no deadline. Cancellation, revocation, session stop and the
  pending interaction are host-owned; the plugin sets no timeout and retries nothing.

## Answer contract

`answer.result` is the host ask result, normally the nested content object:

```json
{ "answers": { "answers": { "<question>": "<display text>" }, "answer_0": "<text|string[]>" } }
```

Rules implemented in `src/questions.mjs`:

- `cancelled: true` wins over everything else.
- `answer_<i>` is authoritative; only when it is absent does the `answers` record (or the legacy
  single-question `answer`) get read.
- An **array** `answer_<i>` (multi-select) is treated as atomic values: entries equal to an option
  label become `selected`, every other entry is the user's custom text. It is never re-split on
  `", "`, so a custom answer containing a comma stays one answer.
- A **string** fallback (record join) is split on `", "` only for multi-select, where the host joins
  selected labels and the custom answer with the same separator.
- Answers reference the display text, custom text included: `"q"="A, B, my own answer"`. Questions
  the user left blank are omitted; nothing is invented.
- Single-select answers keep the matched option's `preview`.

An empty submission carries an empty answer set ("User submitted no answers…"); an explicit
cancellation carries `{cancelled:true}` ("User declined…"). The plugin does not guess answers.

## Kept from the old package

JSON-stringified-parameter repair, reserved-label rejection, duplicate option/question rejection,
question and option limits, string-only fields, preview isolation, multi-select atomic answers, and
the result wording.

## Files

```
.picode-plugin/plugin.json   manifest (sole contribution: ask v2 → src/native.mjs)
src/native.mjs               JSONL runtime: invoke → ask → answer → result/error
src/questions.mjs            schema, validation, answer mapping, result formatting
scripts/pack.py              deterministic STORE zip + SHA-256 + loopback marketplace.json (python stdlib)
tests/                       node:test — schema/mapping, manifest, real JSONL child, packaging
SPEC.md                      contract, behaviour and open items
mise.toml                    pinned Node 24.14.0 (same pin as PiCode)
```

## Development

```bash
node --test "tests/**/*.test.mjs"    # npm test
python scripts/pack.py               # npm run pack -> dist/<zip> + .sha256 + marketplace.json
python scripts/pack.py --base-url http://127.0.0.1:8765   # same, explicit loopback origin
```

Pinned Node: `24.14.0` (`mise.toml`, `engines: >=24.14.0 <25`; PiCode uses the same pin). The tests
spawn `node src/native.mjs` and speak raw JSONL over stdin/stdout; they need no PiCode host and no
network.

## Local install (loopback only)

`pack.py` writes `dist/marketplace.json` whose single entry points at the archive it just built, with
the SHA-256 it just computed. The URL is plain `http` on `127.0.0.1` because the host's
`zip-source.ts` accepts `http` only for loopback hosts (HTTPS is accepted anywhere); no digest is
committed in the source tree. Everything below runs on this machine; nothing is published.

```bash
# 1. build the archive and its local catalogue
npm test
npm run pack
# -> dist/picode-ask-me-0.2.0.zip, .zip.sha256, dist/marketplace.json

# 2. serve ONLY dist/, bound to loopback (keep this terminal open)
python -m http.server 8765 --bind 127.0.0.1 --directory dist

# 3. add the local catalogue source (new terminal, same repo root)
picode plugins marketplace add http://127.0.0.1:8765/marketplace.json
picode plugins list --available        # picode-ask-me@picode-ask-me-local should be listed

# 4. install and enable
picode plugins install picode-ask-me@picode-ask-me-local
picode plugins enable picode-ask-me@picode-ask-me-local

# 5. authorize the ask capability
#    Desktop: Settings -> Plugins -> picode-ask-me -> capability "ask" -> Grant
#    Installing or enabling never implies a grant; an update needs a fresh confirmation.

# 6. start (or reload) PiCode so the host invokes src/native.mjs for the next session
```

If you change the port, rerun `python scripts/pack.py --base-url http://127.0.0.1:<port>` (the
catalogue URL must match the server) and re-add/reinstall. If the server is down, install and update
fail at download time; an installed plugin keeps working from its extracted tree.

Short test prompt:

```text
Ask me two questions with ask_user_question: (1) review scope, (2) whether to include E2E.
Then read my answers back to me.
```

The host renders the questionnaire; selecting answers and submitting returns them to the model as
`User has answered your questions: ...`.

## Install

PiCode installs a plugin ZIP from an **HTTPS** URL (plain `http` only for loopback) against the
`sha256` recorded in the marketplace entry, and only a host-verified zip install is eligible for
native capability grants. The digest proves integrity, not publisher identity. This repository does
not upload, publish or modify any host configuration.