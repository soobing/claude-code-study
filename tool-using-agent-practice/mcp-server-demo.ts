// 데모용 MCP 서버 — "도구 공급자" 역할만 한다
//
// 여기엔 에이전트 루프가 없다. 그게 핵심이다.
// MCP 서버는 "이런 도구가 있고, 부르면 이렇게 답한다"만 선언하고,
// 그걸 언제 쓸지 결정하는 건 붙는 쪽(에이전트)의 몫이다.
//
// 이 파일은 stdio로 통신하므로 직접 실행하지 않는다.
// mini-claude-code.ts 가 자식 프로세스로 띄운다.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "demo-tools", version: "1.0.0" });

server.registerTool(
  "word_count",
  {
    description: "주어진 텍스트의 단어 수와 글자 수를 센다.",
    inputSchema: { text: z.string().describe("셀 대상 텍스트") },
  },
  async ({ text }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          words: text.trim().split(/\s+/).filter(Boolean).length,
          chars: text.length,
        }),
      },
    ],
  }),
);

server.registerTool(
  "now",
  {
    description: "현재 시각을 Asia/Seoul 기준으로 반환한다.",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text",
        text: new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
