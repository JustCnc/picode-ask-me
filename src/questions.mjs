/**
 * Question contract shared by the ask v2 tool catalog, the `ask` message and the
 * tool-result formatter. Dependency-free so the plugin ships as plain Node ESM.
 *
 * Rules ported from pi-ask-me (src/ask.ts) stay validated — never clamped: a malformed
 * questionnaire is an error the model can fix, not something the plugin quietly rewrites.
 * The one cosmetic exception is `header`: it is a chip label, so it is trimmed to
 * MAX_HEADER_LENGTH code points instead of failing the call.
 */

export const ASK_TOOL_NAME = "ask_user_question";
export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
/** Advertised label guidance ("1-5 words"); the hard ceiling is MAX_LABEL_LENGTH. */
export const MAX_LABEL_GUIDE = 60;

/**
 * Host-side ceilings: `isQuestionnaire` in PiCode's `pi-host/native-plugin-tool-host.ts`
 * rejects anything above these before the questionnaire reaches the UI, answering the tool with
 * a bare "Invalid questions from native plugin". Rejecting here first turns that into an error
 * the model can fix.
 */
export const MAX_QUESTION_LENGTH = 4000;
export const MAX_LABEL_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 4000;
export const MAX_PREVIEW_LENGTH = 16_000;

/**
 * Whole-frame budget. Every field above can be within its own ceiling and the aggregated `ask`
 * line still exceed the host's `MAX_FRAME_BYTES` (1 MiB), which the host kills at the protocol
 * layer. Kept just under 1 MiB so the envelope and JSON escaping fit.
 */
export const MAX_PAYLOAD_BYTES = 1_000_000;

/** Labels the host appends itself; authoring them collides with the host's custom row. */
const RESERVED_LABELS = new Set(["other", "type something.", "next", "自己输入"]);

export const ASK_TOOL_DESCRIPTION = [
  "Ask the user 1-4 structured questions with 2-4 options each when a missing decision would change what you implement.",
  "Pass questions as function parameters (question, header, options[].label, options[].description, options[].preview, multiSelect). Do not send the questionnaire as chat text.",
  "The host renders these in its own question UI and returns the chosen answers; wait for the tool result before write/edit/bash.",
  "Set multiSelect when several answers can be valid together.",
  "Optional options[].preview is a markdown mockup of that one option only, never the other questions or options; it is shown for single-select questions.",
  "Do not author Type something. / Other / Next - the host appends its own custom answer row.",
  "If you recommend an option, put it first and append (Recommended) to its label.",
  "Group all clarifying questions into one call. If the result says the user declined, continue without asking again.",
].join(" ");

export const ASK_INPUT_SCHEMA = {
  type: "object",
  required: ["questions"],
  additionalProperties: false,
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: MAX_QUESTIONS,
      description: "Questions to ask (1-4). Group all clarifying questions into one call.",
      items: {
        type: "object",
        required: ["question", "options"],
        additionalProperties: false,
        properties: {
          question: {
            type: "string",
            maxLength: MAX_QUESTION_LENGTH,
            description: "Complete question, ending with ?.",
          },
          header: {
            type: "string",
            maxLength: MAX_HEADER_LENGTH,
            description: "Short chip, e.g. Scope, Auth.",
          },
          multiSelect: {
            type: "boolean",
            description: "True when several options can be chosen together.",
          },
          options: {
            type: "array",
            minItems: MIN_OPTIONS,
            maxItems: MAX_OPTIONS,
            description:
              "2-4 choices. Do not include Type something. / Other / Next - the host appends them.",
            items: {
              type: "object",
              required: ["label"],
              additionalProperties: false,
              properties: {
                label: {
                  type: "string",
                  maxLength: MAX_LABEL_GUIDE,
                  description:
                    "1-5 words. Append (Recommended) to the preferred option and put it first.",
                },
                description: {
                  type: "string",
                  maxLength: MAX_DESCRIPTION_LENGTH,
                  description: "What this choice means or costs.",
                },
                preview: {
                  type: "string",
                  maxLength: MAX_PREVIEW_LENGTH,
                  description:
                    "Optional markdown mockup of this option only. Do not paste other questions or options into it. Ignored for multiSelect.",
                },
              },
            },
          },
        },
      },
    },
  },
};

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** GLM-class models sometimes stringify a parameter. Restore arrays; leave prose alone. */
function restoreJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `input` is the tool-call arguments object, or a bare questions array.
 * Returns `{prose: true}` only when `questions` was a non-JSON string.
 */
function readQuestionList(input) {
  if (Array.isArray(input)) return { list: input };
  if (!isRecord(input)) return { list: undefined };
  const raw = input.questions;
  if (typeof raw === "string") {
    const parsed = restoreJsonArray(raw);
    return parsed ? { list: parsed } : { prose: true };
  }
  return { list: Array.isArray(raw) ? raw : undefined };
}

/** 非字符串字段一律拒绝：宿主按字符串渲染，`String(...)` 会把 42 / {} 悄悄变成答案文本。 */
function optionalText(value, field) {
  if (value === undefined || value === null) return { ok: true, text: "" };
  if (typeof value !== "string") return { ok: false, message: `Error: ${field} must be a string` };
  return { ok: true, text: value.trim() };
}

export function normalizeQuestions(input) {
  const { list, prose } = readQuestionList(input);
  if (prose) {
    return { ok: false, message: "Error: questions must be a function parameter array, not text" };
  }
  if (!Array.isArray(list) || list.length < 1) {
    return { ok: false, message: "Error: provide 1-4 questions" };
  }
  if (list.length > MAX_QUESTIONS) {
    return { ok: false, message: `Error: at most ${MAX_QUESTIONS} questions` };
  }

  const out = [];
  const questionTexts = new Set();
  for (const entry of list) {
    if (!isRecord(entry)) return { ok: false, message: "Error: invalid question" };
    if (typeof entry.question !== "string") {
      return { ok: false, message: "Error: question must be a string" };
    }
    const question = entry.question.trim();
    if (!question) return { ok: false, message: "Error: each question needs text" };
    if (question.length > MAX_QUESTION_LENGTH) {
      return {
        ok: false,
        message: `Error: question exceeds ${MAX_QUESTION_LENGTH} characters`,
      };
    }
    // 宿主以题目原文作 answers 记录的键：完全同文的两题会互相覆盖。大小写也一并拒绝，比宿主更严。
    const questionKey = question.toLowerCase();
    if (questionTexts.has(questionKey)) {
      return { ok: false, message: `Error: duplicate question ${JSON.stringify(question)}` };
    }
    questionTexts.add(questionKey);
    if (entry.multiSelect !== undefined && typeof entry.multiSelect !== "boolean") {
      return { ok: false, message: "Error: multiSelect must be a boolean" };
    }

    const rawOptions = restoreJsonArray(entry.options);
    if (!rawOptions || rawOptions.length < MIN_OPTIONS || rawOptions.length > MAX_OPTIONS) {
      return { ok: false, message: `Error: each question needs ${MIN_OPTIONS}-${MAX_OPTIONS} options` };
    }

    const multiSelect = entry.multiSelect === true;
    const options = [];
    const seen = new Set();
    for (const raw of rawOptions) {
      if (!isRecord(raw)) return { ok: false, message: "Error: invalid option" };
      if (typeof raw.label !== "string") {
        return { ok: false, message: "Error: option label must be a string" };
      }
      const label = raw.label.trim();
      if (!label) return { ok: false, message: "Error: option label required" };
      if (label.length > MAX_LABEL_LENGTH) {
        return { ok: false, message: `Error: option label exceeds ${MAX_LABEL_LENGTH} characters` };
      }
      if (RESERVED_LABELS.has(label.toLowerCase())) {
        return {
          ok: false,
          message: `Error: reserved label ${JSON.stringify(label)} - the host appends its own Type something. / Other / Next row`,
        };
      }
      const key = label.toLowerCase();
      if (seen.has(key)) {
        return { ok: false, message: `Error: duplicate option ${JSON.stringify(label)}` };
      }
      seen.add(key);
      const description = optionalText(raw.description, "option description");
      if (!description.ok) return { ok: false, message: description.message };
      if (description.text.length > MAX_DESCRIPTION_LENGTH) {
        return {
          ok: false,
          message: `Error: option description exceeds ${MAX_DESCRIPTION_LENGTH} characters`,
        };
      }
      // 与旧包一致：preview 是单选选项的示意稿，多选时不发送（选择组合无法对应单张示意）。
      // 注定被丢弃的字段不校验，否则模型会收到一条针对它根本没用的字段的报错。
      let preview = "";
      if (!multiSelect) {
        const rawPreview = optionalText(raw.preview, "option preview");
        if (!rawPreview.ok) return { ok: false, message: rawPreview.message };
        if (rawPreview.text.length > MAX_PREVIEW_LENGTH) {
          return {
            ok: false,
            message: `Error: option preview exceeds ${MAX_PREVIEW_LENGTH} characters`,
          };
        }
        preview = rawPreview.text;
      }
      options.push({
        label,
        ...(description.text ? { description: description.text } : {}),
        ...(preview ? { preview } : {}),
      });
    }

    const header = optionalText(entry.header, "header");
    if (!header.ok) return { ok: false, message: header.message };
    // 按码点切，不按 UTF-16 单元：emoji 被切成半个代理对会变成非法字符。
    const chip = [...header.text].slice(0, MAX_HEADER_LENGTH).join("");
    out.push({
      question,
      options,
      ...(chip ? { header: chip } : {}),
      ...(multiSelect ? { multiSelect: true } : {}),
    });
  }

  // 预览里若出现另一道题的原文，那是参数串味，不是示意稿。
  const siblings = out.map((item) => item.question);
  for (const item of out) {
    for (const option of item.options) {
      if (
        option.preview &&
        siblings.some(
          (text) => text !== item.question && text.length >= 6 && option.preview.includes(text),
        )
      ) {
        delete option.preview;
      }
    }
  }

  // 逐字段都合法也可能整帧超宿主上限：宿主按字节杀整行，这里先报可修的错。
  const bytes = Buffer.byteLength(JSON.stringify(out), "utf8");
  if (bytes > MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      message: `Error: questionnaire is ${bytes} bytes; the host accepts at most ${MAX_PAYLOAD_BYTES}`,
    };
  }

  return { ok: true, questions: out };
}

function optionLabels(question) {
  return Array.isArray(question?.options) ? question.options.map((option) => option.label) : [];
}

function previewForLabels(question, labels) {
  if (!question || !Array.isArray(labels) || labels.length === 0) return undefined;
  for (const label of labels) {
    const match = question.options?.find((option) => option.label === label);
    if (match?.preview) return match.preview;
  }
  return undefined;
}

function findQuestion(questions, text) {
  return Array.isArray(questions) ? questions.find((item) => item.question === text) : undefined;
}

function stringParts(raw) {
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []));
  }
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  return [];
}

/**
 * 多选文本是 UI 用 `", "` 拼出来的（先选项、后自定义）。只把开头连续匹配选项标签的
 * 片段算作 selected；余下的是自定义输入。标签自身含 `", "` 时无法区分，按自定义处理。
 * 这条路径只用于记录式应答；索引化数组是原子值，见 `answerFromArray`。
 */
function splitMultiSelect(question, text) {
  const labels = optionLabels(question);
  const chunks = text.split(", ");
  const selected = [];
  let index = 0;
  while (index < chunks.length && labels.includes(chunks[index])) {
    if (!selected.includes(chunks[index])) selected.push(chunks[index]);
    index += 1;
  }
  const custom = chunks.slice(index).join(", ").trim();
  return { selected, custom };
}

/**
 * `answer_<i>` 的数组元素是宿主的原子值：选项标签和自定义文本各自一项。
 * 这里不能把它当拼接串再按 `, ` 切开，否则自定义文本里的逗号会变成假选项。
 */
function answerFromArray(question, parts) {
  const labels = optionLabels(question);
  const answer = parts.join(", ");
  if (question?.multiSelect) {
    const selected = [];
    const customParts = [];
    for (const part of parts) {
      if (labels.includes(part)) {
        if (!selected.includes(part)) selected.push(part);
      } else {
        customParts.push(part);
      }
    }
    return {
      question: question.question,
      answer,
      custom: customParts.length > 0,
      ...(selected.length > 0 ? { selected } : {}),
    };
  }
  const matched = labels.includes(answer);
  const preview = matched ? previewForLabels(question, [answer]) : undefined;
  return {
    question: question.question,
    answer,
    custom: !matched,
    ...(preview ? { preview } : {}),
  };
}

function answerFromText(question, text) {
  if (question?.multiSelect) {
    const { selected, custom } = splitMultiSelect(question, text);
    return {
      question: question.question,
      answer: text,
      custom: custom.length > 0,
      ...(selected.length > 0 ? { selected } : {}),
    };
  }
  const matched = optionLabels(question).includes(text);
  const preview = matched ? previewForLabels(question, [text]) : undefined;
  return {
    question: question.question,
    answer: text,
    custom: !matched,
    ...(preview ? { preview } : {}),
  };
}

function normalizeStructuredAnswer(item, questions) {
  if (!isRecord(item)) return [];
  const questionText = typeof item.question === "string" ? item.question.trim() : "";
  const question = findQuestion(questions, questionText);
  const answer = typeof item.answer === "string" ? item.answer.trim() : "";
  const selected = Array.isArray(item.selected)
    ? item.selected.flatMap((value) => (typeof value === "string" && value.trim() ? [value.trim()] : []))
    : [];
  if (!questionText && !answer && selected.length === 0) return [];
  const ownPreview =
    typeof item.preview === "string" && item.preview.trim() ? item.preview.trim() : undefined;
  const preview =
    ownPreview ??
    previewForLabels(question, selected.length > 0 ? selected : answer ? [answer] : []);
  const notes = typeof item.notes === "string" && item.notes.trim() ? item.notes.trim() : undefined;
  return [
    {
      question: questionText || (question?.question ?? ""),
      answer,
      custom: item.custom === true,
      ...(selected.length > 0 ? { selected } : {}),
      ...(preview ? { preview } : {}),
      ...(notes ? { notes } : {}),
    },
  ];
}

function looksLikeAskContent(value) {
  if (!isRecord(value)) return false;
  if (Array.isArray(value.answers) || isRecord(value.answers)) return true;
  if (typeof value.answer === "string") return true;
  return Object.keys(value).some((key) => key.startsWith("answer_"));
}

/**
 * 宿主 `ports.ask` 返回 `{ answers: response.content }`，而 `content` 自己又带 `answers`
 * 记录，所以线上结果通常是两层：`{answers:{answers:{...},answer_0:...}}`。
 * 这里同时接受嵌套内容对象、扁平记录和数组形式。
 */
function unwrapAnswerPayload(response) {
  if (isRecord(response) && isRecord(response.answers) && looksLikeAskContent(response.answers)) {
    return response.answers;
  }
  return response;
}

function recordAnswers(payload, questions) {
  const record = isRecord(payload.answers) ? payload.answers : {};
  const answers = [];
  questions.forEach((question, index) => {
    const indexed = payload[`answer_${index}`];
    // 索引化应答优先：数组是宿主的原子值，记录里的 `", "` 拼接无法区分自定义文本含逗号。
    if (Array.isArray(indexed)) {
      const parts = stringParts(indexed);
      if (parts.length > 0) {
        answers.push(answerFromArray(question, parts));
        return;
      }
    } else if (typeof indexed === "string") {
      const text = indexed.trim();
      if (text) {
        answers.push(answerFromText(question, text));
        return;
      }
    }
    const byText = record[question.question];
    const fallback = byText !== undefined ? byText : questions.length === 1 ? payload.answer : undefined;
    const text = stringParts(fallback).join(", ");
    // 缺答案的题不补、不猜，避免给模型伪造用户偏好。
    if (!text) return;
    answers.push(answerFromText(question, text));
  });
  return answers;
}

export function parseAskResponse(response, questions) {
  if (!isRecord(response)) return { cancelled: false, answers: [] };
  if (response.cancelled === true) return { cancelled: true, answers: [] };
  const payload = unwrapAnswerPayload(response);
  if (Array.isArray(payload.answers)) {
    return {
      cancelled: false,
      answers: payload.answers.flatMap((item) => normalizeStructuredAnswer(item, questions)),
    };
  }
  if (!Array.isArray(questions)) return { cancelled: false, answers: [] };
  return { cancelled: false, answers: recordAnswers(payload, questions) };
}

export function formatAskResult(result) {
  if (result.cancelled) return "User declined to answer questions";
  const parts = result.answers.map((answer) => {
    // `answer` 已经包含自定义文本；只用 selected 会丢掉用户手写的那部分。
    const value = answer.answer || answer.selected?.join(", ") || "(no input)";
    const bits = [`"${answer.question}"="${value}"`];
    if (answer.preview) bits.push(`selected preview: ${answer.preview}`);
    if (answer.notes) bits.push(`user notes: ${answer.notes}`);
    return `${bits.join(". ")}.`;
  });
  if (result.globalNote) parts.push(`global note: ${result.globalNote}.`);
  // accept + 空 answers 是宿主的显式成功语义，不能和「用户取消」混为一谈。
  if (parts.length === 0) return "User submitted no answers; continue with your best judgment.";
  return `User has answered your questions: ${parts.join(" ")} You can now continue with the user's answers in mind.`;
}