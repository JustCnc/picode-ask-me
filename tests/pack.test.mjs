import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACK = join(ROOT, "scripts", "pack.py");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

function hasPython() {
  try {
    execFileSync("python", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const scratch = [];

function packInto(label, extraArgs = []) {
  const out = mkdtempSync(join(tmpdir(), `picode-ask-me-pack-${label}-`));
  scratch.push(out);
  const stdout = execFileSync("python", [PACK, "--out", out, ...extraArgs], { encoding: "utf8" });
  const zip = join(out, `picode-ask-me-${version}.zip`);
  const sha256 = readFileSync(`${zip}.sha256`, "utf8").trim();
  return { out, zip, stdout, sha256 };
}

after(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

describe("packaging", { skip: !hasPython() && "python is unavailable" }, () => {
  it("builds byte-identical archives with a matching sidecar digest", () => {
    const first = packInto("a");
    const second = packInto("b");
    assert.ok(existsSync(first.zip));
    assert.equal(first.sha256.split(/\s+/)[0], second.sha256.split(/\s+/)[0]);
    assert.equal(readFileSync(first.zip).subarray(0, 2).toString(), "PK");
    assert.match(first.stdout, /sha256: [0-9a-f]{64}/);
  });

  it("does not package tests or the packing script", () => {
    const { zip, out } = packInto("c");
    // 运行时允许清单之外的东西不能进包：用同一份 Python 标准库读回条目名。
    const listing = execFileSync(
      "python",
      [
        "-c",
        "import sys, zipfile; print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))",
        zip,
      ],
      { encoding: "utf8" },
    )
      .trim()
      .split(/\r?\n/);
    assert.deepEqual(listing, [
      ".picode-plugin/plugin.json",
      "package.json",
      "README.md",
      "src/questions.mjs",
      "src/rpc.mjs",
      "src/server.mjs",
    ]);
    assert.ok(existsSync(join(out, `picode-ask-me-${version}.zip`)));
  });

  it("writes a loopback catalogue whose digest matches the archive", () => {
    const { out, zip, sha256, stdout } = packInto("d", [
      "--base-url",
      "http://127.0.0.1:9999/",
    ]);
    const catalogue = JSON.parse(readFileSync(join(out, "marketplace.json"), "utf8"));
    assert.equal(catalogue.name, "picode-ask-me-local");
    assert.equal(catalogue.plugins.length, 1);
    const [entry] = catalogue.plugins;
    assert.equal(entry.name, "picode-ask-me");
    assert.equal(entry.version, version);
    assert.deepEqual(entry.source, {
      source: "url",
      type: "zip",
      url: `http://127.0.0.1:9999/picode-ask-me-${version}.zip`,
      sha256: sha256.split(/\s+/)[0],
    });
    // 目录里的摘要必须来自刚构建的字节，不能是源码里写死的值。
    const builtDigest = createHash("sha256").update(readFileSync(zip)).digest("hex");
    assert.equal(entry.source.sha256, builtDigest);
    assert.match(stdout, /catalogue: /);
  });
});