import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASK_INPUT_SCHEMA,
  formatAskResult,
  normalizeQuestions,
  parseAskResponse,
} from "../src/questions.mjs";

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

function ask(questions) {
  const normalized = normalizeQuestions({ questions });
  if (!normalized.ok) assert.fail(normalized.message);
  return normalized.questions;
}

describe("normalizeQuestions", () => {
  it("keeps header, description, preview and multiSelect", () => {
    const questions = ask(twoQuestions);
    assert.equal(questions[0].header, "范围");
    assert.deepEqual(questions[0].options[1], {
      label: "只改前端",
      description: "不动后端",
      preview: "before/after mockup",
    });
    assert.equal(questions[1].multiSelect, true);
  });

  it("repairs a JSON-stringified questions parameter", () => {
    const questions = ask(JSON.stringify(twoQuestions));
    assert.equal(questions.length, 2);
  });

  it("rejects a prose blob instead of guessing", () => {
    const result = normalizeQuestions({ questions: "第一版范围？1. 只做手写" });
    assert.equal(result.ok, false);
  });

  it("rejects reserved host labels", () => {
    for (const label of ["Other", "Type something.", "Next", "自己输入"]) {
      const result = normalizeQuestions({
        questions: [
          {
            question: "Which?",
            options: [{ label: "A" }, { label }],
          },
        ],
      });
      assert.equal(result.ok, false, label);
      assert.match(result.message, /reserved label/);
    }
  });

  it("rejects duplicate option labels case-insensitively", () => {
    const result = normalizeQuestions({
      questions: [
        {
          question: "Which?",
          options: [{ label: "API" }, { label: "api" }],
        },
      ],
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /duplicate option/);
  });

  it("rejects two questions with the same text", () => {
    // 宿主用题目原文当 answers 的键，同文题会互相覆盖答案。
    const result = normalizeQuestions({
      questions: [
        { question: "Which scope?", options: [{ label: "A" }, { label: "B" }] },
        { question: " which SCOPE? ", options: [{ label: "A" }, { label: "B" }] },
      ],
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /duplicate question/);
  });

  it("rejects non-string question and option fields", () => {
    const cases = [
      { questions: [{ question: 42, options: [{ label: "A" }, { label: "B" }] }] },
      { questions: [{ question: "Q?", options: [{ label: 7 }, { label: "B" }] }] },
      {
        questions: [
          { question: "Q?", options: [{ label: "A", description: 1 }, { label: "B" }] },
        ],
      },
      {
        questions: [{ question: "Q?", options: [{ label: "A", preview: {} }, { label: "B" }] }],
      },
      {
        questions: [
          { question: "Q?", header: 9, options: [{ label: "A" }, { label: "B" }] },
        ],
      },
      {
        questions: [
          { question: "Q?", multiSelect: "true", options: [{ label: "A" }, { label: "B" }] },
        ],
      },
    ];
    for (const input of cases) {
      assert.equal(normalizeQuestions(input).ok, false, JSON.stringify(input));
    }
  });

  it("enforces 1-4 questions and 2-4 options", () => {
    assert.equal(normalizeQuestions({ questions: [] }).ok, false);
    assert.equal(
      normalizeQuestions({
        questions: Array.from({ length: 5 }, (_, index) => ({
          question: `Q${index}?`,
          options: [{ label: "A" }, { label: "B" }],
        })),
      }).ok,
      false,
    );
    assert.equal(
      normalizeQuestions({
        questions: [{ question: "Q?", options: [{ label: "A" }] }],
      }).ok,
      false,
    );
    assert.equal(
      normalizeQuestions({
        questions: [
          {
            question: "Q?",
            options: ["A", "B", "C", "D", "E"].map((label) => ({ label })),
          },
        ],
      }).ok,
      false,
    );
  });

  it("drops preview for multiSelect and for previews leaking a sibling question", () => {
    const questions = ask([
      {
        question: "待办队列的第一版范围?",
        options: [
          { label: "只做手写", preview: "待办和当前聊天是不是分开的两套东西?\n是，另一条产品" },
          { label: "加上定时" },
        ],
      },
      {
        question: "待办和当前聊天是不是分开的两套东西?",
        multiSelect: true,
        options: [
          { label: "实时", preview: "should be dropped" },
          { label: "手动" },
        ],
      },
    ]);
    assert.equal(questions[0].options[0].preview, undefined);
    assert.equal(questions[1].options[0].preview, undefined);
  });

  it("exposes the tool schema with the host's question limits", () => {
    assert.deepEqual(ASK_INPUT_SCHEMA.required, ["questions"]);
    assert.equal(ASK_INPUT_SCHEMA.properties.questions.maxItems, 4);
    assert.equal(ASK_INPUT_SCHEMA.properties.questions.items.properties.options.minItems, 2);
    assert.equal(ASK_INPUT_SCHEMA.properties.questions.items.properties.options.maxItems, 4);
  });
});

describe("parseAskResponse", () => {
  it("unwraps the nested host result and prefers the indexed answer", () => {
    // 宿主返回 { answers: content }，content 自己又带 answers 记录。
    const result = parseAskResponse(
      {
        answers: {
          answers: { "改前端还是 API?": "只改 API", "要不要加测试?": "单元" },
          answer_0: "只改前端",
          answer_1: ["单元"],
        },
      },
      ask(twoQuestions),
    );
    assert.equal(result.cancelled, false);
    assert.equal(result.answers[0].answer, "只改前端");
    assert.equal(result.answers[1].answer, "单元");
  });

  it("keeps indexed multi-select arrays atomic instead of splitting on commas", () => {
    const questions = ask(twoQuestions);
    const result = parseAskResponse(
      {
        answers: {
          answers: { "要不要加测试?": "单元, E2E, 手写, 带逗号" },
          answer_1: ["单元", "E2E", "手写, 带逗号"],
        },
      },
      questions,
    );
    const answer = result.answers[0];
    assert.deepEqual(answer.selected, ["单元", "E2E"]);
    assert.equal(answer.custom, true);
    assert.equal(answer.answer, "单元, E2E, 手写, 带逗号");
  });

  it("preserves a custom single-select answer containing a comma", () => {
    const questions = ask(twoQuestions);
    const result = parseAskResponse(
      { answers: { answers: { "改前端还是 API?": "先只改 API, 之后再说" }, answer_0: "先只改 API, 之后再说" } },
      questions,
    );
    assert.equal(result.answers[0].answer, "先只改 API, 之后再说");
    assert.equal(result.answers[0].custom, true);
  });

  it("falls back to the answers record when there is no indexed answer", () => {
    const questions = ask(twoQuestions);
    const result = parseAskResponse(
      { answers: { answers: { "要不要加测试?": "单元, E2E" } } },
      questions,
    );
    assert.deepEqual(result.answers[0].selected, ["单元", "E2E"]);
    assert.equal(result.answers[0].custom, false);
  });

  it("omits questions the user left unanswered instead of inventing answers", () => {
    const questions = ask(twoQuestions);
    const result = parseAskResponse(
      { answers: { answers: { "改前端还是 API?": "只改 API" }, answer_0: "只改 API" } },
      questions,
    );
    assert.equal(result.answers.length, 1);
    assert.equal(result.answers[0].question, "改前端还是 API?");
  });

  it("reads the legacy single-question answer field", () => {
    const questions = ask([twoQuestions[0]]);
    const result = parseAskResponse(
      { answers: { answers: {}, answer: "只改 API" } },
      questions,
    );
    assert.equal(result.answers[0].answer, "只改 API");
  });

  it("accepts the structured answers array shape", () => {
    const questions = ask(twoQuestions);
    const result = parseAskResponse(
      {
        answers: [
          { question: "改前端还是 API?", answer: "只改前端", custom: false, notes: "keep it small" },
        ],
      },
      questions,
    );
    assert.equal(result.answers[0].answer, "只改前端");
    assert.equal(result.answers[0].preview, "before/after mockup");
    assert.equal(result.answers[0].notes, "keep it small");
  });

  it("reports cancellation separately from an empty answer set", () => {
    const questions = ask(twoQuestions);
    assert.equal(parseAskResponse({ cancelled: true }, questions).cancelled, true);
    const empty = parseAskResponse({ answers: { answers: {} } }, questions);
    assert.deepEqual(empty, { cancelled: false, answers: [] });
  });
});

describe("formatAskResult", () => {
  it("renders the accepted answers with the user's custom multi-select text", () => {
    const questions = ask(twoQuestions);
    const result = parseAskResponse(
      {
        answers: {
          answers: { "改前端还是 API?": "只改前端", "要不要加测试?": "单元, 手写, 带逗号" },
          answer_0: "只改前端",
          answer_1: ["单元", "手写, 带逗号"],
        },
      },
      questions,
    );
    const text = formatAskResult(result);
    assert.equal(
      text,
      'User has answered your questions: "改前端还是 API?"="只改前端". selected preview: before/after mockup. "要不要加测试?"="单元, 手写, 带逗号". You can now continue with the user\'s answers in mind.',
    );
  });

  it("includes the selected preview", () => {
    const text = formatAskResult({
      cancelled: false,
      answers: [{ question: "Q?", answer: "只改前端", preview: "mockup" }],
    });
    assert.match(text, /selected preview: mockup/);
  });

  it("distinguishes a decline from an accepted empty submission", () => {
    assert.equal(
      formatAskResult({ cancelled: true, answers: [] }),
      "User declined to answer questions",
    );
    assert.equal(
      formatAskResult({ cancelled: false, answers: [] }),
      "User submitted no answers; continue with your best judgment.",
    );
  });
});