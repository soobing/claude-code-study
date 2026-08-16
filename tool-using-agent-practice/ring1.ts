// 링 1: 도구 하나, 턴 하나.
//
// 가장 기본 구조. 루프 없음. API를 정확히 두 번 호출한다.
//   1차 호출: 사용자 요청 + 도구 정의  →  Claude가 "이 도구 써줘"라고 답함
//   2차 호출: 위 대화 + 도구 실행 결과 →  Claude가 최종 자연어 답변을 만듦

import Anthropic from "@anthropic-ai/sdk";

// 클라이언트 생성. 환경에서 ANTHROPIC_API_KEY를 읽어온다.
const client = new Anthropic();

// 도구 하나를 정의한다. input_schema는 Claude가 이 도구를 호출할 때
// 전달해야 하는 인수를 설명하는 JSON Schema 객체다. 이 스키마는
// 중첩 객체(recurrence), 배열(attendees), 선택적 필드를 포함하므로
// 단순한 문자열 인수보다 실제 도구에 더 가깝다.
const tools: Anthropic.Tool[] = [
  {
    name: "create_calendar_event",
    description: "Create a calendar event with attendees and optional recurrence.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", format: "date-time" },
        end: { type: "string", format: "date-time" },
        attendees: {
          type: "array",
          items: { type: "string", format: "email" },
        },
        recurrence: {
          type: "object",
          properties: {
            frequency: { enum: ["daily", "weekly", "monthly"] },
            count: { type: "integer", minimum: 1 },
          },
        },
      },
      required: ["title", "start", "end"],
    },
  },
];

const userMessage =
  "Schedule a 30-minute sync with alice@example.com and bob@example.com " +
  "on Monday, March 30, 2026 at 10am.";

// ── 1차 호출 ────────────────────────────────────────────────────────────
// 사용자의 요청을 도구 정의와 함께 전송한다. Claude는 요청과
// 도구 설명을 바탕으로 도구 호출 여부를 결정한다.
const response = await client.messages.create({
  model: "claude-opus-5",
  max_tokens: 1024,
  tools,
  tool_choice: { type: "auto", disable_parallel_tool_use: true },
  messages: [{ role: "user", content: userMessage }],
});

// Claude가 도구를 호출하면 응답의 stop_reason은 "tool_use"이고
// content 배열에는 텍스트와 함께 tool_use 블록이 포함된다.
console.log(`stop_reason: ${response.stop_reason}`);

// tool_use 블록을 찾는다. 응답에는 tool_use 블록 앞에 텍스트 블록이
// 있을 수 있으므로 위치를 가정하지 말고 content 배열을 순회할 것.
const toolUse = response.content.find(
  (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
);
if (!toolUse) throw new Error("도구 호출이 없습니다");

console.log(`Tool: ${toolUse.name}`);
console.log(`Input: ${JSON.stringify(toolUse.input)}`);

// 도구를 실행한다. 실제 시스템에서는 캘린더 API를 호출하게 된다.
// 여기서는 예제를 독립적으로 유지하기 위해 결과를 하드코딩했다.
const result = { event_id: "evt_123", status: "created" };

// ── 2차 호출 ────────────────────────────────────────────────────────────
// 결과를 다시 전송한다. tool_result 블록은 user 메시지에 들어가며
// 그 tool_use_id는 위 tool_use 블록의 id와 일치해야 한다. Claude가
// 전체 히스토리를 갖도록 어시스턴트의 이전 응답도 포함한다.
const followup = await client.messages.create({
  model: "claude-opus-5",
  max_tokens: 1024,
  tools,
  tool_choice: { type: "auto", disable_parallel_tool_use: true },
  messages: [
    { role: "user", content: userMessage },
    { role: "assistant", content: response.content },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        },
      ],
    },
  ],
});

// 도구 결과를 받은 Claude는 최종 자연어 답변을 생성하고
// stop_reason은 "end_turn"이 된다.
console.log(`stop_reason: ${followup.stop_reason}`);
const finalText = followup.content.find(
  (block): block is Anthropic.TextBlock => block.type === "text",
);
console.log(finalText?.text);
