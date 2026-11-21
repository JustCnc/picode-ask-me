import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callTool, initialize, startServer, withServer } from "./stdio-harness.mjs";

const simpleQuestions = [
  {
    question: "改前端还是 API?",
    header: "范围",
    options: [
      { label: "只改 API", description: "不动 UI" },
      { label: "只改前端", description: "不动后端" },
    ],
  },
];

const nestedAnswers = (question, answer, index = 0) => ({
  answers: {
    answers: { [question]: answer },
    [`answer_${index}`]: answer,
  },
});

describe("picode-ask-me stdio server", () => {
  it("answers initialize with protocol echo, identity and a discoverability hint", async () => {
    await withServer(async (server) => {
      server.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "pi", version: "0.0.0" },
        },
      });
      const response = await server.nextMessage((message) => message.id === 1);
      assert.equal(response.result.protocolVersion, "2025-06-18");
      assert.deepEqual(response.result.capabilities, { tools: {} });
      assert.equal(response.result.serverInfo.name, "picode-ask-me");
      assert.equal(typeof response.result.serverInfo.version, "string");
      assert.match(response.result.instructions, /ask_user_question/);
      assert.deepEqual(server.buffered, []);
    });
  });

  it("falls back to the newest protocol version for an unknown request version", async () => {
    await withServer(async (server) => {
      server.send({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "x", version: "0" } },
      });
      const response = await server.nextMessage((message) => message.id === 2);
      assert.equal(response.result.protocolVersion, "2025-11-25");
    });
  });

  it("lists the ask tool with the questionnaire schema", async () => {
    await withServer(async (server) => {
      await initialize(server);
      server.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const response = await server.nextMessage((message) => message.id === 2);
      const tool = response.result.tools.find((entry) => entry.name === "ask_user_question");
      assert.ok(tool);
      assert.deepEqual(tool.inputSchema.required, ["questions"]);
      assert.match(tool.description, /Do not send the questionnaire as chat text/);
    });
  });

  it("grants capability v1 on the same connection", async () => {
    await withServer(async (server) => {
      await initialize(server);
      server.send({
        jsonrpc: "2.0",
        id: 3,
        method: "picode/handshake",
        params: {
          capabilities: ["ask"],
          epoch: 1,
          pluginId: "picode-ask-me@remote",
          sessionId: "session-1",
          version: 1,
          workspaceIdentity: "D:/ws",
        },
      });
      const response = await server.nextMessage((message) => message.id === 3);
      assert.deepEqual(response.result, { version: 1, capabilities: ["ask"] });
    });
  });

  it("forwards the tool call as a picode/ask request and returns the host answer", async () => {
    await withServer(async (server) => {
      await initialize(server);
      callTool(server, 10, { questions: simpleQuestions });

      const ask = await server.nextMessage((message) => message.method === "picode/ask");
      assert.equal(ask.id, "ask-1");
      assert.equal(ask.params.questions.length, 1);
      assert.equal(ask.params.questions[0].question, "改前端还是 API?");
      assert.equal(ask.params.questions[0].header, "范围");

      server.send({
        jsonrpc: "2.0",
        id: ask.id,
        result: nestedAnswers("改前端还是 API?", "只改前端"),
      });
      const reply = await server.nextMessage((message) => message.id === 10);
      assert.equal(
        reply.result.content[0].text,
        'User has answered your questions: "改前端还是 API?"="只改前端". You can now continue with the user\'s answers in mind.',
      );
      assert.equal(reply.result.isError, undefined);
    });
  });

  it("keeps indexed multi-select answers atomic and preserves custom text", async () => {
    await withServer(async (server) => {
      await initialize(server);
      const questions = [
        { question: "范围?", options: [{ label: "API" }, { label: "UI" }] },
        {
          question: "要不要测试?",
          multiSelect: true,
          options: [{ label: "单元" }, { label: "E2E" }],
        },
      ];
      callTool(server, 11, { questions });
      const ask = await server.nextMessage((message) => message.method === "picode/ask");
      server.send({
        jsonrpc: "2.0",
        id: ask.id,
        result: {
          answers: {
            answers: { "范围?": "API", "要不要测试?": "单元, E2E, 手写, 带逗号" },
            answer_0: "API",
            answer_1: ["单元", "E2E", "手写, 带逗号"],
          },
        },
      });
      const reply = await server.nextMessage((message) => message.id === 11);
      assert.match(reply.result.content[0].text, /"范围\?"="API"/);
      assert.match(reply.result.content[0].text, /"要不要测试\?"="单元, E2E, 手写, 带逗号"/);
    });
  });

  it("rejects invalid arguments without bothering the user", async () => {
    await withServer(async (server) => {
      await initialize(server);
      callTool(server, 20, { questions: [{ question: "只有一项?", options: [{ label: "A" }] }] });
      const reply = await server.nextMessage((message) => message.id === 20);
      assert.equal(reply.result.isError, true);
      assert.match(reply.result.content[0].text, /2-4 options/);
      await server.expectNoMessage((message) => message.method === "picode/ask");
    });
  });

  it("reports an unknown tool as a tool error", async () => {
    await withServer(async (server) => {
      await initialize(server);
      server.send({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "some_other_tool", arguments: {} },
      });
      const reply = await server.nextMessage((message) => message.id === 21);
      assert.equal(reply.result.isError, true);
      assert.match(reply.result.content[0].text, /unknown tool/);
    });
  });

  it("surfaces host capability errors as tool results", async () => {
    await withServer(async (server) => {
      await initialize(server);
      callTool(server, 30, { questions: simpleQuestions });
      const ask = await server.nextMessage((message) => message.method === "picode/ask");
      server.send({
        jsonrpc: "2.0",
        id: ask.id,
        error: {
          code: -32000,
          message: 'Capability "ask" is not granted',
          data: { code: "plugin_capability_not_granted" },
        },
      });
      const reply = await server.nextMessage((message) => message.id === 30);
      assert.equal(reply.result.isError, true);
      assert.match(reply.result.content[0].text, /plugin_capability_not_granted/);
      assert.match(reply.result.content[0].text, /granted/);
    });
  });

  it("maps a missing host handler to an actionable message", async () => {
    await withServer(async (server) => {
      await initialize(server);
      callTool(server, 31, { questions: simpleQuestions });
      const ask = await server.nextMessage((message) => message.method === "picode/ask");
      server.send({
        jsonrpc: "2.0",
        id: ask.id,
        error: { code: -32601, message: "Method not found: picode/ask" },
      });
      const reply = await server.nextMessage((message) => message.id === 31);
      assert.equal(reply.result.isError, true);
      assert.match(reply.result.content[0].text, /ask the question in chat/);
    });
  });

  it("returns the decline wording for a cancelled host answer", async () => {
    await withServer(async (server) => {
      await initialize(server);
      callTool(server, 32, { questions: simpleQuestions });
      const ask = await server.nextMessage((message) => message.method === "picode/ask");
      server.send({ jsonrpc: "2.0", id: ask.id, result: { cancelled: true } });
      const reply = await server.nextMessage((message) => message.id === 32);
      assert.equal(reply.result.content[0].text, "User declined to answer questions");
    });
  });

  it("abandons the ask on tool-call cancellation and correlates the next call", async () => {
    await withServer(async (server) => {
      await initialize(server);
      callTool(server, 40, { questions: simpleQuestions });
      const first = await server.nextMessage((message) => message.method === "picode/ask");
      assert.equal(first.id, "ask-1");

      server.notify("notifications/cancelled", { requestId: 40 });
      // 迟到的应答属于已放弃的 id，不能落到后续调用上。
      server.send({ jsonrpc: "2.0", id: first.id, result: nestedAnswers("改前端还是 API?", "只改 API") });
      await server.expectNoMessage((message) => message.id === 40);

      callTool(server, 41, { questions: simpleQuestions });
      const second = await server.nextMessage((message) => message.method === "picode/ask");
      assert.equal(second.id, "ask-2");
      server.send({
        jsonrpc: "2.0",
        id: second.id,
        result: nestedAnswers("改前端还是 API?", "只改前端"),
      });
      const reply = await server.nextMessage((message) => message.id === 41);
      assert.match(reply.result.content[0].text, /只改前端/);
    });
  });

  it("exits cleanly when the host closes the connection with an ask pending", async () => {
    const server = startServer();
    await initialize(server);
    callTool(server, 50, { questions: simpleQuestions });
    await server.nextMessage((message) => message.method === "picode/ask");
    const code = await server.close();
    assert.equal(code, 0);
  });
});