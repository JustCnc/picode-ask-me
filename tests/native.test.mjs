import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startRuntime, withRuntime } from "./native-harness.mjs";

const twoQuestions = [
  {
    question: "改前端还是 API?",
    header: "范围",
    options: [
      { label: "只改 API", description: "不动 UI" },
      { label: "只改前端", description: "不动后端", preview: "before/after mockup" },
    ],
  },
  {
    question: "要不要加测试?",
    multiSelect: true,
    options: [{ label: "单元" }, { label: "E2E", description: "端到端" }],
  },
];

const invoke = (questions, version = 1) => ({
  type: "invoke",
  version,
  args: { questions },
});

const isType = (type) => (message) => message.type === type;

describe("picode-ask-me native runtime", () => {
  it("asks with normalized questions and returns the formatted answer", async () => {
    await withRuntime(async (runtime) => {
      runtime.send(invoke(twoQuestions));
      const ask = await runtime.nextMessage(isType("ask"));
      assert.deepEqual(ask.questions, [
        {
          question: "改前端还是 API?",
          header: "范围",
          options: [
            { label: "只改 API", description: "不动 UI" },
            { label: "只改前端", description: "不动后端", preview: "before/after mockup" },
          ],
        },
        {
          question: "要不要加测试?",
          multiSelect: true,
          options: [{ label: "单元" }, { label: "E2E", description: "端到端" }],
        },
      ]);

      runtime.send({
        type: "answer",
        result: {
          answers: {
            answers: {
              "改前端还是 API?": "只改前端",
              "要不要加测试?": "单元, E2E, 手写, 带逗号",
            },
            answer_0: "只改前端",
            answer_1: ["单元", "E2E", "手写, 带逗号"],
          },
        },
      });

      const result = await runtime.nextMessage(isType("result"));
      assert.equal(
        result.text,
        'User has answered your questions: "改前端还是 API?"="只改前端". selected preview: before/after mockup. "要不要加测试?"="单元, E2E, 手写, 带逗号". You can now continue with the user\'s answers in mind.',
      );
      assert.equal(await runtime.close(), 0);
    });
  });

  it("returns the decline wording for a cancelled answer", async () => {
    await withRuntime(async (runtime) => {
      runtime.send(invoke([twoQuestions[0]]));
      await runtime.nextMessage(isType("ask"));
      runtime.send({ type: "answer", result: { cancelled: true } });
      const result = await runtime.nextMessage(isType("result"));
      assert.equal(result.text, "User declined to answer questions");
    });
  });

  it("answers an accepted empty submission without inventing answers", async () => {
    await withRuntime(async (runtime) => {
      runtime.send(invoke([twoQuestions[0]]));
      await runtime.nextMessage(isType("ask"));
      runtime.send({ type: "answer", result: { answers: { answers: {} } } });
      const result = await runtime.nextMessage(isType("result"));
      assert.equal(
        result.text,
        "User submitted no answers; continue with your best judgment.",
      );
    });
  });

  it("rejects invalid arguments without asking the user", async () => {
    await withRuntime(async (runtime) => {
      runtime.send(invoke([{ question: "只有一项?", options: [{ label: "A" }] }]));
      const error = await runtime.nextMessage(isType("error"));
      assert.match(error.message, /2-4 options/);
      await runtime.expectNoMessage(isType("ask"));
    });
  });

  it("rejects an unsupported invoke version without asking", async () => {
    await withRuntime(async (runtime) => {
      runtime.send(invoke(twoQuestions, 2));
      const error = await runtime.nextMessage(isType("error"));
      assert.match(error.message, /unsupported invoke version 2/);
      assert.match(error.message, /speaks version 1/);
      await runtime.expectNoMessage(isType("ask"));
    });
  });

  it("drops malformed and unknown lines instead of ending the invocation", async () => {
    await withRuntime(async (runtime) => {
      runtime.child.stdin.write("not json\n");
      runtime.send({ type: "noise" });
      runtime.send(invoke([twoQuestions[0]]));
      const ask = await runtime.nextMessage(isType("ask"));
      assert.equal(ask.questions.length, 1);
      runtime.send({ type: "answer", result: { cancelled: true } });
      const result = await runtime.nextMessage(isType("result"));
      assert.match(result.text, /declined/);
    });
  });

  it("ignores an answer with no pending question and asks only once per invoke", async () => {
    await withRuntime(async (runtime) => {
      runtime.send({ type: "answer", result: { cancelled: true } });
      runtime.send(invoke([twoQuestions[0]]));
      await runtime.nextMessage(isType("ask"));

      runtime.send(invoke([twoQuestions[0]]));
      await runtime.expectNoMessage(isType("ask"));

      runtime.send({ type: "answer", result: { cancelled: true } });
      const result = await runtime.nextMessage(isType("result"));
      assert.match(result.text, /declined/);
    });
  });

  it("treats an answer without result as a protocol error", async () => {
    await withRuntime(async (runtime) => {
      runtime.send(invoke([twoQuestions[0]]));
      await runtime.nextMessage(isType("ask"));
      // 缺 result 不能静默读成「用户没回答」。
      runtime.send({ type: "answer" });
      const error = await runtime.nextMessage(isType("error"));
      assert.match(error.message, /answer frame carries no result/);
    });
  });

  it("tolerates the host's extra invoke fields", async () => {
    await withRuntime(async (runtime) => {
      // pi-host spreads its trusted session context onto the invoke frame; an ask binding
      // normally gets none, so this only proves unknown top-level fields don't break parsing.
      runtime.send({
        type: "invoke",
        version: 1,
        sessionId: "session-1",
        workspaceDir: "D:/workspace",
        args: { questions: [twoQuestions[0]] },
      });
      const ask = await runtime.nextMessage(isType("ask"));
      assert.equal(ask.questions.length, 1);
      runtime.send({ type: "answer", result: { cancelled: true } });
      const result = await runtime.nextMessage(isType("result"));
      assert.match(result.text, /declined/);
    });
  });

  it("rejects a questionnaire above the host's ceilings without asking", async () => {
    await withRuntime(async (runtime) => {
      // 超过宿主 isQuestionnaire 上限的问卷会被宿主整包拒掉（只有一句 Invalid questions），
      // 这里先报出可修的错，用户不会被弹一张无效问卷。
      runtime.send(
        invoke([{ question: "q".repeat(4001), options: [{ label: "A" }, { label: "B" }] }]),
      );
      const error = await runtime.nextMessage(isType("error"));
      assert.match(error.message, /question exceeds 4000 characters/);
      await runtime.expectNoMessage(isType("ask"));
    });
  });

  it("keeps waiting while the user thinks instead of timing out", async () => {
    await withRuntime(async (runtime) => {
      runtime.send(invoke([twoQuestions[0]]));
      await runtime.nextMessage(isType("ask"));
      // 插件侧没有定时器：这段暂停之后仍必须能收下答案。
      await new Promise((resolve) => setTimeout(resolve, 1200));
      runtime.send({ type: "answer", result: { cancelled: true } });
      const result = await runtime.nextMessage(isType("result"));
      assert.match(result.text, /declined/);
    });
  });

  it("exits on its own after the terminal message", { timeout: 5000 }, async () => {
    const runtime = startRuntime();
    runtime.send(invoke([twoQuestions[0]]));
    await runtime.nextMessage(isType("ask"));
    runtime.send({ type: "answer", result: { cancelled: true } });
    await runtime.nextMessage(isType("result"));
    // 一次调用一个子进程：发完 result 就该自然退出，宿主不必替它关 stdin。
    assert.equal(await runtime.exited, 0);
  });

  it("exits cleanly when the host closes stdin with a question pending", async () => {
    const runtime = startRuntime();
    runtime.send(invoke([twoQuestions[0]]));
    await runtime.nextMessage(isType("ask"));
    assert.equal(await runtime.close(), 0);
    assert.deepEqual(runtime.buffered, []);
  });
});