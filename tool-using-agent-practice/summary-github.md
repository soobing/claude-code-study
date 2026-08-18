## Soobing's Summary

Claude Code = **Claude 모델 + 하네스**

- 모델은 “다음에 뭘 할까”만 답하고, 실행·기억·안전장치는 전부 하네스가 한다.

하네스 역할을 하는 “Claude Code”를 간단히 구현해보면서 에이전트 루프가 어떻게 실행 되는지 구체적으로 이해할 수 있었다.

<details>
<summary>mini-claude-code.ts 코드</summary>

```ts
// 미니 Claude Code — 링 2 루프 + 하네스 전체 계층
//
// 심장은 여전히 링 2의 while 루프다. 그 주변에 Claude Code가 얹는 것들을
// 하나씩 최소 구현으로 붙였다:
//
//   ① 권한 검사      Shift+Tab 모드 / settings.json
//   ② 체크포인트     Esc Esc 로 되돌리기
//   ③ hooks          PreToolUse / PostToolUse
//   ④ skills         설명만 상시 로드, 본문은 쓸 때만
//   ⑤ MCP            외부 프로세스가 공급하는 도구
//   ⑥ subagent       별도 컨텍스트에서 돌고 요약만 반환
//   ⑦ 압축           컨텍스트가 차면 옛 대화를 요약으로 교체
//   ⑧ 세션 저장      JSONL 기록
//   ⑨ 인터럽트       Esc
//
// 실행:  npm run mini -- "src 구조 보고 README 만들어줘"
//        USE_MCP=1 npm run mini -- "지금 몇 시야?"

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import readline from "node:readline/promises";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Anthropic();
const WORKDIR = process.cwd();
const MODEL = "claude-opus-5";
const SYSTEM_BASE = `당신은 코딩 어시스턴트입니다. 작업 디렉토리는 ${WORKDIR} 입니다.`;

// ════════════════════════════════════════════════════════════════════
// ③ HOOKS — 모델의 판단과 무관하게 하네스가 강제로 실행하는 계층
//    skills/MCP와의 결정적 차이: 모델이 고르는 게 아니라 항상 돈다.
// ════════════════════════════════════════════════════════════════════
type PreHook = (tool: string, input: any) => string | void; // string 반환 = 차단
type PostHook = (tool: string, input: any, result: string) => void;

const preToolUseHooks: PreHook[] = [
  // 위험한 명령을 모델 의지와 무관하게 차단한다
  (tool, input) => {
    if (tool === "Bash" && /\brm\s+-[rf]/.test(input.command ?? "")) {
      return "차단됨: rm -rf 계열 명령은 hook이 금지합니다.";
    }
  },
];

const postToolUseHooks: PostHook[] = [
  // 편집된 파일을 자동 정리 (실전에선 prettier 등)
  (tool, input) => {
    if (tool === "Write" || tool === "Edit") {
      console.log(`   [hook] ${input.file_path} 저장 감지 — 포맷터 자리`);
    }
  },
];

// ════════════════════════════════════════════════════════════════════
// ④ SKILLS — 설명만 시스템 프롬프트에 상시, 본문은 Skill 도구로 로드
//    /context 에서 "17 skills · 2.1k tokens" 로 보이던 게 이 구조다.
// ════════════════════════════════════════════════════════════════════
const SKILLS: Record<string, { description: string; body: string }> = {
  "readme-style": {
    description: "README를 작성하거나 수정할 때의 이 팀 표준 형식",
    body: [
      "# README 작성 규칙",
      "1. 첫 줄은 프로젝트명(H1), 그 아래 한 줄 요약.",
      "2. '## 시작하기' 섹션에 설치/실행 명령을 코드블록으로.",
      "3. 이모지는 쓰지 않는다.",
      "4. 파일 목록은 표가 아니라 트리 형태로 적는다.",
    ].join("\n"),
  },
};

// 세션 시작 시 "이름 + 설명"만 주입한다 (본문은 아직 컨텍스트에 없음)
const skillCatalog = Object.entries(SKILLS)
  .map(([name, s]) => `- ${name}: ${s.description}`)
  .join("\n");

// ════════════════════════════════════════════════════════════════════
// ① 도구 정의 — 내장 도구 + Skill + Agent(subagent)
// ════════════════════════════════════════════════════════════════════
const builtinTools: Anthropic.Tool[] = [
  {
    name: "Read",
    description: "파일 내용을 읽는다.",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
  {
    name: "Write",
    description: "파일을 생성하거나 통째로 덮어쓴다. 기존 파일 일부만 고칠 때는 Edit을 쓸 것.",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" }, content: { type: "string" } },
      required: ["file_path", "content"],
    },
  },
  {
    name: "Edit",
    description:
      "파일에서 old_string을 new_string으로 정확히 한 번 치환한다. " +
      "파일 전체를 다시 쓰지 않으므로 토큰이 적게 들고 다른 부분을 망가뜨리지 않는다.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: "Grep",
    description: "정규식으로 파일 내용을 검색한다.",
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"],
    },
  },
  {
    name: "Bash",
    description: "셸 명령을 실행한다.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "Skill",
    description: `참고 문서를 로드한다. 사용 가능:\n${skillCatalog}`,
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "Agent",
    description:
      "독립된 하위 작업을 별도 컨텍스트에서 처리시킨다. " +
      "탐색처럼 파일을 많이 읽어야 하는 작업에 쓰면 주 대화가 깨끗하게 유지된다. " +
      "중간 과정은 돌아오지 않고 최종 요약만 반환된다.",
    input_schema: {
      type: "object",
      properties: { task: { type: "string", description: "하위 에이전트에게 줄 지시" } },
      required: ["task"],
    },
  },
];

// ════════════════════════════════════════════════════════════════════
// ⑤ MCP — 외부 프로세스가 공급하는 도구를 tools 배열에 합친다
//    모델 입장에선 내장 도구와 구별되지 않는다.
// ════════════════════════════════════════════════════════════════════
let mcp: McpClient | null = null;
let mcpTools: Anthropic.Tool[] = [];

if (process.env.USE_MCP === "1") {
  mcp = new McpClient({ name: "mini-claude-code", version: "1.0.0" });
  await mcp.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", path.join(WORKDIR, "mcp-server-demo.ts")],
    }),
  );
  const listed = await mcp.listTools();
  // MCP 도구 이름은 충돌을 피하려 접두사를 붙인다 (Claude Code의 mcp__server__tool 규칙)
  mcpTools = listed.tools.map((t) => ({
    name: `mcp__demo__${t.name}`,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
  console.log(`🔌 MCP 연결됨 — 도구 ${mcpTools.length}개: ${mcpTools.map((t) => t.name).join(", ")}`);
}

const tools = [...builtinTools, ...mcpTools];

// ════════════════════════════════════════════════════════════════════
// ① 권한 · ② 체크포인트 · ⑧ 세션 저장
// ════════════════════════════════════════════════════════════════════
const AUTO_ALLOW = new Set(["Read", "Grep", "Skill", "Agent"]); // 읽기 전용은 안 물음

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function checkPermission(name: string, input: any): Promise<boolean> {
  if (AUTO_ALLOW.has(name) || name.startsWith("mcp__")) return true;
  const preview = name === "Bash" ? input.command : input.file_path;
  const answer = await rl.question(`\n  ⚠️  ${name}(${preview}) 실행할까요? [y/N] `);
  return answer.trim().toLowerCase() === "y";
}

const checkpoints: Array<{ file: string; before: string | null }> = [];

function snapshot(file: string) {
  checkpoints.push({
    file,
    before: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null,
  });
}

function rollbackAll() {
  for (const cp of [...checkpoints].reverse()) {
    if (cp.before === null) fs.rmSync(cp.file, { force: true });
    else fs.writeFileSync(cp.file, cp.before);
  }
  console.log(`\n↩️  ${checkpoints.length}개 파일 되돌림`);
}

const SESSION_FILE = `session-${Date.now()}.jsonl`;
const log = (entry: unknown) =>
  fs.appendFileSync(SESSION_FILE, JSON.stringify(entry) + "\n");

// ════════════════════════════════════════════════════════════════════
// ③ 도구 구현 — 에이전트가 아닌 부분. 그냥 평범한 함수들.
// ════════════════════════════════════════════════════════════════════
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR + path.sep) && resolved !== WORKDIR) {
    throw new Error(`작업 디렉토리 밖입니다: ${p}`);
  }
  return resolved;
}

async function runTool(name: string, input: any, depth: number): Promise<string> {
  // MCP 도구는 외부 프로세스로 위임
  if (name.startsWith("mcp__demo__")) {
    const res = await mcp!.callTool({
      name: name.replace("mcp__demo__", ""),
      arguments: input,
    });
    return (res.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }

  switch (name) {
    case "Read":
      return fs.readFileSync(safePath(input.file_path), "utf8");

    case "Write": {
      const target = safePath(input.file_path);
      snapshot(target); // 체크포인트: 바꾸기 전에 찍는다
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, input.content);
      return `${input.file_path} 작성 완료 (${input.content.length}자)`;
    }

    case "Edit": {
      const target = safePath(input.file_path);
      const before = fs.readFileSync(target, "utf8");
      const hits = before.split(input.old_string).length - 1;
      // 정확히 한 번만 매칭될 때만 허용 — 0개면 못 찾은 것, 2개 이상이면 어디를 고칠지 모호
      if (hits === 0) throw new Error(`old_string을 찾지 못했습니다.`);
      if (hits > 1) throw new Error(`old_string이 ${hits}곳에서 발견됨. 더 길게 지정하세요.`);
      snapshot(target);
      fs.writeFileSync(target, before.replace(input.old_string, input.new_string));
      return `${input.file_path} 1곳 수정 완료`;
    }

    case "Grep":
      return execSync(
        `grep -rn ${JSON.stringify(input.pattern)} ${JSON.stringify(safePath(input.path ?? "."))}`,
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
      );

    case "Bash":
      return execSync(input.command, { cwd: WORKDIR, encoding: "utf8", maxBuffer: 1024 * 1024 });

    // ④ skill 본문을 "지금" 컨텍스트에 넣는다 (그 전까지는 설명만 있었다)
    case "Skill": {
      const skill = SKILLS[input.name];
      if (!skill) throw new Error(`그런 skill이 없습니다: ${input.name}`);
      console.log(`   [skill] ${input.name} 본문 로드 (${skill.body.length}자)`);
      return skill.body;
    }

    // ⑥ subagent — 새 messages 배열로 루프를 한 벌 더 돌리고 요약만 반환
    case "Agent": {
      if (depth >= 1) throw new Error("subagent는 중첩할 수 없습니다.");
      console.log(`   [subagent] 시작: ${input.task}`);
      const sub = await runLoop(
        [{ role: "user", content: input.task }],
        `${SYSTEM_BASE}\n당신은 하위 에이전트입니다. 작업을 마치면 결과를 간결히 요약하세요.`,
        depth + 1,
      );
      const text = sub.content.find((b) => b.type === "text");
      console.log(`   [subagent] 종료 — 요약만 주 대화로 반환`);
      // ★ 중간 도구 호출들은 sub 안에서 소멸한다. 주 대화 컨텍스트는 이 한 줄만 받는다.
      return text?.type === "text" ? text.text : "(결과 없음)";
    }

    default:
      throw new Error(`알 수 없는 도구: ${name}`);
  }
}

// ════════════════════════════════════════════════════════════════════
// ⑦ 압축 — 컨텍스트가 차면 옛 대화를 요약 한 덩어리로 교체
//
//    ★ 중요: 아무 데서나 자르면 안 된다.
//      assistant(tool_use) 와 user(tool_result) 는 짝이라서 그 사이를 자르면 400.
//      우리 루프는 항상 2개씩 push 하므로 배열은 [user, (a,u), (a,u), ...] 구조 →
//      홀수 인덱스에서 자르면 짝이 유지된다.
// ════════════════════════════════════════════════════════════════════
const COMPACT_THRESHOLD = 30_000; // 실전 Claude Code는 컨텍스트 한계 근처에서 발동

async function compact(messages: Anthropic.MessageParam[]): Promise<Anthropic.MessageParam[]> {
  const KEEP_PAIRS = 2;
  const cut = messages.length - KEEP_PAIRS * 2;
  if (cut < 3) return messages; // 자를 게 없음

  const older = messages.slice(0, cut);
  const recent = messages.slice(cut);

  console.log(`\n🗜  압축 실행 — 앞쪽 ${older.length}개 메시지를 요약으로 교체`);

  // 요약도 API 호출이다 (도구 없이)
  const summary = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      ...older,
      {
        role: "user",
        content:
          "지금까지의 작업을 요약해줘. 사용자의 원래 요청, 확인한 사실, " +
          "수정한 파일, 남은 할 일을 빠뜨리지 말 것. 요약만 출력.",
      },
    ],
  });
  const text = summary.content.find((b) => b.type === "text");

  return [
    {
      role: "user",
      content: `<이전 대화 요약>\n${text?.type === "text" ? text.text : ""}\n</이전 대화 요약>`,
    },
    ...recent,
  ];
}

// ════════════════════════════════════════════════════════════════════
// ② 에이전트 루프 — 링 2의 while 문. 주 대화와 subagent가 공유한다.
// ════════════════════════════════════════════════════════════════════
let interrupted = false;

async function runLoop(
  messages: Anthropic.MessageParam[],
  systemPrompt: string,
  depth: number,
): Promise<Anthropic.Message> {
  const indent = "  ".repeat(depth);

  let response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    tools,
    messages,
  });

  while (response.stop_reason === "tool_use" && !interrupted) {
    // ── 링 3: tool_use 블록을 "전부" 순회 (병렬 호출 대응) ──────────
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        console.log(`\n${indent}💬 ${block.text}`);
        continue;
      }
      if (block.type !== "tool_use") continue;

      console.log(`\n${indent}🔧 ${block.name}  ${JSON.stringify(block.input).slice(0, 90)}`);

      // ③ PreToolUse hook — 모델 판단보다 위. 차단하면 실행 자체가 없다.
      const blocked = preToolUseHooks.map((h) => h(block.name, block.input)).find(Boolean);
      if (blocked) {
        console.log(`${indent}   [hook] ${blocked}`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: blocked,
          is_error: true,
        });
        continue;
      }

      // ① 권한 검사
      if (!(await checkPermission(block.name, block.input))) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "사용자가 이 작업을 거부했습니다. 다른 방법을 시도하세요.",
          is_error: true,
        });
        continue;
      }

      // ── 링 4: 실패해도 죽지 않는다 ────────────────────────────────
      try {
        const result = await runTool(block.name, block.input, depth);
        postToolUseHooks.forEach((h) => h(block.name, block.input, result)); // ③ PostToolUse
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id, // ← 짝맞추기: 반드시 tool_use.id와 일치
          content: result.slice(0, 20_000),
        });
      } catch (e) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: e instanceof Error ? e.message : String(e),
          is_error: true, // ← 모델이 읽고 스스로 다른 방법을 찾는다
        });
      }
    }

    // ── 링 1~2: 결과 왕복 ─────────────────────────────────────────
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    if (depth === 0) {
      log({ type: "assistant", content: response.content });
      log({ type: "tool_results", content: toolResults });
    }

    // ⑦ 압축 — 주 대화에서만. subagent는 어차피 짧게 살다 죽는다.
    const used =
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0);
    console.log(`${indent}   [컨텍스트 ${used.toLocaleString()} 토큰]`);

    if (depth === 0 && used > COMPACT_THRESHOLD) {
      messages = await compact(messages);
    }

    response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });
  }

  return response;
}

// ════════════════════════════════════════════════════════════════════
// 진입점
// ════════════════════════════════════════════════════════════════════
const userPrompt = process.argv.slice(2).join(" ") || "이 폴더에 어떤 파일이 있는지 알려줘";

// ⑨ 인터럽트 (Claude Code의 Esc)
process.on("SIGINT", () => {
  interrupted = true;
  console.log("\n⏹  중단 요청됨 — 현재 턴까지만 처리합니다");
});

log({ type: "user", content: userPrompt });

// ④ skills는 "설명만" 시스템 프롬프트로. 본문은 Skill 도구를 부를 때 들어온다.
const systemPrompt = `${SYSTEM_BASE}

<available_skills>
${skillCatalog}
</available_skills>
관련 작업을 할 때는 Skill 도구로 해당 문서를 먼저 읽으세요.`;

const final = await runLoop([{ role: "user", content: userPrompt }], systemPrompt, 0);

for (const block of final.content) {
  if (block.type === "text") console.log(`\n✅ ${block.text}`);
}
console.log(`\n📝 세션 기록: ${SESSION_FILE}`);

if (checkpoints.length > 0) {
  const undo = await rl.question(`\n되돌릴까요? (${checkpoints.length}개 파일) [y/N] `);
  if (undo.trim().toLowerCase() === "y") rollbackAll();
}
rl.close();
await mcp?.close();
```

</details>

에이전트 루프의 실체는 `while` 문으로, 모델은 **루프 안에서 매번 새로 불려나와** 한 번씩 판단만 한다.

```ts
while (response.stop_reason === "tool_use") {
  const toolResult = runTool(...)                                   // 하네스가 실행
  messages.push({ role: "assistant", content: response.content })   // 받은 걸 되돌려보냄
  messages.push({ role: "user", content: [toolResult] })            // 결과를 덧붙임
  response = await client.messages.create({ messages, tools })      // 전체 재전송
}
```

또한 이 루프가 실행되면서 **내장 도구**와 **확장**을 활용하며 아래와 같은 4개의 계층을 이루어 더 똑똑하게 작업을 처리할 수 있도록 활용한다는 것을 알았다.

| | | |
| --- | --- | --- |
| Layer4 | skills / MCP / subagent | ← 확장 (모델이 고름) |
| Layer3 | Read, Edit, Bash, Grep, WebSearch, … | ← 내장 도구 (모델이 고름) |
| Layer2 | Agent Loop + 권한 · 체크포인트 · 압축 · 세션 · **hooks** | ← 하네스 (모델 관여 불가) |
| Layer1 | Claude 모델 (추론만) | |

또한 hooks는 확장이 아니라 하네스(Layer2) 소속으로 모델 판단을 거치지 않는다는 것을 알았다.

- skills - “아는 것”을 확장 (지식)
  - 빌트인 스킬과 사용자 생성 스킬이 있음.
  - ex) 빌트인 스킬 중 하나인 `dataviz` 과 같은 경우 차트를 그려달라고 했을때 사용
  - 모델이 판단해서 실행하기도 하고, 슬래시 커맨드로 직접 호출도 가능
- MCP - “닿는 곳”을 외부로 확장
  - 내장 도구로는 내 컴퓨터와 웹까지만 접근 권한이 있음
  - 외부 앱(Notion, Gmail, …)을 접근하기 위해 필요
- subagent - “일손” 확장
  - 별도 컨텍스트를 가진 Claude를 띄워서 작업 후 결과 요약만 받음.
  - subagent만 예외적으로 **루프를 하나 더 만듦.**
- hooks - “자동으로” 실행
  - skills, MCP, subagent는 Claude가 판단해서 사용.
  - 그러나, **하네스 레벨**에 걸어두면 **모델 판단 없이** 매처(matcher)에 걸리는 이벤트에서 실행 됨
