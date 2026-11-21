import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ASK_INPUT_SCHEMA, ASK_TOOL_DESCRIPTION, ASK_TOOL_NAME } from "../src/questions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, ".picode-plugin/plugin.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const [entry] = manifest.contributions?.entries ?? [];

describe("manifest", () => {
  it("declares the ask v2 entry as its sole contribution", () => {
    assert.equal(manifest.name, pkg.name);
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.version, "0.2.0");
    assert.equal(manifest.contributions.schemaVersion, 1);
    assert.equal(manifest.contributions.entries.length, 1);
    assert.equal(entry.id, "ask");
    assert.equal(entry.kind, "ask");
    assert.equal(entry.version, 2);
    assert.equal(entry.entry, "src/native.mjs");
    assert.equal(entry.server, undefined);
  });

  it("does not ship an MCP server", () => {
    // ask v2 永不走 MCP 兼容链路：清单里不该再有 server 声明。
    assert.equal(manifest.mcpServers, undefined);
    assert.equal(JSON.stringify(manifest).includes("mcpServers"), false);
  });

  it("keeps the entry inside the packaged plugin root", () => {
    assert.doesNotMatch(entry.entry, /^[/\\]|\.\./);
    assert.match(entry.entry, /^src\/[A-Za-z0-9_.-]+\.mjs$/);
    assert.ok(existsSync(join(ROOT, entry.entry)));
  });

  it("advertises the same tool name, description and schema the runtime uses", () => {
    assert.equal(entry.tool.name, ASK_TOOL_NAME);
    assert.equal(entry.tool.description, ASK_TOOL_DESCRIPTION);
    assert.deepEqual(entry.tool.inputSchema, ASK_INPUT_SCHEMA);
  });
});