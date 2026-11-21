/**
 * Newline-delimited JSON-RPC 2.0 over a pair of streams (Pi's stdio MCP transport).
 *
 * Kept deliberately small: it owns framing, pending requests, inbound request
 * dispatch and `notifications/cancelled`. MCP semantics live in server.mjs.
 *
 * Failure model: 写入失败（EPIPE/EPIPE 类断管）与输入 EOF 走同一条收口路径 —
 * 先标记关闭，再拒绝所有待答请求，最后交给 `onClose` 退出进程。否则插件会在
 * 宿主已经断开的情况下永久等待一个永远不会到的应答。
 */
import { createInterface } from "node:readline";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcFailure(error) {
  const failure = new Error(typeof error?.message === "string" ? error.message : "JSON-RPC error");
  failure.code = typeof error?.code === "number" ? error.code : -32603;
  if (isRecord(error?.data) && typeof error.data.code === "string") {
    failure.dataCode = error.data.code;
  }
  return failure;
}

/** 两端都用字符串键：数字 id 与字符串 id 不会因为 Map 键类型不同而错配。 */
function keyOf(id) {
  return String(id);
}

export function createStdioPeer(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? (() => {});
  const onRequest = options.onRequest ?? (async () => ({}));
  const onNotification = options.onNotification ?? (() => {});
  const onClose = options.onClose ?? (() => {});
  const allocateId = options.allocateId ?? (() => `request-${++allocateId.counter}`);
  allocateId.counter ??= 0;

  /** id → {resolve, reject, cleanup} for requests this process sent to the host. */
  const outbound = new Map();
  /** inbound request id → AbortController, so `notifications/cancelled` can unwind it. */
  const inbound = new Map();
  let closed = false;

  const rejectPending = (error) => {
    for (const [id, entry] of outbound) {
      outbound.delete(id);
      entry.cleanup();
      entry.reject(error);
    }
  };

  const close = (reason) => {
    if (closed) return;
    closed = true;
    reader.close();
    rejectPending(
      Object.assign(new Error(`transport closed: ${reason}`), { code: "transport_closed" }),
    );
    onClose(reason);
  };

  const write = (message) => {
    if (closed) return;
    const line = `${JSON.stringify(message)}\n`;
    try {
      output.write(line, (error) => {
        if (error) close(error.message ?? String(error));
      });
    } catch (error) {
      close(error?.message ?? String(error));
    }
  };

  const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
  const respondError = (id, code, message) =>
    write({ jsonrpc: "2.0", id, error: { code, message } });

  async function handleInboundRequest(message) {
    const controller = new AbortController();
    inbound.set(keyOf(message.id), controller);
    try {
      const result = await onRequest(message.method, message.params, {
        id: message.id,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        // 客户端已经丢弃这个 id，再回一条应答会被记成 “unknown request”。
        log(`abandoned inbound request ${keyOf(message.id)} after cancellation`);
        return;
      }
      respond(message.id, result ?? {});
    } catch (error) {
      if (controller.signal.aborted) {
        // 客户端已经丢弃这个 id（Pi 的 McpClient 在 abort 时删除 pending 并发取消通知）。
        // 再回一条应答会被记成 “unknown request”，取消反而看起来像错误，所以这里静默收口。
        log(`abandoned inbound request ${keyOf(message.id)} after cancellation`);
      } else {
        const code = typeof error?.code === "number" ? error.code : -32603;
        respondError(message.id, code, error instanceof Error ? error.message : String(error));
      }
    } finally {
      inbound.delete(keyOf(message.id));
    }
  }

  function settle(message) {
    const key = keyOf(message.id);
    const entry = outbound.get(key);
    if (!entry) {
      // 迟到/重复/未知 id：宿主侧的待答项已经结算，不污染后续请求。
      log(`dropping response for unknown id ${key}`);
      return;
    }
    outbound.delete(key);
    entry.cleanup();
    if (message.error) entry.reject(rpcFailure(message.error));
    else entry.resolve(message.result);
  }

  function handleMessage(message) {
    if (!isRecord(message)) return;
    if (typeof message.method === "string") {
      if (message.id === undefined) {
        if (message.method === "notifications/cancelled") {
          const target = isRecord(message.params) ? message.params.requestId : undefined;
          const controller = inbound.get(keyOf(target));
          if (controller) controller.abort();
        }
        onNotification(message.method, message.params);
        return;
      }
      void handleInboundRequest(message);
      return;
    }
    if (message.id !== undefined) settle(message);
  }

  const reader = createInterface({ input, terminal: false });
  reader.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      log("dropping non-JSON line on the MCP transport");
      return;
    }
    handleMessage(message);
  });
  reader.on("close", () => {
    if (!closed) close("stdin closed");
  });
  input.on?.("error", (error) => close(error?.message ?? String(error)));
  output.on?.("error", (error) => close(error?.message ?? String(error)));

  return {
    get closed() {
      return closed;
    },
    /** Send a host-bound request. Returns the deterministic id plus the pending promise. */
    request(method, params, requestOptions = {}) {
      const id = requestOptions.id ?? allocateId();
      const signal = requestOptions.signal;
      let cleanup = () => {};
      const promise = new Promise((resolve, reject) => {
        if (closed) {
          reject(Object.assign(new Error("transport closed"), { code: "transport_closed" }));
          return;
        }
        if (signal?.aborted) {
          reject(Object.assign(new Error("request aborted"), { code: "aborted" }));
          return;
        }
        const onAbort = () => {
          if (!outbound.delete(keyOf(id))) return;
          cleanup();
          reject(Object.assign(new Error("request aborted"), { code: "aborted" }));
        };
        cleanup = () => signal?.removeEventListener("abort", onAbort);
        signal?.addEventListener("abort", onAbort, { once: true });
        // 先登记再写：写入失败时 close() 才能把这个待答请求一起拒绝。
        outbound.set(keyOf(id), { resolve, reject, cleanup });
        write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      });
      return { id, promise };
    },
    notify(method, params) {
      write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    },
    respond,
    respondError,
    close,
  };
}