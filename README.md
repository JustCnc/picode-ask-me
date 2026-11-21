# picode-ask-me

Feasibility port of [`pi-ask-me`](D:/Study/Code/Node/pi-ask-me) (a Pi extension) onto **PiCode native
plugin capabilities**: one dependency-free MCP stdio server that asks the user structured
questions through the host's own question UI.

- Tool: `ask_user_question` — 1–4 questions × 2–4 options, optional `header`, option
  `description`/`preview`, `multiSelect`.
- Reverse request: `picode/ask` on the **same MCP connection** the host already holds.
- Handshake: answers `picode/handshake` with `{ version: 1, capabilities: ["ask"] }`, which is
  what makes the host enable the `ask` contribution for this connection.

No Pi `ExtensionAPI`, no TUI, no npm dependencies, no build step.

## Manifest

`.picode-plugin/plugin.json`:

```json
{
  "mcpServers": {
    "app": { "type": "stdio", "command": "node", "args": ["${ZCODE_PLUGIN_ROOT}/src/server.mjs"] }
  },
  "contributions": {
    "schemaVersion": 1,
    "entries": [{ "id": "ask", "kind": "ask", "version": 1, "server": "app" }]
  }
}
```

`args` are **not** resolved against the plugin root and `cwd` defaults to the workspace, so the
absolute `${ZCODE_PLUGIN_ROOT}/src/server.mjs` form is required; `cwd` is left unset. The server
uses whatever `node` the host resolves from `PATH`.

## How the model reaches the tool

PiCode's MCP server config defaults to `exposure: "codemode"`, so `ask_user_question` is **not** a
direct tool: the model reaches it by writing codemode that calls the MCP tool. That is the verified
access path, and the acceptance prompt below uses it explicitly.

`tool_search` may also surface the tool, but it is a separate host tool: it is only present when the
host enables it (host tool set / MCP config), and nothing in this plugin can turn it on. So the README
and SPEC claim codemode, not `tool_search`, as the guaranteed path.

To stay findable either way, `initialize` returns a short `instructions` string naming
`ask_user_question`, and the tool description tells the model to pass questions as function
parameters rather than chat text.

Failure modes already covered, no code change needed here:

- MCP disabled in the host: the server is never started, so the model just has no tool and answers in
  chat.
- Ask capability not granted: the host rejects `picode/ask`, and the tool result is an `isError` text
  that says the capability is missing and to ask in chat. Same for revoked / detached / unsupported
  and for a connection with no host tap (`-32601`).

## Answer contract

The host's `ask` port resolves `{ answers: content }`, and `content` already carries `answers`.
The wire result is normally nested:

```json
{ "answers": { "answers": { "<question>": "<display text>" }, "answer_0": "<text|string[]>" } }
```

Rules implemented in `src/questions.mjs`:

- `cancelled: true` wins over everything else.
- `answer_<i>` is authoritative; only when it is absent does the `answers` record (or the legacy
  single-question `answer`) get read.
- An **array** `answer_<i>` (multi-select) is treated as atomic values from the host: entries equal
  to an option label become `selected`, every other entry is the user's custom text. It is never
  re-split on `", "`, so a custom answer containing a comma stays one answer.
- A **string** fallback (record join) is split on `", "` only for multi-select, where the host joins
  selected labels and the custom answer with the same separator.
- Answers reference the display text, custom text included: `"q"="A, B, my own answer"`. Questions
  the user left blank are omitted; nothing is invented.
- Single-select answers keep the matched option's `preview`.

## Known gap: an empty submit arrives as a cancellation

Clicking submit with nothing selected does not reach the plugin as an empty answer set:

1. `ElicitationDialog.buildElicitationResponseContent` builds `{ answers: {} }` and calls
   `onRespond(..., "accept", content)`.
2. `picode-protocol-v4` `resolveInteraction` runs `questionnaireContent(content)`, which returns
   `undefined` for that content (no named and no indexed answer), and `askSelection` finds no value.
3. With `action === "accept"` it falls through to `hosted.ui.respond({ id, confirmed: true })`.
4. `pi-host`'s ask port returns `"content" in response ? { answers: response.content } : { cancelled: true }`,
   and `{ confirmed: true }` has no `content`, so the plugin receives `{ cancelled: true }`.

The plugin therefore renders "User declined to answer questions". Its
`User submitted no answers; continue with your best judgment.` branch exists for hosts that send an
accepted-but-empty result, but the native ask port cannot produce that shape today. Distinguishing
the two needs a host change (for example carrying an explicit accept marker, or an empty `content`
record, through `resolveInteraction` → ask port). No host code was changed here.

## Not ported (verified unavailable on the native interface)

| `pi-ask-me` surface | Status |
| --- | --- |
| `before_agent_start` prompt nudge | No prompt/system-prompt contribution kind; plugin hooks are shell commands and `UserPromptSubmit` can only block. |
| `/prompt on\|off\|once` | `command`/`prompt` kinds are manifest-valid but host-unsupported. |
| TUI widget (`ask-tui.ts`, arrow keys, notes rows) | PiCode renders questions in its own UI; no widget path for hosted plugins. |
| `ctx.hasUI`, typed `Type something.` row | Host appends its own custom row; authoring those labels stays rejected. |
| Per-question `notes` / global note | Reported by the old TUI only; the native payload has no such fields (the formatter tolerates them if a host ever sends them). |

Kept from the old package: JSON-stringified-parameter repair, reserved-label rejection, duplicate
option rejection, preview-isolation checks, and the result wording.

## Files

```
.picode-plugin/plugin.json   manifest (server key: app, contribution: ask)
src/server.mjs               MCP dispatch, tool call, picode/ask, picode/handshake
src/rpc.mjs                  newline-delimited JSON-RPC, pending correlation, cancellation, EPIPE
src/questions.mjs            schema, validation, answer mapping, result formatting
scripts/pack.py              deterministic STORE zip + SHA-256 + loopback marketplace.json (python stdlib)
tests/                       node:test — schema, mapping, transport, real stdio child process, packaging
SPEC.md                      contract, behaviour and the verified gaps
```

## Development

```bash
node --test "tests/**/*.test.mjs"    # npm test
python scripts/pack.py               # npm run pack -> dist/<zip> + .sha256 + marketplace.json
python scripts/pack.py --base-url http://127.0.0.1:8765   # same, explicit loopback origin
```

`node --test` and `python` are the only requirements. Tests spawn `node src/server.mjs` and speak
raw JSON-RPC over stdin/stdout; they need no PiCode host.

## Local install (loopback only)

`pack.py` writes `dist/marketplace.json` whose single entry points at the archive it just built, with
the SHA-256 it just computed. The URL is plain `http` on `127.0.0.1` because the host's
`zip-source.ts` accepts `http` only for loopback hosts (HTTPS is accepted anywhere); no digest is
committed in the source tree. Everything below runs on this machine; nothing is published.

```bash
# 1. build the archive and its local catalogue
npm test
npm run pack
# -> dist/picode-ask-me-0.1.0.zip, .zip.sha256, dist/marketplace.json

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

# 6. start (or reload) PiCode so the stdio server is spawned for the next session
```

If you change the port, rerun `python scripts/pack.py --base-url http://127.0.0.1:<port>` (the
catalogue URL must match the server) and re-add/reinstall. If the server is down, install and update
fail at download time; an installed plugin keeps working from its extracted tree.

Short test prompt (codemode is the default and verified path):

```text
Use the codemode tool to call the MCP tool ask_user_question and ask me two questions:
(1) review scope, (2) whether to include E2E. Then read my answers back to me.
```

The host renders the questionnaire; selecting answers and submitting returns them to the model as
`User has answered your questions: ...`.

## Install

PiCode installs a plugin ZIP from an **HTTPS** URL (plain `http` only for loopback) against the
`sha256` recorded in the marketplace entry, and only a host-verified zip install is eligible for
native capability grants. The digest proves integrity, not publisher identity. This repository does
not upload, publish or modify any host configuration.