#!/usr/bin/env node
/**
 * picode-ask-me — PiCode 原生问卷插件的 MCP stdio 服务。
 *
 * 一条连接上做三件事：
 *   1. 标准 MCP：`initialize` / `tools/list` / `tools/call`；
 *   2. 宿主 `picode/handshake` → `{version: 1, capabilities: ["ask"]}`，
 *      宿主据此在当前连接上启用 ask 反向通道（缺字段/版本不符即不授权）；
 *   3. `tools/call` 期间向同一条连接发 `picode/ask` 反向请求，由宿主渲染问卷。
 *
 * 没有依赖，也没有 Pi 的 ExtensionAPI：交互全部交给宿主的待答 UI。
 * 宿主 MCP 配置默认 `exposure: "codemode"`，所以工具默认不是直接工具，而是由模型写 codemode
 * 调 MCP 工具来触达（`tool_search` 是否可用取决于宿主自己的能力配置，不由插件决定）；
 * `initialize.instructions` 让模型更容易找到它。
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createStdioPeer } from "./rpc.mjs";
import {
  ASK_INPUT_SCHEMA,
  ASK_TOOL_DESCRIPTION,
  ASK_TOOL_NAME,
  formatAskResult,
  normalizeQuestions,
  parseAskResponse,
} from "./questions.mjs";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
export const GRANTED_CAPABILITIES = ["ask"];
export const INSTRUCTIONS =
  "Use ask_user_question (1-4 questions, 2-4 options each) before changing code when a missing decision would change the result. The PiCode host renders the questions and returns the user's answers.";

function readVersion() {
  try {
    const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const SERVER_INFO = { name: "picode-ask-me", version: readVersion() };

export const TOOLS = [
  {
    name: ASK_TOOL_NAME,
    description: ASK_TOOL_DESCRIPTION,
    inputSchema: ASK_INPUT_SCHEMA,
  },
];

function toolResult(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function methodNotFound(method) {
  return Object.assign(new Error(`Method not found: ${String(method)}`), { code: -32601 });
}

/**
 * 宿主 `ask` 端口的失败码要保住：只留文案的话模型读不出「没授权」还是「已撤销」。
 * 这里把宿主码翻成一句可执行的话，原码原样写进结果。
 */
function describeAskFailure(error) {
  const localCode = typeof error?.code === "string" ? error.code : "";
  if (localCode === "aborted") return "Error: the question was cancelled before it was answered";
  if (localCode === "transport_closed") {
    return "Error: the PiCode host connection closed before the question was answered";
  }
  const hostCode = typeof error?.dataCode === "string" ? error.dataCode : "";
  const detail = hostCode ? `${hostCode}: ${error?.message ?? ""}` : (error?.message ?? String(error));
  switch (hostCode) {
    case "plugin_capability_not_granted":
      return `Error: the user has not granted the ask capability to this plugin (${detail}). Ask the question in chat instead.`;
    case "plugin_capability_revoked":
      return `Error: the ask capability was revoked for this plugin (${detail}). Ask the question in chat instead.`;
    case "plugin_capability_unsupported":
    case "plugin_capability_detached":
      return `Error: the host cannot render questions on this connection (${detail}).`;
    default:
      break;
  }
  if (error?.code === -32601) {
    return `Error: the host has no picode/ask handler (${detail}); ask the question in chat instead.`;
  }
  return `Error: the host rejected the question (${detail})`;
}

/**
 * 传输可注入：进程内测试用假流，真正运行时用 stdio。
 * 返回的 handleRequest 只做方法分派，`picode/ask` 的关联 id 由传输层按序分配（ask-1, ask-2 …）。
 */
export function createServer(options = {}) {
  const log = options.log ?? ((message) => process.stderr.write(`[picode-ask-me] ${message}\n`));
  let sequence = 0;
  const peer = createStdioPeer({
    input: options.input,
    output: options.output,
    log,
    onClose: options.onClose,
    allocateId: () => `ask-${++sequence}`,
    onRequest: handleRequest,
  });

  async function runAskTool(params, context) {
    if (params?.name !== ASK_TOOL_NAME) {
      return toolResult(`Error: unknown tool ${JSON.stringify(params?.name ?? null)}`, true);
    }
    const normalized = normalizeQuestions(params?.arguments ?? {});
    if (!normalized.ok) {
      // 参数错误不打扰用户：模型能自己改，不必弹一张错问卷。
      return toolResult(normalized.message, true);
    }
    // 宿主的 ask 端口与工具调用共用客户端取消信号：客户端取消就放弃这次提问。
    const { promise } = peer.request(
      "picode/ask",
      { questions: normalized.questions },
      { signal: context.signal },
    );
    let response;
    try {
      response = await promise;
    } catch (error) {
      return toolResult(describeAskFailure(error), true);
    }
    return toolResult(formatAskResult(parseAskResponse(response, normalized.questions)));
  }

  async function handleRequest(method, params, context) {
    switch (method) {
      case "initialize": {
        const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
        // 客户端只接受自己支持的版本；不认识的请求版本回落最新值，不抬高也不假装协商。
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
        return {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOLS };
      case "tools/call":
        return runAskTool(params, context);
      case "picode/handshake":
        // 宿主交叉授权：只报自己真的能兑现的能力，握手内容不做记忆。
        return { version: 1, capabilities: [...GRANTED_CAPABILITIES] };
      default:
        throw methodNotFound(method);
    }
  }

  return peer;
}

function main() {
  // 收尾时不断然 exit(0)：stdout 是管道，立刻退出可能截断最后一条应答。
  // 释放 stdin 后事件循环自然结束，退出码保持 0。
  const peer = createServer({
    onClose: () => {
      process.exitCode = 0;
      if (!process.stdin.destroyed) process.stdin.destroy();
    },
  });
  process.stdin.on("end", () => peer.close("stdin ended"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();