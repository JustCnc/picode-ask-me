#!/usr/bin/env node
/**
 * picode-ask-me — ask v2 native Host API runtime.
 *
 * The PiCode host spawns this process once per tool invocation and talks to it over
 * private newline-delimited JSON on stdin/stdout. One invocation is:
 *
 *   in  {"type":"invoke","version":1,"args":{"questions":[...]}}
 *   out {"type":"ask","questions":[...]}
 *   in  {"type":"answer","result":{"cancelled":true}|{"answers":...}}
 *   out {"type":"result","text":"..."} | {"type":"error","message":"..."}
 *
 * The host owns identity, permission and lifetime: it stops the child (or closes stdin)
 * to cancel. Waiting for the user is unbounded here — no timers, no retries, no timeouts.
 * stdout carries protocol lines only; diagnostics go to stderr.
 */
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { formatAskResult, normalizeQuestions, parseAskResponse } from "./questions.mjs";

/** Protocol version this runtime speaks; the host sends it on every `invoke`. */
const INVOKE_VERSION = 1;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createNativeRuntime(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((message) => process.stderr.write(`[picode-ask-me] ${message}\n`));

  let finished = false;
  let stopped = false;
  /** Questions of the one invocation currently waiting for an `answer`. */
  let pending = undefined;

  const reader = createInterface({ input, terminal: false });
  const { promise: done, resolve: settle } = Promise.withResolvers();

  /** Stop reading without a terminal message: host closed the pipe or the process is done. */
  function stop() {
    if (stopped) return;
    stopped = true;
    reader.close();
    if (!input.destroyed) input.destroy();
    settle();
  }

  /** Write one protocol line; a broken pipe ends the runtime instead of buffering forever. */
  function send(message, onFlushed) {
    const line = `${JSON.stringify(message)}\n`;
    try {
      output.write(line, (error) => {
        if (error) {
          log(`write failed: ${error.message ?? String(error)}`);
          stop();
          return;
        }
        onFlushed?.();
      });
      return true;
    } catch (error) {
      log(`write failed: ${error?.message ?? String(error)}`);
      stop();
      return false;
    }
  }

  /** Send the single terminal message of this invocation, then exit normally after it flushes. */
  function finish(message) {
    if (finished) return;
    finished = true;
    send(message, stop);
  }

  function fail(message) {
    finish({ type: "error", message });
  }

  function handleInvoke(message) {
    if (finished) return;
    if (pending) {
      // One ask per invoke: the host must answer or stop the child before invoking again.
      log("dropping invoke while a question is still pending");
      return;
    }
    if (message.version !== INVOKE_VERSION) {
      fail(
        `Error: unsupported invoke version ${JSON.stringify(message.version ?? null)}; this plugin speaks version ${INVOKE_VERSION}`,
      );
      return;
    }
    const normalized = normalizeQuestions(message.args);
    if (!normalized.ok) {
      // 参数错误不打扰用户：模型能自己改，不必弹一张错问卷。
      fail(normalized.message);
      return;
    }
    pending = normalized.questions;
    // 先登记 pending 再写：写入失败时不再等待一个不会到的答复。
    if (!send({ type: "ask", questions: pending })) pending = undefined;
  }

  function handleAnswer(message) {
    if (finished) return;
    if (!pending) {
      // 迟到的答复（上一调用已收口）不落到本调用上。
      log("dropping answer with no pending question");
      return;
    }
    const questions = pending;
    pending = undefined;
    finish({ type: "result", text: formatAskResult(parseAskResponse(message.result, questions)) });
  }

  function handleMessage(message) {
    if (finished) return;
    if (!isRecord(message)) {
      log("dropping non-object message");
      return;
    }
    switch (message.type) {
      case "invoke":
        handleInvoke(message);
        return;
      case "answer":
        handleAnswer(message);
        return;
      default:
        log(`dropping unknown message type ${JSON.stringify(message.type ?? null)}`);
    }
  }

  reader.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      log("dropping non-JSON line");
      return;
    }
    handleMessage(message);
  });

  // Host closed the pipe (cancelled / stopped): exit silently instead of inventing an answer.
  reader.on("close", () => {
    if (pending) log("input closed with a question pending");
    pending = undefined;
    finished = true;
    stop();
  });

  input.on?.("error", (error) => {
    log(`input failed: ${error?.message ?? String(error)}`);
    pending = undefined;
    finished = true;
    stop();
  });
  output.on?.("error", (error) => {
    log(`output failed: ${error?.message ?? String(error)}`);
    pending = undefined;
    finished = true;
    stop();
  });

  return done;
}

export function main() {
  return createNativeRuntime();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();