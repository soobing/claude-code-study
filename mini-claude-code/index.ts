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
//   ⑩ 컨텍스트 초기 로드  타이핑 전에 이미 쌓이는 것들 + 실측 토큰 브레이크다운
//   ⑪ tool search    MCP 스키마를 이름만 노출하고 실제 필요할 때 지연 로드
//   ⑫ 압축 후 skill 재주입  설명 목록은 사라지고, 호출했던 스킬 본문만 캡 걸고 재주입
//   ⑬ disable-model-invocation  부작용 있는 스킬은 모델이 못 부름, /이름으로 사용자만 직접 호출
//   ⑭ 프롬프트 캐싱   system/tools/messages 각 계층 끝에 중단점을 찍어 프리픽스를 캐싱,
//                     턴마다 cache_read/cache_creation 실측치를 출력
//   ⑮ 플러그인        콘텐츠형(스킬/명령) vs MCP 제공형 — 캐시 영향이 다른 이유를
//                     ④ SKILLS · ⑤ MCP 경로에 그대로 매핑해 대조
//   ⑯ CLAUDE.md 계층   관리 정책 → 사용자 → 프로젝트(디렉토리 트리 순회, 상위가 먼저)
//                     → 로컬(CLAUDE.local.md), @import 확장, HTML 주석 제거, claudeMdExcludes
//   ⑰ .claude/rules/  paths frontmatter 없으면 무조건 로드, 있으면 Read가 그 파일을
//                     건드리는 순간에만 지연 주입(하위 디렉토리 CLAUDE.md도 동일한 경로)
//   ⑱ 자동 메모리 경로 git 저장소 기준 projects/<slug>/memory/, autoMemoryDirectory로 재정의,
//                     autoMemoryEnabled(CLAUDE_CODE_DISABLE_AUTO_MEMORY)로 끄기
//   ⑲ /memory 명령    API 호출 없이 로드된 CLAUDE.md/규칙/메모리 파일 목록만 출력하고 종료
//   ⑳ 압축 후 재로드   /compact 후 CLAUDE.md·규칙·자동 메모리를 디스크에서 통째로 다시 읽어
//                     시스템 프롬프트를 재구성 — 하위 디렉토리/경로별 규칙은 지연 상태로 리셋
//
// 실행:  npm run mini -- "src 구조 보고 README 만들어줘"
//        USE_MCP=1 npm run mini -- "지금 몇 시야?"                     (기본값 = 지연 로드)
//        USE_MCP=1 ENABLE_TOOL_SEARCH=false npm run mini -- "..."     (즉시 전부 로드)
//        USE_MCP=1 ENABLE_TOOL_SEARCH=auto npm run mini -- "..."      (10% 임계값으로 자동 판단)
//        npm run mini -- "/commit-push 지금까지 변경사항 커밋해줘"        (사용자 직접 호출)
//        npm run mini -- "/memory"                                    (로드된 CLAUDE.md/규칙/메모리 나열, API 호출 없음)
//        DISABLE_PROMPT_CACHING=1 npm run mini -- "..."               (캐싱 끄고 비교)
//        ENABLE_PROMPT_CACHING_1H=1 npm run mini -- "..."             (1시간 TTL 요청)
//        ENABLE_PROMPT_CACHING_1H=1 FORCE_PROMPT_CACHING_5M=1 npm run mini -- "..."  (로컬이 관리 설정을 재정의)
//        AUTO_MEMORY_DIRECTORY=~/custom-memory npm run mini -- "..."  (자동 메모리 저장 위치 재정의)
//        CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 npm run mini -- "..."      (자동 메모리 끄기)
//        CLAUDE_MD_EXCLUDES="**/legacy/CLAUDE.md" npm run mini -- "..."  (특정 CLAUDE.md 제외)

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import readline from "node:readline/promises";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Anthropic();
const WORKDIR = process.cwd();
const MODEL = "claude-sonnet-5";
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
//
// ⑬ disable-model-invocation — 커밋/배포/메시지 전송처럼 부작용이 있는
//    스킬은 모델이 스스로 판단해서 부르면 안 된다. 그런 스킬은
//    disableModelInvocation: true를 달아서 skillCatalog(설명 목록)와
//    모델의 Skill 도구 호출 모두에서 제외하고, 사용자가 /이름으로
//    직접 호출했을 때만 로드되게 한다.
// ════════════════════════════════════════════════════════════════════
const SKILLS: Record<string, { description: string; body: string; disableModelInvocation?: boolean }> = {
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
  "commit-push": {
    description: "변경사항을 커밋하고 push한다 (부작용 있음 — 모델이 스스로 호출 불가)",
    disableModelInvocation: true,
    body: [
      "# 커밋 & 푸시 규칙",
      "1. git status로 변경사항을 확인한다.",
      "2. 의미 있는 단위로 파일을 나눠서 git add 한다.",
      "3. 커밋 메시지는 '무엇을'이 아니라 '왜'를 설명한다.",
      "4. git push origin <현재 브랜치>로 push한다.",
    ].join("\n"),
  },
};

// 세션 시작 시 "이름 + 설명"만 주입한다 (본문은 아직 컨텍스트에 없음).
// ⑬ disableModelInvocation 스킬은 여기서 걸러져서 모델이 존재 자체를 모른다.
const skillCatalog = Object.entries(SKILLS)
  .filter(([, s]) => !s.disableModelInvocation)
  .map(([name, s]) => `- ${name}: ${s.description}`)
  .join("\n");

// 초기 시스템 프롬프트에 들어가는 "설명 목록" 블록. ⑫에서 압축 후 이 블록을
// 통째로 제거하기 위해 정확히 같은 문자열을 재사용할 수 있도록 모듈 상수로 뺐다.
const skillCatalogBlock = `<available_skills>\n${skillCatalog}\n</available_skills>\n관련 작업을 할 때는 Skill 도구로 해당 문서를 먼저 읽으세요.`;

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
// ⑤ MCP — 외부 프로세스가 공급하는 도구. 모델 입장에선 내장 도구와
//    구별되지 않지만, 스키마를 tools 배열에 언제 올릴지는 아래 ⑪에서 결정한다.
// ════════════════════════════════════════════════════════════════════
let mcp: McpClient | null = null;
let mcpTools: Anthropic.Tool[] = []; // MCP가 제공하는 전체 도구 목록 — "지연 저장고"

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
  console.log(`🔌 MCP 연결됨 — 도구 ${mcpTools.length}개 발견: ${mcpTools.map((t) => t.name).join(", ")}`);
}

// ════════════════════════════════════════════════════════════════════
// ⑪ TOOL SEARCH — MCP 스키마를 언제 tools 배열에 실을지 결정한다.
//
//    실제 Claude Code 기본값: 이름만 시스템 프롬프트에 노출하고, 전체
//    스키마는 지연 상태로 두었다가 모델이 tool search로 필요한 것만
//    그때그때 불러온다. 아래 세 모드를 흉내낸다:
//
//      (미설정/기본)      → 지연. ToolSearch 메타 도구만 등록, MCP 스키마는 0개 상태로 시작.
//      ENABLE_TOOL_SEARCH=auto  → 전체 스키마가 컨텍스트의 10% 안에 들면 즉시 로드, 아니면 지연.
//      ENABLE_TOOL_SEARCH=false → 무조건 즉시 전부 로드 (지연 없음).
// ════════════════════════════════════════════════════════════════════
const CONTEXT_WINDOW = 200_000; // Sonnet 5 illustrative 기준값
const TOOL_SEARCH_MODE = process.env.ENABLE_TOOL_SEARCH ?? "deferred"; // "deferred" | "auto" | "false"

const toolSearchTool: Anthropic.Tool = {
  name: "ToolSearch",
  description:
    "이름/키워드로 지연 로드된 MCP 도구를 검색해서 스키마를 지금 불러온다. " +
    "MCP 도구를 실제로 호출하려면 먼저 이 도구로 찾아서 로드해야 한다.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "찾고 싶은 도구에 대한 키워드" } },
    required: ["query"],
  },
};

// activeTools = 지금 이 순간 모델에게 실제로 보이는 도구 목록.
// mutable: ToolSearch가 호출되면 여기 push되어 "다음 턴부터" 직접 호출 가능해진다.
let activeTools: Anthropic.Tool[] = [...builtinTools];
let mcpEagerLoaded = false;

if (mcpTools.length > 0) {
  if (TOOL_SEARCH_MODE === "false") {
    activeTools.push(...mcpTools);
    mcpEagerLoaded = true;
    console.log(`   [tool-search] ENABLE_TOOL_SEARCH=false — MCP 스키마 ${mcpTools.length}개 즉시 전부 로드`);
  } else if (TOOL_SEARCH_MODE === "auto") {
    const probe = await client.messages.countTokens({
      model: MODEL,
      tools: mcpTools,
      messages: [{ role: "user", content: "." }],
    });
    if (probe.input_tokens < CONTEXT_WINDOW * 0.1) {
      activeTools.push(...mcpTools);
      mcpEagerLoaded = true;
      console.log(`   [tool-search] auto — MCP 스키마 ${probe.input_tokens}토큰 (< 컨텍스트의 10%) → 즉시 로드`);
    } else {
      activeTools.push(toolSearchTool);
      console.log(`   [tool-search] auto — MCP 스키마 ${probe.input_tokens}토큰 (≥ 컨텍스트의 10%) → 지연, ToolSearch 등록`);
    }
  } else {
    activeTools.push(toolSearchTool);
    console.log(`   [tool-search] 기본값(지연) — MCP 도구 ${mcpTools.length}개는 이름조차 노출 안 됨, ToolSearch로 필요할 때만 로드`);
  }
}

// ════════════════════════════════════════════════════════════════════
// ⑮ PLUGINS — 콘텐츠형 플러그인 vs MCP 제공 플러그인, 캐시 영향이 다른 이유
//
//    문서 규칙: Skills/commands/agents/hooks/LSP 서버/monitors/themes를
//    제공하는 플러그인은 캐시를 무효화하지 않는다. "이들이 요청에 추가하는
//    모든 것은 기존 대화 뒤에 추가되기 때문" — 이건 새로운 개념이 아니라
//    우리 프로젝트의 ④ SKILLS가 이미 그 모양이다: skillCatalog(설명)는
//    세션 시작 시 시스템 프롬프트에 딱 한 번 실리고, 본문은 Skill 도구가
//    "호출되는 그 순간" 대화(messages) 맨 뒤에 덧붙는다(runTool의 "Skill"
//    케이스, 그리고 스킬을 /이름으로 직접 부르는 진입점 코드 참고).
//    그래서 콘텐츠형 플러그인을 껐다 켜도 이미 캐시된 system/tools/이전
//    대화 프리픽스는 전혀 안 건드린다 — 다음 요청은 새 내용만 캐시에 쓴다.
//
//    예외는 MCP 서버를 제공하는 플러그인이다. 그 서버가 공급하는 도구
//    스키마는 ⑤ MCP · ⑪ TOOL SEARCH와 완전히 같은 자리(tools 배열 또는
//    지연된 도구 검색 저장고)에 들어간다. 그래서 규칙도 MCP 서버 연결·
//    해제와 동일하게 갈린다:
//      - deferred: true  (도구 검색으로 연기) → 토글해도 tools 배열의
//        캐시된 마지막 항목이 안 바뀌므로 무효화 없음.
//      - deferred: false (프리픽스에 즉시 로드, mcpEagerLoaded 경로) →
//        토글하는 순간 tools 배열의 내용/마지막 항목이 달라지므로 다음
//        요청은 도구 계층 캐시를 통째로 다시 씀.
//
//    아래는 실제 토글 스위치가 아니라, "콘텐츠가 어느 계층에 꽂히는가"만
//    선언적으로 대조해 보여주는 예시다 — 실제 동작 증명은 위 ④·⑤·⑪이
//    이미 코드로 하고 있다.
// ════════════════════════════════════════════════════════════════════
type ContentPlugin = { kind: "content"; providesSkills: (keyof typeof SKILLS)[] }; // ④ 경로: 대화 계층에 append, 캐시 무효화 없음
type McpPlugin = { kind: "mcp"; providesTools: string[]; deferred: boolean }; // ⑤/⑪ 경로: 도구 계층, deferred 여부로 갈림

const EXAMPLE_PLUGINS: Record<string, ContentPlugin | McpPlugin> = {
  "readme-style-plugin": { kind: "content", providesSkills: ["readme-style"] }, // 캐시 무효화 없음
  "clock-plugin": { kind: "mcp", providesTools: ["mcp__demo__get_time"], deferred: true }, // 연기됨 → 무효화 없음 (지금 이 프로젝트의 기본 USE_MCP 경로와 동일)
  "eager-search-plugin": { kind: "mcp", providesTools: ["mcp__search__web"], deferred: false }, // 프리픽스에 즉시 로드 → 토글 시 무효화 (ENABLE_TOOL_SEARCH=false 경로와 동일)
};

// ════════════════════════════════════════════════════════════════════
// ① 권한 · ② 체크포인트 · ⑧ 세션 저장
// ════════════════════════════════════════════════════════════════════
const AUTO_ALLOW = new Set(["Read", "Grep", "Skill", "Agent", "ToolSearch"]); // 읽기 전용은 안 물음

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
  const withinWorkdir = resolved === WORKDIR || resolved.startsWith(WORKDIR + path.sep);
  // ⑱ 자동 메모리 디렉토리도 허용 — 문서: "Claude는 세션 중에 메모리 파일을 읽고 씁니다."
  //   실제 Claude Code처럼 Read/Write/Edit이 작업 디렉토리 밖의 이 폴더에도 닿을 수 있어야 한다.
  const withinMemoryDir = resolved === AUTO_MEMORY_DIR || resolved.startsWith(AUTO_MEMORY_DIR + path.sep);
  if (!withinWorkdir && !withinMemoryDir) {
    throw new Error(`작업 디렉토리(또는 자동 메모리 디렉토리 ${AUTO_MEMORY_DIR}) 밖입니다: ${p}`);
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
    // ⑰ 하위 디렉토리 CLAUDE.md / 경로별 규칙(paths frontmatter)은 시작 시 로드되지
    //   않는다 — 문서: "Claude가 해당 디렉토리의 파일을 읽을 때 필요에 따라 로드됩니다."
    //   그래서 Read가 실제로 이 파일을 건드리는 "지금 이 순간"에 찾아서, 본문 앞에
    //   덧붙여 tool_result로 반환한다(스킬 본문이 Skill 도구 호출 시점에 messages로
    //   들어가는 것과 같은 자리 — systemPrompt가 아니라 대화 계층에 박힌다).
    case "Read": {
      const target = safePath(input.file_path);
      const content = fs.readFileSync(target, "utf8");
      const lazyBlocks = [...collectSubdirClaudeMdBlocks(target), ...collectPathScopedRuleBlocks(target)];
      if (lazyBlocks.length > 0) {
        console.log(`   [memory] ${input.file_path} 읽음 — 지연 로드 블록 ${lazyBlocks.length}개 주입`);
      }
      return lazyBlocks.length > 0 ? `${lazyBlocks.join("\n\n")}\n\n${content}` : content;
    }

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
      // ⑬ 모델이 스스로 부르면 안 되는 스킬 —애초에 skillCatalog에 이름도
      //   없었으니 정상적으로는 여기 도달할 일이 없지만, 방어적으로 한 번 더 막는다.
      if (skill.disableModelInvocation) {
        throw new Error(
          `"${input.name}"은 disable-model-invocation 스킬이라 모델이 직접 호출할 수 없습니다. ` +
            `사용자가 /${input.name}으로 직접 호출해야 합니다.`,
        );
      }
      recordSkillInvocation(input.name); // ⑫ 압축 후 재주입 대상으로 기록
      console.log(`   [skill] ${input.name} 본문 로드 (${skill.body.length}자)`);
      return skill.body;
    }

    // ⑪ tool search — 지연된 MCP 스키마를 찾아서 activeTools에 등록한다.
    //    이 시점 이전엔 이 도구들이 tools 배열에 없어서 모델이 애초에 호출할 수 없었다.
    //    등록 직후가 아니라 "다음 API 호출부터" 실제로 쓸 수 있게 된다.
    case "ToolSearch": {
      const query = String(input.query ?? "").toLowerCase();
      const matches = mcpTools.filter(
        (t) => t.name.toLowerCase().includes(query) || (t.description ?? "").toLowerCase().includes(query),
      );
      if (matches.length === 0) {
        return `"${input.query}"에 매칭되는 도구가 없습니다. 검색 가능한 이름: ${mcpTools.map((t) => t.name).join(", ") || "(없음)"}`;
      }
      const newlyAdded = matches.filter((m) => !activeTools.some((t) => t.name === m.name));
      activeTools.push(...newlyAdded);
      console.log(`   [tool-search] "${input.query}" → ${matches.map((t) => t.name).join(", ")} 스키마 로드됨`);
      return [
        `다음 도구를 로드했습니다: ${matches.map((t) => t.name).join(", ")}`,
        ...matches.map((t) => `- ${t.name}: ${t.description}`),
        "이제 이 도구를 직접 호출할 수 있습니다.",
      ].join("\n");
    }

    // ⑥ subagent — 새 messages 배열로 루프를 한 벌 더 돌리고 요약만 반환
    case "Agent": {
      if (depth >= 1) throw new Error("subagent는 중첩할 수 없습니다.");
      console.log(`   [subagent] 시작: ${input.task}`);
      // ⑭ 서브에이전트는 부모와 다른 systemPrompt 문자열로 시작하므로 프리픽스가
      //   부모 것과 다르다 — 첫 호출부터 캐시 미스인 게 당연하다(문서: "첫 호출 시
      //   캐시 히트가 없고 자체 턴에 걸쳐 따뜻해진다"). 부모의 activeTools/캐시는
      //   전혀 안 건드리므로 이 호출이 끝나도 부모 쪽 프리픽스는 그대로 유지된다.
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
// ⑭ 프롬프트 캐싱 — 문서(prompt-caching)의 "계층" 모델을 그대로 코드로 옮긴다.
//
//    매 요청은 새 API 호출이고 모델은 아무것도 기억하지 못하므로, 캐시는
//    "이 요청의 앞부분이 저번 요청과 토씨 하나 안 틀리고 같은가"로만 작동한다.
//    같은 부분만 캐시에서 읽고, 그 뒤로는 전부 다시 계산 + 다시 캐시에 쓴다.
//    cache_control 중단점을 어디에 찍느냐가 "어디까지가 프리픽스냐"를 정한다:
//
//      tools 마지막 도구    — 도구 정의 계층 (ToolSearch로 도구가 늘어나면 여기서 끊김)
//      system 마지막 블록   — 시스템 프롬프트 계층 (MEMORY.md/CLAUDE.md 포함, ⑫ 압축 후 재구성되면 여기서 끊김)
//      messages 마지막 블록 — 대화 계층 (매 턴 새 메시지로 옮겨감 → 직전 턴까지는 항상 캐시 히트)
//
//    최대 4개 중단점이라는 API 제한 안에서 3개만 쓴다. 문서의 "노력 수준/모델도
//    프롬프트 텍스트엔 없지만 캐시 키의 일부"라는 지점은 이 미니 구현엔 없다 —
//    MODEL이 상수라 애초에 안 바뀌기 때문. 실제로 모델/노력 수준을 바꿀 수 있는
//    하네스라면 그 값이 바뀔 때마다 캐시가 통째로 무효화된다는 뜻이다.
//
//    TTL: 실제 Claude Code는 Claude 구독이면 자동 1시간, API 키/타사 제공자면
//    기본 5분이다. 여기선 그 구분을 흉내낸 환경변수 두 개만 둔다.
//    FORCE_PROMPT_CACHING_5M이 ENABLE_PROMPT_CACHING_1H보다 우선하는 순서까지
//    문서 그대로 재현한다 — "로컬 환경변수가 관리 설정을 이길 수 있다"는 지점.
// ════════════════════════════════════════════════════════════════════
const CACHE_DISABLED = process.env.DISABLE_PROMPT_CACHING === "1";
const CACHE_TTL: "5m" | "1h" =
  process.env.FORCE_PROMPT_CACHING_5M === "1" ? "5m" : process.env.ENABLE_PROMPT_CACHING_1H === "1" ? "1h" : "5m";

function cacheControl(): Anthropic.CacheControlEphemeral | undefined {
  return CACHE_DISABLED ? undefined : { type: "ephemeral", ttl: CACHE_TTL };
}

// 시스템 프롬프트 문자열 → 캐시 중단점이 찍힌 content-block 배열.
function withSystemCache(system: string): string | Anthropic.TextBlockParam[] {
  if (CACHE_DISABLED) return system;
  return [{ type: "text", text: system, cache_control: cacheControl() }];
}

// tools 배열의 "마지막" 항목에만 중단점을 찍는다. 원본 배열/객체는 절대 변형하지
// 않고 매번 새 배열을 반환한다 — ToolSearch가 나중에 도구를 append해도 예전
// 마지막 도구엔 중단점이 안 남아있으므로(그러지 않으면 중단점이 계속 누적돼 4개
// 제한을 넘긴다) 항상 "현재 시점의 진짜 마지막"에만 정확히 하나 찍히게 된다.
function withToolsCache(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (CACHE_DISABLED || tools.length === 0) return tools;
  return tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: cacheControl() } : t));
}

// messages 배열의 "마지막 메시지, 마지막 블록"에만 중단점을 찍는다.
// 원본 messages(대화 기록 본체)는 건드리지 않고 요청용 복사본만 만든다 —
// 그래서 다음 턴엔 이 중단점이 자연스럽게 "직전 메시지"로 밀려나며 사라지고,
// 그 위치까지는 이미 캐시에 쓰여 있으니 다음 요청이 거기까지 히트한다.
function withMessagesCache(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (CACHE_DISABLED || messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  const blocks =
    typeof last.content === "string"
      ? [{ type: "text" as const, text: last.content }]
      : last.content.map((b) => ({ ...b }));
  if (blocks.length === 0) return messages;
  (blocks[blocks.length - 1] as { cache_control?: Anthropic.CacheControlEphemeral }).cache_control = cacheControl();
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

// 캐시 성능 확인 — 문서가 알려주는 두 필드를 턴마다 그대로 찍는다.
// "생성이 턴마다 높게 유지되면 프리픽스에서 뭔가 변경되고 있다"는 진단을
// 눈으로 바로 볼 수 있게 히트율까지 계산한다.
function logCacheUsage(indent: string, usage: Anthropic.Usage) {
  const read = usage.cache_read_input_tokens ?? 0;
  const created = usage.cache_creation_input_tokens ?? 0;
  const fresh = usage.input_tokens;
  const total = read + created + fresh;
  const hitRatio = total > 0 ? Math.round((read / total) * 100) : 0;
  const ttlNote = usage.cache_creation
    ? ` [1h:${usage.cache_creation.ephemeral_1h_input_tokens} 5m:${usage.cache_creation.ephemeral_5m_input_tokens}]`
    : "";
  console.log(
    `${indent}   [cache] read ${read.toLocaleString()} · write ${created.toLocaleString()}${ttlNote} · fresh ${fresh.toLocaleString()} · 총 ${total.toLocaleString()} · 히트율 ${hitRatio}%`,
  );
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

async function compact(messages: Anthropic.MessageParam[], systemPrompt: string): Promise<Anthropic.MessageParam[]> {
  const KEEP_PAIRS = 2;
  const cut = messages.length - KEEP_PAIRS * 2;
  if (cut < 3) return messages; // 자를 게 없음

  const older = messages.slice(0, cut);
  const recent = messages.slice(cut);

  console.log(`\n🗜  압축 실행 — 앞쪽 ${older.length}개 메시지를 요약으로 교체`);

  // ⑭ 요약 요청도 대화와 "동일한 시스템 프롬프트 + 도구 + 기록"을 가진 일회성
  //   요청이다 — 문서 그대로: 프리픽스를 공유하기 때문에 이 호출은 전체 기록을
  //   다시 처리하는 대신 기존 캐시를 읽는다. 대화 계층(마지막 메시지)에만
  //   새 중단점을 찍고 system/tools는 이미 캐시된 그대로 재사용을 노린다.
  const summary = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: withSystemCache(systemPrompt),
    tools: withToolsCache(activeTools),
    messages: withMessagesCache([
      ...older,
      {
        role: "user",
        content:
          "지금까지의 작업을 요약해줘. 사용자의 원래 요청, 확인한 사실, " +
          "수정한 파일, 남은 할 일을 빠뜨리지 말 것. 요약만 출력.",
      },
    ]),
  });
  logCacheUsage("  ", summary.usage);
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
// ⑫ 압축 후 skill 재주입 — /compact가 지나가면 skillCatalogBlock(설명
//    목록)은 사라진다. 대신 "이번 세션에서 실제로 호출했던 스킬"의
//    본문만 캡을 걸고 다시 주입한다:
//      - 스킬당 최대 5,000토큰 (초과분은 잘라내되 파일 시작 부분을 유지)
//      - 전체 합계 최대 25,000토큰 (초과하면 가장 오래 호출된 것부터 제외)
//    ★ CLAUDE.md / auto memory / 환경 정보는 애초에 messages가 아니라
//      systemPrompt 문자열 자체에 박혀있어서 compact()가 손대지 않는 한
//      저절로 유지된다 — 그래서 "skill 설명 목록"만 별도 처리가 필요하다.
// ════════════════════════════════════════════════════════════════════
const invokedSkillOrder: string[] = []; // 호출 순서 (오래된 것 먼저)
const PER_SKILL_CHAR_CAP = 5_000 * 4; // 5,000 토큰 ≈ 20,000자 근사치 (문자 기반 어림)
const TOTAL_SKILL_TOKEN_CAP = 25_000;

function recordSkillInvocation(name: string) {
  if (!invokedSkillOrder.includes(name)) invokedSkillOrder.push(name);
}

async function buildInvokedSkillsBlock(): Promise<string | null> {
  if (invokedSkillOrder.length === 0) return null;

  let names = [...invokedSkillOrder];
  while (names.length > 0) {
    const block = names
      .map((name) => {
        const body = SKILLS[name].body;
        // 잘림은 파일의 시작 부분을 유지한다 (문서 규칙)
        const capped = body.length > PER_SKILL_CHAR_CAP ? body.slice(0, PER_SKILL_CHAR_CAP) : body;
        return `<skill name="${name}">\n${capped}\n</skill>`;
      })
      .join("\n\n");

    const counted = await client.messages.countTokens({
      model: MODEL,
      system: block,
      messages: [{ role: "user", content: "." }],
    });

    if (counted.input_tokens <= TOTAL_SKILL_TOKEN_CAP) {
      return `<reinjected_skills>\n${block}\n</reinjected_skills>`;
    }
    console.log(`   [compact] 스킬 재주입 예산(${TOTAL_SKILL_TOKEN_CAP.toLocaleString()}토큰) 초과 — 가장 오래된 "${names[0]}" 제외`);
    names = names.slice(1); // 가장 오래된 것부터 제거
  }
  return null; // 다 빼도 예산을 못 맞추면(사실상 없음) 아무것도 재주입 안 함
}

async function rebuildSystemPromptAfterCompact(currentSystemPrompt: string): Promise<string> {
  // ⑳ 압축 후 재로드 — 문서: "프로젝트 루트 CLAUDE.md는 압축을 완전히 생존합니다:
  //   /compact 후 Claude는 디스크에서 CLAUDE.md를 다시 읽고 세션에 새로 다시 주입합니다."
  //   예전엔 이전 systemPrompt 문자열을 문자열 치환으로 땜질했지만, 그러면 세션 중
  //   CLAUDE.md/규칙/MEMORY.md가 바뀌어도 절대 반영이 안 된다 — 그래서 처음부터 다시
  //   짓는다: 스킬 설명 목록만 "재주입된 스킬 본문"으로 바뀌고, 나머지(CLAUDE.md 계층·
  //   자동 메모리·규칙)는 매번 디스크에서 새로 읽는 composeSystemPrompt를 그대로 재사용한다.
  //
  //   하위 디렉토리 CLAUDE.md / 경로별 규칙(paths)은 반대다 — 문서: "하위 디렉토리의
  //   중첩된 CLAUDE.md 파일은 자동으로 다시 주입되지 않습니다. 해당 하위 디렉토리의
  //   파일을 다시 읽을 때 다음에 다시 로드됩니다." 압축이 그 파일들을 "잊게" 만드는
  //   것을 지연 주입 기록 초기화로 흉내낸다 — 다음에 같은 파일을 Read하면 다시 주입된다.
  clearLazyMemoryInjections();

  const invokedBlock = await buildInvokedSkillsBlock();
  const rebuilt = await composeSystemPrompt({
    verbose: false,
    skillsBlock: { kind: "reinjected", block: invokedBlock },
  });

  const [before, after] = await Promise.all([
    client.messages.countTokens({
      model: MODEL,
      system: currentSystemPrompt,
      tools: activeTools,
      messages: [{ role: "user", content: "." }],
    }),
    client.messages.countTokens({
      model: MODEL,
      system: rebuilt,
      tools: activeTools,
      messages: [{ role: "user", content: "." }],
    }),
  ]);
  console.log(
    `   [compact] 시스템 프롬프트 재구성 — skill 설명 목록 제거, 호출된 스킬 ${invokedSkillOrder.length}개 재주입 ` +
      `(${before.input_tokens.toLocaleString()} → ${after.input_tokens.toLocaleString()} 토큰)`,
  );

  return rebuilt;
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
    system: withSystemCache(systemPrompt),
    tools: withToolsCache(activeTools),
    messages: withMessagesCache(messages),
  });
  logCacheUsage(indent, response.usage); // ⑭ 첫 턴도 빠짐없이 찍는다 (도구 호출 없이 바로 끝나는 턴 포함)

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

    if (depth === 0 && used > COMPACT_THRESHOLD) {
      messages = await compact(messages, systemPrompt);
      systemPrompt = await rebuildSystemPromptAfterCompact(systemPrompt); // ⑫ — 이 시점부터 system이 바뀌므로 다음 턴은 시스템 계층 캐시 미스
    }

    response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: withSystemCache(systemPrompt),
      tools: withToolsCache(activeTools),
      messages: withMessagesCache(messages),
    });
    logCacheUsage(indent, response.usage); // ⑭ 이 턴이 마지막이어도(도구 호출 없이 종료) 여기서 찍힌다
  }

  return response;
}

// ════════════════════════════════════════════════════════════════════
// ⑯ CLAUDE.md 계층 — 문서 순서 그대로: 관리 정책 → 사용자 → 프로젝트
//    (디렉토리 트리를 루트→cwd 순으로 순회, 각 단계에서 CLAUDE.md 다음
//    CLAUDE.local.md) → 하위 디렉토리(⑰에서 지연 로드). 모든 파일은
//    @import 확장(최대 4홉, 코드펜스/코드스팬은 건너뜀) → HTML 주석 제거
//    순으로 가공된 뒤에야 컨텍스트에 들어간다. claudeMdExcludes로 특정
//    경로를 건너뛸 수 있지만 관리 정책만은 예외 없이 항상 로드된다.
// ════════════════════════════════════════════════════════════════════
const HOME = os.homedir();

function detectManagedPolicyPath(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/CLAUDE.md";
    case "win32":
      return "C:\\Program Files\\ClaudeCode\\CLAUDE.md";
    default:
      return "/etc/claude-code/CLAUDE.md"; // linux / wsl
  }
}

// 작업 디렉토리에서 파일 시스템 루트까지 올라가며 지나친 모든 디렉토리를
// 루트→cwd 순서로 반환한다. 문서: "Claude를 시작한 위치에 더 가까운
// 지침이 마지막에 읽힙니다" — 그래서 순서가 곧 "누가 이긴다"를 의미한다.
function collectDirectoryChain(startDir: string): string[] {
  const chain: string[] = [];
  let current = startDir;
  while (true) {
    chain.push(current);
    const parent = path.dirname(current);
    if (parent === current) break; // 파일 시스템 루트 도달
    current = parent;
  }
  return chain.reverse();
}

// ── claudeMdExcludes ───────────────────────────────────────────────
const CLAUDE_MD_EXCLUDES = (process.env.CLAUDE_MD_EXCLUDES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isExcluded(absPath: string): boolean {
  if (CLAUDE_MD_EXCLUDES.length === 0) return false;
  // 문서: "패턴은 glob 구문을 사용하여 절대 파일 경로와 일치합니다."
  return matchesAnyPath(CLAUDE_MD_EXCLUDES, absPath.split(path.sep).join("/"));
}

// ── @path/to/import 확장 ───────────────────────────────────────────
// 코드펜스/코드스팬(백틱)은 먼저 자리표시자로 치환해 가져오기 대상에서
// 제외한다 — 문서: "`@README`를 작성하면 텍스트가 리터럴로 유지"된다.
function withCodeSpansMasked(text: string, fn: (masked: string) => string): string {
  const spans: string[] = [];
  const masked = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => {
    spans.push(m);
    return `\u0000SPAN${spans.length - 1}\u0000`;
  });
  const result = fn(masked);
  return result.replace(/\u0000SPAN(\d+)\u0000/g, (_, i) => spans[Number(i)]);
}

function expandImports(text: string, baseDir: string, depth = 0, seen: Set<string> = new Set()): string {
  if (depth >= 4) return text; // 문서: "최대 4개 홉의 깊이"
  return withCodeSpansMasked(text, (masked) =>
    masked.replace(/(^|[\s(])@([\w./~-]+)/g, (match, prefix, rawPath) => {
      const resolved = rawPath.startsWith("~") ? path.join(HOME, rawPath.slice(1)) : path.resolve(baseDir, rawPath);
      if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory() || seen.has(resolved)) return match;
      const nextSeen = new Set(seen);
      nextSeen.add(resolved);
      const content = fs.readFileSync(resolved, "utf8");
      return prefix + expandImports(content, path.dirname(resolved), depth + 1, nextSeen);
    }),
  );
}

// ── HTML 주석 제거 ─────────────────────────────────────────────────
// 문서: "CLAUDE.md 파일의 블록 수준 HTML 주석은 콘텐츠가 Claude의
// 컨텍스트에 주입되기 전에 제거됩니다. ... 코드 블록 내의 주석은 보존됩니다."
function stripHtmlComments(text: string): string {
  const fences: string[] = [];
  const masked = text.replace(/```[\s\S]*?```/g, (m) => {
    fences.push(m);
    return `\u0000FENCE${fences.length - 1}\u0000`;
  });
  const stripped = masked.replace(/<!--[\s\S]*?-->/g, "");
  return stripped.replace(/\u0000FENCE(\d+)\u0000/g, (_, i) => fences[Number(i)]);
}

function processClaudeMdText(raw: string, filePath: string): string {
  return stripHtmlComments(expandImports(raw, path.dirname(filePath)));
}

// ════════════════════════════════════════════════════════════════════
// glob 매칭 — .claude/rules/ 의 paths frontmatter, claudeMdExcludes가
// 공유해서 쓴다. `{a,b}` 중괄호 확장, `**`/`*`/`?`, `[...]` 괄호 표현식을
// 지원한다. 문서 규칙: 짝이 안 맞는 `[`가 있는 패턴은 "무효 패턴"으로
// 취급해 아무것도 매칭시키지 않고, 나머지 패턴은 정상 동작해야 한다.
// ════════════════════════════════════════════════════════════════════
function expandBraces(pattern: string): string[] {
  const m = pattern.match(/^(.*)\{([^{}]+)\}(.*)$/);
  if (!m) return [pattern];
  const [, pre, options, post] = m;
  return options.split(",").flatMap((opt) => expandBraces(pre + opt + post));
}

function globToRegExp(pattern: string): RegExp | null {
  let depth = 0;
  for (const ch of pattern) {
    if (ch === "[") depth++;
    if (ch === "]") depth = Math.max(0, depth - 1);
  }
  if (depth > 0) return null; // 짝 안 맞는 '[' → 무효 패턴 (문서 규칙)

  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") i++;
      re += "(?:.*/)?";
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === ".") {
      re += "\\.";
    } else if (c === "[") {
      let j = i + 1;
      let cls = "[";
      if (pattern[j] === "!") {
        cls += "^";
        j++;
      }
      while (j < pattern.length && pattern[j] !== "]") {
        cls += pattern[j];
        j++;
      }
      cls += "]";
      re += cls;
      i = j;
    } else if ("+()^$|\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function matchesAnyPath(patterns: string[], relOrAbsPosixPath: string): boolean {
  return patterns.some((raw) =>
    expandBraces(raw).some((p) => {
      const re = globToRegExp(p);
      return re !== null && re.test(relOrAbsPosixPath);
    }),
  );
}

// ════════════════════════════════════════════════════════════════════
// ⑰ .claude/rules/ — 심볼릭 링크(및 순환 링크)를 안전하게 따라가며 재귀
//    적으로 .md 파일을 찾는다. paths frontmatter가 없으면 무조건 로드
//    (project CLAUDE.md와 동일 우선순위), 있으면 그 패턴과 일치하는
//    파일을 Read할 때만 지연 로드된다.
// ════════════════════════════════════════════════════════════════════
type RuleFile = { filePath: string; scope: "user" | "project"; paths: string[] | null; body: string };

function discoverMarkdownFilesRecursive(dir: string, visitedRealDirs: Set<string> = new Set()): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let stat: fs.Stats;
    let real: string;
    try {
      stat = fs.statSync(full); // 심볼릭 링크는 대상을 따라간다
      real = fs.realpathSync(full);
    } catch {
      continue; // 깨진 링크 등은 조용히 무시
    }
    if (stat.isDirectory()) {
      if (visitedRealDirs.has(real)) continue; // 순환 심볼릭 링크 방지 — 문서: "우아하게 처리"
      results.push(...discoverMarkdownFilesRecursive(full, new Set(visitedRealDirs).add(real)));
    } else if (stat.isFile() && full.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

function parseRuleFrontmatter(raw: string): { paths: string[] | null; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { paths: null, body: raw };
  const [, frontmatter, rest] = m;
  const pathsBlock = frontmatter.match(/^paths:\s*\n((?:[ \t]*-.*\n?)+)/m);
  if (!pathsBlock) return { paths: null, body: rest };
  const paths = pathsBlock[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-"))
    .map((l) =>
      l
        .replace(/^-\s*/, "")
        .trim()
        .replace(/^["']|["']$/g, ""),
    );
  return { paths: paths.length ? paths : null, body: rest };
}

function discoverRuleFiles(rulesDir: string, scope: "user" | "project"): RuleFile[] {
  if (!fs.existsSync(rulesDir)) return [];
  return discoverMarkdownFilesRecursive(rulesDir).map((filePath) => {
    const { paths, body } = parseRuleFrontmatter(fs.readFileSync(filePath, "utf8"));
    return { filePath, scope, paths, body };
  });
}

const allRuleFiles: RuleFile[] = [
  ...discoverRuleFiles(path.join(HOME, ".claude", "rules"), "user"),
  ...discoverRuleFiles(path.join(WORKDIR, ".claude", "rules"), "project"),
];

// 이미 (시작 시 or 지연 로드로) 컨텍스트에 실린 파일 — 경로별 규칙/하위
// 디렉토리 CLAUDE.md 중복 주입 방지용. ⑳ 압축 시 이 중 "지연 로드분"만
// 초기화되어 다음 Read에서 다시 주입되게 한다(무조건 로드분은 매번
// composeSystemPrompt가 다시 계산하므로 여기 남아있어도 무해하다).
const injectedLazyBlocks = new Set<string>();
// /memory 명령이 보여줄 "이번 빌드에서 로드된 CLAUDE.md 계열 파일" 목록
let loadedClaudeMdFiles: Array<{ scope: string; filePath: string }> = [];

function collectSubdirClaudeMdBlocks(targetAbsPath: string): string[] {
  const targetDir = path.dirname(targetAbsPath);
  const relFromWorkdir = path.relative(WORKDIR, targetDir);
  if (relFromWorkdir.startsWith("..") || path.isAbsolute(relFromWorkdir)) return []; // 작업 디렉토리 밖
  const segments = relFromWorkdir === "" ? [] : relFromWorkdir.split(path.sep);
  const blocks: string[] = [];
  let dir = WORKDIR;
  for (const seg of segments) {
    dir = path.join(dir, seg);
    for (const candidate of [path.join(dir, "CLAUDE.md"), path.join(dir, ".claude", "CLAUDE.md")]) {
      if (fs.existsSync(candidate) && !injectedLazyBlocks.has(candidate) && !isExcluded(candidate)) {
        injectedLazyBlocks.add(candidate);
        loadedClaudeMdFiles.push({ scope: "하위 디렉토리", filePath: candidate });
        blocks.push(
          `<subdirectory_claude_md source="${candidate}">\n${processClaudeMdText(fs.readFileSync(candidate, "utf8"), candidate)}\n</subdirectory_claude_md>`,
        );
      }
    }
    const localCandidate = path.join(dir, "CLAUDE.local.md");
    if (fs.existsSync(localCandidate) && !injectedLazyBlocks.has(localCandidate) && !isExcluded(localCandidate)) {
      injectedLazyBlocks.add(localCandidate);
      loadedClaudeMdFiles.push({ scope: "하위 디렉토리(로컬)", filePath: localCandidate });
      blocks.push(
        `<subdirectory_claude_md source="${localCandidate}">\n${processClaudeMdText(fs.readFileSync(localCandidate, "utf8"), localCandidate)}\n</subdirectory_claude_md>`,
      );
    }
  }
  return blocks;
}

function collectPathScopedRuleBlocks(targetAbsPath: string): string[] {
  const relFromWorkdir = path.relative(WORKDIR, targetAbsPath);
  if (relFromWorkdir.startsWith("..") || path.isAbsolute(relFromWorkdir)) return [];
  const relPosix = relFromWorkdir.split(path.sep).join("/");
  const blocks: string[] = [];
  for (const rule of allRuleFiles) {
    if (!rule.paths) continue; // paths 없는 규칙은 시작 시 이미 무조건 로드됨
    if (injectedLazyBlocks.has(rule.filePath) || isExcluded(rule.filePath)) continue;
    if (matchesAnyPath(rule.paths, relPosix)) {
      injectedLazyBlocks.add(rule.filePath);
      blocks.push(
        `<rule scope="${rule.scope}" source="${rule.filePath}" paths="${rule.paths.join(", ")}">\n` +
          `${processClaudeMdText(rule.body, rule.filePath)}\n</rule>`,
      );
    }
  }
  return blocks;
}

function clearLazyMemoryInjections() {
  injectedLazyBlocks.clear();
}

// 관리 정책 → 사용자 → 프로젝트(디렉토리 트리, 루트→cwd) + 로컬 → 무조건
// 로드 규칙. /compact 후에도, 첫 시작 때도 이 함수 하나로 매번 디스크에서
// 다시 읽는다 — 그래야 세션 중 파일이 바뀌어도 재반영된다.
function buildStartupClaudeMdBlocks(): { managed: string | null; user: string | null; project: string | null; rules: string | null } {
  loadedClaudeMdFiles = [];

  const managedPath = detectManagedPolicyPath();
  const managed = fs.existsSync(managedPath) // claudeMdExcludes로도 제외 불가 — 문서 규칙
    ? (() => {
        loadedClaudeMdFiles.push({ scope: "관리 정책", filePath: managedPath });
        return `<managed_policy_claude_md source="${managedPath}">\n${processClaudeMdText(fs.readFileSync(managedPath, "utf8"), managedPath)}\n</managed_policy_claude_md>`;
      })()
    : null;

  const userPath = path.join(HOME, ".claude", "CLAUDE.md");
  const user =
    fs.existsSync(userPath) && !isExcluded(userPath)
      ? (() => {
          loadedClaudeMdFiles.push({ scope: "사용자", filePath: userPath });
          return `<user_claude_md source="${userPath}">\n${processClaudeMdText(fs.readFileSync(userPath, "utf8"), userPath)}\n</user_claude_md>`;
        })()
      : null;

  const projectParts: string[] = [];
  for (const dir of collectDirectoryChain(WORKDIR)) {
    for (const candidate of [path.join(dir, "CLAUDE.md"), path.join(dir, ".claude", "CLAUDE.md")]) {
      if (fs.existsSync(candidate) && !isExcluded(candidate)) {
        loadedClaudeMdFiles.push({ scope: dir === WORKDIR ? "프로젝트" : "상위 디렉토리", filePath: candidate });
        projectParts.push(
          `<project_claude_md source="${candidate}">\n${processClaudeMdText(fs.readFileSync(candidate, "utf8"), candidate)}\n</project_claude_md>`,
        );
      }
    }
    const localCandidate = path.join(dir, "CLAUDE.local.md");
    if (fs.existsSync(localCandidate) && !isExcluded(localCandidate)) {
      loadedClaudeMdFiles.push({ scope: "로컬", filePath: localCandidate });
      projectParts.push(
        `<local_claude_md source="${localCandidate}">\n${processClaudeMdText(fs.readFileSync(localCandidate, "utf8"), localCandidate)}\n</local_claude_md>`,
      );
    }
  }

  const unconditional = allRuleFiles.filter((r) => r.paths === null && !isExcluded(r.filePath));
  const rules = unconditional.length
    ? unconditional
        .map((r) => {
          injectedLazyBlocks.add(r.filePath); // 시작 시 이미 실렸으니 지연 로드 대상에서 제외
          return `<rule scope="${r.scope}" source="${r.filePath}">\n${processClaudeMdText(r.body, r.filePath)}\n</rule>`;
        })
        .join("\n\n")
    : null;

  return { managed, user, project: projectParts.length ? projectParts.join("\n\n") : null, rules };
}

// ════════════════════════════════════════════════════════════════════
// ⑱ 자동 메모리 저장 위치 — 문서: "~/.claude/projects/<project>/memory/,
//    <project> 경로는 git 저장소에서 파생". 실제 관찰된 슬러그 규칙은
//    절대 경로의 구분자를 "-"로 치환하는 것이다(이 세션의 스크래치패드
//    디렉토리 이름 자체가 그 증거: .../-Users-...-claude-code-study/...).
//    ★ 단, 진짜 `~/.claude/projects/`는 실제 Claude Code CLI가 이 저장소를
//    위해 쓰고 있는 바로 그 자리라서(이 대화 자체가 거기 memory/를 쓴다),
//    미니 데모가 거기 같이 쓰고 읽으면 데모 메모리와 실제 세션 메모리가
//    섞인다. 그래서 같은 슬러그 규칙·같은 "projects/<slug>/memory" 모양을
//    그대로 재현하되, 루트만 별도 샌드박스(~/.mini-claude-code/)로 둔다.
// ════════════════════════════════════════════════════════════════════
const MINI_CLAUDE_HOME = path.join(HOME, ".mini-claude-code");

function findGitRepoRoot(startDir: string): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", { cwd: startDir, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function projectSlug(absPath: string): string {
  return absPath.replace(/[\\/]/g, "-");
}

function resolveAutoMemoryDirectory(): string {
  if (process.env.AUTO_MEMORY_DIRECTORY) {
    const raw = process.env.AUTO_MEMORY_DIRECTORY;
    return raw.startsWith("~") ? path.join(HOME, raw.slice(1)) : path.resolve(raw);
  }
  // 문서: "동일한 저장소 내의 모든 worktree 및 하위 디렉토리는 하나의
  // 자동 메모리 디렉토리를 공유합니다" — git 저장소 루트를 기준으로 삼는다.
  const projectRoot = findGitRepoRoot(WORKDIR) ?? WORKDIR;
  return path.join(MINI_CLAUDE_HOME, "projects", projectSlug(projectRoot), "memory");
}

const AUTO_MEMORY_DIR = resolveAutoMemoryDirectory();
const MEMORY_INDEX_PATH = path.join(AUTO_MEMORY_DIR, "MEMORY.md");
// 문서: "autoMemoryEnabled" 설정 / CLAUDE_CODE_DISABLE_AUTO_MEMORY 환경변수
const AUTO_MEMORY_ENABLED = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== "1";

// 이 저장소에 이미 있던 (구) WORKDIR/MEMORY.md — 이 프로젝트 자신의
// 개발 노트이자, 리팩터 전까지는 실제 auto-memory 파일이기도 했다.
// 새 위치가 비어 있으면 1회 복사해서 데모가 끊기지 않게 한다(원본은 보존).
function bootstrapAutoMemoryDir() {
  fs.mkdirSync(AUTO_MEMORY_DIR, { recursive: true });
  const legacyPath = path.join(WORKDIR, "MEMORY.md");
  if (!fs.existsSync(MEMORY_INDEX_PATH) && fs.existsSync(legacyPath)) {
    fs.copyFileSync(legacyPath, MEMORY_INDEX_PATH);
    console.log(`   [memory] ${legacyPath} → ${MEMORY_INDEX_PATH} 로 초기 마이그레이션(복사)`);
  }
}
bootstrapAutoMemoryDir();

// ════════════════════════════════════════════════════════════════════
// ⑩ 컨텍스트 윈도우 초기 로드 — 사용자가 한 글자도 치기 전에 시스템
//    프롬프트에 쌓이는 계층들. context-window 문서의 "Before you type
//    anything" 타임라인을 순서 그대로 조립하고, 각 블록이 실제로 몇
//    토큰인지 Anthropic의 countTokens API로 직접 측정해본다.
//
//      시스템 프롬프트 → 도구 정의(built-in) → Auto memory(MEMORY.md) → 환경 정보
//      → MCP 도구(⑪ 모드에 따라 스키마 전체 또는 ToolSearch 메타 도구만)
//      → Skill 설명 → 관리 정책 CLAUDE.md → 사용자 CLAUDE.md
//      → 프로젝트/로컬 CLAUDE.md(⑯, 디렉토리 트리) → 무조건 로드 규칙(⑰)
//      (+ 문서에 따르면 git 브랜치/status/최근 커밋은 시스템 프롬프트 "맨 끝"에
//        별도 블록으로 더 붙는다 — 그래서 여기서도 마지막에 하나 더 추가)
// ════════════════════════════════════════════════════════════════════
function loadAutoMemory(): string | null {
  if (!AUTO_MEMORY_ENABLED) return null;
  if (!fs.existsSync(MEMORY_INDEX_PATH)) return null;
  // 문서 규칙: 최초 200줄 또는 25KB 중 먼저 도달하는 지점까지만 로드한다
  const capped = fs.readFileSync(MEMORY_INDEX_PATH, "utf8").slice(0, 25_000).split("\n").slice(0, 200).join("\n");
  return (
    `<auto_memory source="${MEMORY_INDEX_PATH}" dir="${AUTO_MEMORY_DIR}">\n${capped}\n</auto_memory>\n` +
    `<auto_memory_note>이 디렉토리는 Read/Write/Edit로 직접 접근할 수 있습니다. ` +
    `MEMORY.md는 인덱스일 뿐이고, 나머지 주제별 파일은 필요할 때만 Read하세요.</auto_memory_note>`
  );
}

function buildEnvironmentInfo(): string {
  const isGitRepo = fs.existsSync(path.join(WORKDIR, ".git"));
  return [
    "<environment_info>",
    `작업 디렉토리: ${WORKDIR}`,
    `플랫폼: ${process.platform}`,
    `셸: ${process.env.SHELL ?? "unknown"}`,
    `OS 버전: ${os.release()}`,
    `git 저장소 여부: ${isGitRepo}`,
    "</environment_info>",
  ].join("\n");
}

function buildGitStatusBlock(): string | null {
  try {
    const branch = execSync("git branch --show-current", { cwd: WORKDIR, encoding: "utf8" }).trim();
    const status = execSync("git status --porcelain", { cwd: WORKDIR, encoding: "utf8" }).trim();
    const log = execSync("git log --oneline -5", { cwd: WORKDIR, encoding: "utf8" }).trim();
    return [
      "<git_status>",
      `브랜치: ${branch || "(없음)"}`,
      `변경사항: ${status ? "\n" + status : "(clean)"}`,
      `최근 커밋:\n${log || "(없음)"}`,
      "</git_status>",
    ].join("\n");
  } catch {
    return null; // git 저장소가 아니면 조용히 생략
  }
}

type StartupSection = {
  label: string;
  system?: string | null; // system 프롬프트에 텍스트로 누적되는 부분
  toolsAdd?: Anthropic.Tool[]; // tools 배열에 스키마로 누적되는 부분
};

// 시작 시 1회, 그리고 ⑳ 압축 후 재구성 시 다시 — 이 함수 하나로 두 경로를 통일한다.
// 차이는 opts뿐이다: verbose(레이어별 토큰 로그 출력 여부)와 skillsBlock(설명 목록
// vs 압축 후 재주입된 스킬 본문). CLAUDE.md/규칙/자동 메모리는 매번 buildStartupClaudeMdBlocks·
// loadAutoMemory를 새로 호출하므로 항상 "지금 디스크에 있는 내용"을 반영한다.
async function composeSystemPrompt(opts: {
  verbose: boolean;
  skillsBlock: { kind: "catalog" } | { kind: "reinjected"; block: string | null };
}): Promise<string> {
  const claudeMd = buildStartupClaudeMdBlocks();

  const sections: StartupSection[] = [
    { label: "시스템 프롬프트 (지시문)", system: SYSTEM_BASE },
    { label: "도구 정의 (built-in 7개 스키마)", toolsAdd: builtinTools },
    { label: "Auto memory (MEMORY.md)", system: loadAutoMemory() },
    { label: "환경 정보", system: buildEnvironmentInfo() },
    {
      // ⑪ 지금 activeTools의 실제 구성을 그대로 반영한다:
      //   즉시 로드 모드 → MCP 스키마 전부가 여기서 잡힘 (비쌈)
      //   지연 모드      → ToolSearch 메타 도구 하나만 잡힘 (훨씬 쌈) — 이게 "지연"의 효과다
      //   ★ 실제 Claude Code처럼, 지연 모드에선 MCP 도구 "이름"조차 시스템 프롬프트에
      //     노출하지 않는다 — 모델은 ToolSearch가 존재한다는 것만 알고 완전히 blind하게 검색한다.
      label: mcpEagerLoaded ? "MCP 도구 스키마 (즉시 로드됨)" : "ToolSearch 메타 도구 (MCP 이름조차 노출 안 함)",
      toolsAdd: mcpEagerLoaded ? mcpTools : activeTools.filter((t) => t.name === "ToolSearch"),
    },
    opts.skillsBlock.kind === "catalog"
      ? { label: "Skill 설명", system: skillCatalogBlock }
      : { label: "재주입된 skill 본문 (압축 후, ⑫)", system: opts.skillsBlock.block },
    { label: "관리 정책 CLAUDE.md (⑯)", system: claudeMd.managed },
    { label: "사용자 CLAUDE.md (⑯)", system: claudeMd.user },
    { label: "프로젝트/로컬 CLAUDE.md (⑯, 디렉토리 트리)", system: claudeMd.project },
    { label: "무조건 로드 규칙 (⑰ .claude/rules/)", system: claudeMd.rules },
    { label: "Git 상태 (맨 끝 블록)", system: buildGitStatusBlock() },
  ];

  if (opts.verbose) {
    console.log("\n📦 세션 시작 전 로드되는 컨텍스트 (countTokens API로 실측)");
    console.log("─".repeat(62));
  }

  let cumulativeSystem = "";
  let cumulativeTools: Anthropic.Tool[] = [];
  let prevTokens = 0;
  for (const s of sections) {
    const hasSystem = !!s.system;
    const hasTools = !!s.toolsAdd && s.toolsAdd.length > 0;
    if (!hasSystem && !hasTools) {
      if (opts.verbose) console.log(`  ${s.label.padEnd(30)}  (없음 — 스킵)`);
      continue;
    }
    if (hasSystem) cumulativeSystem += (cumulativeSystem ? "\n\n" : "") + s.system;
    if (hasTools) cumulativeTools = [...cumulativeTools, ...s.toolsAdd!];

    if (opts.verbose) {
      const counted = await client.messages.countTokens({
        model: MODEL,
        system: cumulativeSystem || undefined,
        tools: cumulativeTools.length ? cumulativeTools : undefined,
        messages: [{ role: "user", content: "." }],
      });
      const marginal = counted.input_tokens - prevTokens;
      prevTokens = counted.input_tokens;
      console.log(`  ${s.label.padEnd(30)} +${String(marginal).padStart(5)} tokens`);
    }
  }

  if (opts.verbose) {
    console.log("─".repeat(62));
    console.log(`  ${"합계 (첫 프롬프트 이전)".padEnd(30)} ${String(prevTokens).padStart(6)} tokens\n`);
  }

  return cumulativeSystem;
}

async function buildSystemPromptWithBreakdown(): Promise<string> {
  return composeSystemPrompt({ verbose: true, skillsBlock: { kind: "catalog" } });
}

// ⑲ /memory — 실제 명령처럼 API 호출 없이 "지금 로드된 파일"만 즉시 나열한다.
//   buildStartupClaudeMdBlocks()가 이미 loadedClaudeMdFiles를 채워두므로, 이 함수는
//   composeSystemPrompt(즉 buildSystemPromptWithBreakdown)가 최소 한 번 실행된 뒤 호출해야 한다.
function printMemoryCommand() {
  console.log("\n📋 /memory — 현재 세션에 로드된 파일\n");

  console.log("CLAUDE.md 계열:");
  if (loadedClaudeMdFiles.length === 0) console.log("  (없음)");
  for (const f of loadedClaudeMdFiles) console.log(`  [${f.scope}] ${f.filePath}`);

  console.log("\n규칙 (.claude/rules/):");
  if (allRuleFiles.length === 0) console.log("  (없음)");
  for (const r of allRuleFiles) {
    const status =
      r.paths === null
        ? "무조건 로드"
        : injectedLazyBlocks.has(r.filePath)
          ? "조건부 로드됨 (이번 세션에서 이미 매칭된 파일을 읽음)"
          : `대기 중 (paths: ${r.paths.join(", ")})`;
    console.log(`  [${r.scope}] ${r.filePath} — ${status}`);
  }

  console.log(`\n자동 메모리`);
  console.log(`  활성화: ${AUTO_MEMORY_ENABLED ? "예" : "아니오 (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1)"}`);
  console.log(`  폴더: ${AUTO_MEMORY_DIR}`);
  console.log(`  MEMORY.md: ${fs.existsSync(MEMORY_INDEX_PATH) ? "있음" : "없음"}`);

  if (CLAUDE_MD_EXCLUDES.length > 0) {
    console.log(`\nclaudeMdExcludes: ${CLAUDE_MD_EXCLUDES.join(", ")}`);
  }
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

// ⑲ /memory — skill이 아니라 하네스 내장 명령이라 API를 한 번도 안 부르고
//   여기서 바로 끝난다. 로드 상태를 보려면 실제로 한 번 로드해봐야 하므로
//   buildSystemPromptWithBreakdown()은 그대로 실행한다(그래서 토큰 브레이크다운도 덤으로 나온다).
if (userPrompt.trim() === "/memory") {
  await buildSystemPromptWithBreakdown();
  printMemoryCommand();
  rl.close();
  await mcp?.close();
  process.exit(0);
}

// ⑬ 슬래시로 직접 호출 — "/이름 ..." 형태면 모델의 판단을 거치지 않고
//   그 스킬을 즉시 로드한다. disableModelInvocation 스킬을 쓸 수 있는
//   유일한 경로. (실제 Claude Code의 REPL에서 /commit-push 같은 걸 치는
//   것과 같은 개념 — 우리는 REPL이 없으니 CLI 인자 맨 앞으로 흉내낸다.)
let initialUserContent = userPrompt;
const slashMatch = userPrompt.match(/^\/(\S+)\s*([\s\S]*)$/);
if (slashMatch) {
  const [, skillName, rest] = slashMatch;
  const skill = SKILLS[skillName];
  if (!skill) {
    console.error(`❌ 그런 skill이 없습니다: /${skillName}`);
    process.exit(1);
  }
  recordSkillInvocation(skillName); // ⑫ 압축 재주입 대상으로도 기록됨
  console.log(`   [skill] /${skillName} 사용자가 직접 호출 — 본문 로드 (${skill.body.length}자)`);
  initialUserContent = `<skill name="${skillName}">\n${skill.body}\n</skill>\n\n${rest || `${skillName} 스킬 지침을 따라 작업해줘.`}`;
}

log({ type: "user", content: initialUserContent });

const systemPrompt = await buildSystemPromptWithBreakdown();

const final = await runLoop([{ role: "user", content: initialUserContent }], systemPrompt, 0);

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