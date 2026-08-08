// ⑤ MCP 데모 서버 — index.ts가 USE_MCP=1 일 때 stdio로 띄우는 외부 프로세스.
//
// 여기서 정의한 도구는 index.ts 안에 구현이 없다. 모델 입장에선 내장 도구와
// 똑같이 보이지만, 실제 실행은 이 별도 프로세스가 한다.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "demo", version: "1.0.0" });

server.registerTool(
  "get_time",
  {
    description: "현재 시각을 알려준다.",
    inputSchema: { timezone: z.string().optional() },
  },
  async ({ timezone }) => ({
    content: [
      {
        type: "text",
        text: new Date().toLocaleString("ko-KR", {
          timeZone: timezone ?? "Asia/Seoul",
        }),
      },
    ],
  }),
);

// stdio 위에서 도는 서버라 console.log 로 뭔가 찍으면 프로토콜이 깨진다.
await server.connect(new StdioServerTransport());
