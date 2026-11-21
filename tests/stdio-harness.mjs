/**
 * Minimal stdio harness: real child process, newline-delimited JSON-RPC.
 * Keeps every inbound message until a waiter matches it, so out-of-order
 * assertions (an ask, then the tool result) stay readable.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER_PATH = join(ROOT, "src", "server.mjs");

export function startServer() {
  const child = spawn(process.execPath, [SERVER_PATH], { stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  const waiters = new Set();
  let stderr = "";

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    messages.push(JSON.parse(text));
    for (const waiter of [...waiters]) waiter.check();
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));

  function nextMessage(predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const waiter = {
        check() {
          const index = messages.findIndex(predicate);
          if (index < 0) return;
          const [message] = messages.splice(index, 1);
          waiters.delete(waiter);
          clearTimeout(timer);
          resolve(message);
        },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`timed out waiting for a message\nstderr: ${stderr}`));
      }, timeoutMs);
      waiters.add(waiter);
      waiter.check();
    });
  }

  function expectNoMessage(predicate, windowMs = 200) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const found = messages.find(predicate);
        if (found) reject(new Error(`unexpected message ${JSON.stringify(found)}`));
        else resolve();
      }, windowMs);
    });
  }

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  return {
    child,
    send,
    notify(method, params) {
      send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    },
    nextMessage,
    expectNoMessage,
    get stderr() {
      return stderr;
    },
    exited,
    get buffered() {
      return messages;
    },
    async close() {
      child.stdin.end();
      const code = await exited;
      reader.close();
      return code;
    },
  };
}

export async function withServer(run) {
  const server = startServer();
  try {
    return await run(server);
  } finally {
    if (server.child.exitCode === null) await server.close();
  }
}

export async function initialize(server) {
  server.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "pi", version: "0.0.0" },
    },
  });
  const result = await server.nextMessage((message) => message.id === 1);
  server.notify("notifications/initialized");
  return result.result;
}

export function callTool(server, id, args) {
  server.send({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "ask_user_question", arguments: args },
  });
}