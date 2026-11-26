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
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.contributions.schemaVersion, 1);
    assert.equal(manifest.contributions.entries.length, 1);
    assert.equal(entry.id, "ask");
    assert.equal(entry.kind, "ask");
    assert.equal(entry.version, 2);
    assert.equal(entry.entry, "src/native.mjs");
    assert.equal(entry.server, undefined);
  });

  it("declares the localized metadata the settings list reads", () => {
    // pi-host reads displayName / displayNameI18n / descriptionI18n off the manifest.
    assert.equal(typeof manifest.displayName, "string");
    assert.ok(manifest.displayName.trim().length > 0);
    for (const key of ["displayNameI18n", "descriptionI18n"]) {
      const map = manifest[key];
      assert.deepEqual(Object.keys(map).sort(), ["en-US", "zh-CN"]);
      for (const value of Object.values(map)) {
        assert.equal(typeof value, "string");
        assert.ok(value.trim().length > 0);
      }
    }
    assert.equal(manifest.descriptionI18n["en-US"], manifest.description);
  });

  it("does not ship an MCP server", () => {
    // ask v2 永不走 MCP 兼容链路：清单里不该再有 server 声明。
    assert.equal(manifest.mcpServers, undefined);
    assert.equal(JSON.stringify(manifest).includes("mcpServers"), false);
  });

  it("keeps the entry inside the packaged plugin root", () => {
    assert.match(entry.entry, /^src\/[A-Za-z0-9_.-]+\.mjs$/);
    assert.ok(existsSync(join(ROOT, entry.entry)));
  });

  it("advertises the same tool name, description and schema the runtime uses", () => {
    assert.equal(entry.tool.name, ASK_TOOL_NAME);
    assert.equal(entry.tool.description, ASK_TOOL_DESCRIPTION);
    assert.deepEqual(entry.tool.inputSchema, ASK_INPUT_SCHEMA);
  });
});