# picode-ask-me

Port of `pi-ask-me` (a Pi extension) onto **PiCode's native plugin Host API**: one dependency-free
Node entry that asks the user structured questions through the host's own question UI.

- Contribution: `ask` version 2, tool `ask_user_question` — 1–4 questions × 2–4 options, optional
  `header`, option `description`/`preview`, `multiSelect`.
- Transport: the host spawns `src/native.mjs` **per invocation** and speaks private
  newline-delimited JSON (JSONL) on stdin/stdout: `invoke` → `ask` → `answer` → `result`/`error`.
- Metadata: `displayName` / `displayNameI18n` / `descriptionI18n` (en-US, zh-CN) so the settings
  list localizes the plugin the same way the host does.
- No MCP server, no JSON-RPC, no handshake, no `mcpServers`, no Pi `ExtensionAPI`, no TUI, no npm
  dependencies, no build step, no timers while waiting for the user.
- Host contracts in the PiCode checkout: `docs/picode-native-plugin-capabilities.md` (current
  platform guide) and `docs/specs/picode-native-plugin-host-api.md` (ask v2 runtime). Local
  contract: [`SPEC.md`](SPEC.md).

## Manifest

`.picode-plugin/plugin.json`:

```json
{
  "name": "picode-ask-me",
  "version": "0.3.0",
  "displayName": "Ask Me",
  "displayNameI18n": { "en-US": "Ask Me", "zh-CN": "结构化提问" },
  "descriptionI18n": { "en-US": "…", "zh-CN": "…" },
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
published without running the plugin: the host registers it straight into the Pi session (`label` =
tool name, `parameters` = `inputSchema`), so what the model sees — and whatever argument validation
the Pi tool layer performs — comes from this static object, not from the code in `src/`. The
runtime re-validates anyway, because a schema alone cannot catch a JSON-stringified parameter.
`tool.description` / `tool.inputSchema` are duplicated from `src/questions.mjs` because the manifest
is static JSON; a test fails if they drift.

The localized metadata is read by `pi-host`/settings (`createPluginMetadata` in
`adapters/src/plugins/index.ts`): `displayName`, `displayNameI18n` and `descriptionI18n` decide how
the plugin is listed, not how it runs.

`0.1.0` was the ask v1 feasibility package (MCP stdio server + `picode/handshake`). It is not
compatible with this layout: v2 never falls back to MCP.

## Runtime protocol

One child process per tool call; stdout is protocol-only, stderr is diagnostics.

```text
host → plugin   {"type":"invoke","version":1,"args":{"questions":[…]}}   (+ host fields, see below)
plugin → host   {"type":"ask","questions":[…]}                       (normalized, at most one)
host → plugin   {"type":"answer","result":{"cancelled":true}}        | {"answers":…}
plugin → host   {"type":"result","text":"…"}                          | {"type":"error","message":"…"}
```

- The host may spread its trusted session context onto the invoke frame (`sessionId`,
  `workspaceDir`, and anything it adds later). Those fields are ignored: an ask plugin consumes
  `version` and `args` only and never claims an identity.
- The host allows one `ask` frame per invocation, then answers once. A second `ask` from the plugin
  is a protocol error on the host side, so this runtime never asks twice.

- `invoke.version` other than `1` → a single `error` message, no question.
- Invalid arguments → a single `error` message (already prefixed `Error: …`), no question: the model
  can fix them without bothering the user.
- Malformed JSON lines and unknown message types are logged to stderr and dropped.
- An `answer` with no pending question is logged and dropped.
- After `result`/`error` the child stops reading stdin and exits 0. If the host closes stdin or stops
  the child while a question is pending, the child exits without inventing an answer.
- **No timers:** waiting for the user has no deadline. Cancellation, revocation, session stop and the
  pending interaction are host-owned; the plugin sets no timeout and retries nothing. The host still
  bounds the non-interactive phases (30 s startup until `ask`/`result`, 30 s after `answer`) and
  SIGKILLs the child on abort, a revoked grant or a dead pipe.

## Question ceilings

The host re-validates the `ask` payload (`isQuestionnaire` in
`pi-host/src/native-plugin-tool-host.ts`) and answers the tool with a bare
`Invalid questions from native plugin` when it does not fit. The plugin therefore enforces the same
ceilings first, as fixable `Error: …` messages instead of a host-side failure:

| Field                | Host ceiling   | Advertised by the tool schema |
| -------------------- | -------------- | ----------------------------- |
| `question`           | 4000 chars     | 4000                          |
| `header`             | 64 chars       | 16 (chip width, trimmed)      |
| option `label`       | 200 chars      | 60 (guidance)                 |
| option `description` | 4000 chars     | 4000                          |
| option `preview`     | 16000 chars    | 16000                         |
| questions / options  | 4 / 4          | 4 / 4                         |
| whole `ask` frame    | 1 MiB (bytes)  | — (runtime budget 1,000,000 B) |

Lengths are counted the way the host counts them (UTF-16 units), while the frame budget is bytes,
so a questionnaire that maxes out every CJK preview can pass each field and still exceed one frame.
`header` is the only field that is trimmed instead of rejected: it is a chip label, and trimming
happens per code point so an emoji is never cut in half.

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
scripts/pack.py              deterministic STORE zip + SHA-256 (+ opt-in loopback marketplace.json)
tests/                       node:test — schema/mapping, manifest, real JSONL child, packaging
SPEC.md                      contract, behaviour and open items
mise.toml                    pinned Node 24.14.0 (same pin as PiCode)
```

## Development

```bash
node --test "tests/**/*.test.mjs"    # npm test
python scripts/pack.py               # npm run pack -> dist/<zip> + .zip.sha256
python scripts/pack.py --marketplace --base-url http://127.0.0.1:8765   # + loopback catalogue
```

Pinned Node: `24.14.0` (`mise.toml`, `engines: >=24.14.0 <25`; PiCode uses the same pin). The tests
spawn `node src/native.mjs` and speak raw JSONL over stdin/stdout; they need no PiCode host and no
network.

## Local install (no HTTP)

Current PiCode imports a local plugin directly — Desktop's “install from local” picker (ZIP or
directory) and `picode plugins install-local <path>`. Nothing is fetched, so no server, no
catalogue and no digest hand-off are involved; the host copies the tree, hashes it and imports it
as `<name>@picode-local` in this Host's user inventory.

```bash
# 1. build the archive
npm test
npm run pack
# -> dist/picode-ask-me-0.3.0.zip, dist/picode-ask-me-0.3.0.zip.sha256

# 2. import it (either form works)
picode plugins install-local dist/picode-ask-me-0.3.0.zip
# picode plugins install-local .          # straight from the checkout directory

# 3. enable, then grant the ask capability
picode plugins enable picode-ask-me@picode-local
#    Desktop: Settings -> Plugins -> picode-ask-me -> capability "ask" -> Grant
#    Installing or enabling never implies a grant; a re-import with new content needs a fresh one.

# 4. start (or reload) PiCode so the host registers the tool for the next session
```

Grant state binds the install-tree digest, so re-importing changed sources downgrades the grant to
“pending review” rather than silently reusing it.

## Optional: loopback catalogue (marketplace path)

If you want the marketplace listing flow instead of a local import, `pack.py --marketplace` also
writes `dist/marketplace.json` with one entry pointing at the archive it just built and the SHA-256
it just computed. Its URL is plain `http` on `127.0.0.1` because the host's `zip-source.ts` accepts
`http` only for loopback hosts (HTTPS is accepted anywhere); no digest is committed in the source
tree.

```bash
python scripts/pack.py --marketplace --base-url http://127.0.0.1:8765
python -m http.server 8765 --bind 127.0.0.1 --directory dist   # serve ONLY dist/
picode plugins marketplace add http://127.0.0.1:8765/marketplace.json
picode plugins install picode-ask-me@picode-ask-me-local
```

If the server is down, install and update fail at download time; an installed plugin keeps working
from its extracted tree.

Short test prompt:

```text
Ask me two questions with ask_user_question: (1) review scope, (2) whether to include E2E.
Then read my answers back to me.
```

The host renders the questionnaire; selecting answers and submitting returns them to the model as
`User has answered your questions: ...`.

## Install sources

Two host-verified paths exist, and both are eligible for native capability grants: a local ZIP or
directory (`install-local`), and a ZIP fetched from a marketplace entry over **HTTPS** (plain `http`
only for loopback) against that entry's `sha256`. Digests prove integrity, not publisher identity.
This repository does not upload, publish or modify any host configuration.