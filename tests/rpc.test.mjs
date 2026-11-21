import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { describe, it } from "node:test";
import { createStdioPeer } from "../src/rpc.mjs";

function sink(captured = []) {
  return new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) captured.push(JSON.parse(line));
      }
      callback();
    },
  });
}

function peerWith(onRequest, options = {}) {
  const input = options.input ?? new PassThrough();
  const output = options.output ?? sink(options.captured);
  const peer = createStdioPeer({
    input,
    output,
    log: () => {},
    onRequest,
    onClose: options.onClose,
    allocateId: options.allocateId,
  });
  return { input, output, peer };
}

/** Send a JSON-RPC message on the fake stdin, then yield the event loop once. */
function deliver(input, message) {
  input.write(`${JSON.stringify(message)}\n`);
  return new Promise((resolve) => setImmediate(resolve));
}

describe("stdio peer", () => {
  it("rejects pending requests on stdin EOF instead of hanging", async () => {
    const { input, peer } = peerWith(async () => ({}));
    const { id, promise } = peer.request("picode/ask", { questions: [] });
    assert.equal(id, "request-1");
    input.end();
    await assert.rejects(promise, (error) => error.code === "transport_closed");
    assert.equal(peer.closed, true);
  });

  it("rejects pending requests when a write throws EPIPE", async () => {
    const output = {
      write() {
        throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      },
      on() {},
    };
    let closedReason;
    const { peer } = peerWith(async () => ({}), {
      output,
      onClose: (reason) => {
        closedReason = reason;
      },
    });
    await assert.rejects(
      peer.request("picode/ask", {}).promise,
      (error) => error.code === "transport_closed",
    );
    assert.equal(peer.closed, true);
    assert.match(closedReason, /EPIPE/);
  });

  it("rejects pending requests when the write callback reports EPIPE", async () => {
    const output = {
      write(_line, callback) {
        callback(Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
      },
      on() {},
    };
    const { peer } = peerWith(async () => ({}), { output });
    await assert.rejects(
      peer.request("picode/ask", {}).promise,
      (error) => error.code === "transport_closed",
    );
  });

  it("correlates responses by id regardless of the id's JSON type", async () => {
    const { input, peer } = peerWith(async () => ({}));
    const { promise } = peer.request("picode/ask", {}, { id: 7 });
    await deliver(input, { id: "7", jsonrpc: "2.0", result: { ok: true } });
    assert.deepEqual(await promise, { ok: true });
    // 未知 id 只记录，不影响后续请求。
    await deliver(input, { id: "nobody", jsonrpc: "2.0", result: {} });
    assert.equal(peer.closed, false);
  });

  it("aborts an inbound request on notifications/cancelled and stays silent", async () => {
    const captured = [];
    const { input } = peerWith(
      async (_method, _params, { signal }) => {
        assert.equal(signal.aborted, false);
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
      { captured },
    );
    await deliver(input, { id: 11, jsonrpc: "2.0", method: "tools/call", params: {} });
    await deliver(input, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 11 },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 客户端已经丢弃该 id，再回一条应答会被记成 unknown request。
    assert.deepEqual(captured, []);
  });

  it("answers a failing inbound request with the handler's own code", async () => {
    const captured = [];
    const { input } = peerWith(async () => {
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    }, { captured });
    await deliver(input, { id: 3, jsonrpc: "2.0", method: "nope" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(captured, [
      { jsonrpc: "2.0", id: 3, error: { code: -32601, message: "Method not found" } },
    ]);
  });
});