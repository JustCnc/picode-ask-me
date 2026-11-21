/**
 * Minimal JSONL harness: real child process, one JSON object per stdout line.
 * Keeps every inbound message until a waiter matches it, so ordering assertions
 * (an `ask`, then the terminal `result`) stay readable.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const RUNTIME_PATH = join(ROOT, "src", "native.mjs");

export function startRuntime() {
  const child = spawn(process.execPath, [RUNTIME_PATH], { stdio: ["pipe", "pipe", "pipe"] });
  // 子进程收口后宿主仍可能 close stdin：端到端测试里吞掉 EPIPE，不让它变成未处理异常。
  child.stdin.on("error", () => {});
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
    exited,
    nextMessage,
    expectNoMessage,
    get stderr() {
      return stderr;
    },
    get buffered() {
      return messages;
    },
    async close() {
      child.stdin.end();
      return exited;
    },
  };
}

export async function withRuntime(run) {
  const runtime = startRuntime();
  try {
    return await run(runtime);
  } finally {
    if (runtime.child.exitCode === null) {
      runtime.child.kill();
      await runtime.close().catch(() => {});
    }
  }
}