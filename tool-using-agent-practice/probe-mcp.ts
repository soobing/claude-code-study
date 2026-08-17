import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "probe", version: "1.0.0" });
await c.connect(new StdioClientTransport({
  command: "npx",
  args: ["tsx", process.cwd() + "/mcp-server-demo.ts"],
}));
const { tools } = await c.listTools();
console.log("도구 목록:", tools.map(t => `${t.name} — ${t.description}`));
console.log("word_count:", JSON.stringify(await c.callTool({ name: "word_count", arguments: { text: "hello mini claude code" } })));
console.log("now:", JSON.stringify(await c.callTool({ name: "now", arguments: {} })));
await c.close();
