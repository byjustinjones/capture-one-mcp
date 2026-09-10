#!/usr/bin/env node
/**
 * End-to-end smoke test: launches the built server over stdio as a real MCP
 * client would, lists tools, and calls the read-only ones against whatever
 * Capture One currently has open.
 *
 *   npm run build && node scripts/smoke.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: process.cwd(),
});
const client = new Client({ name: "capture-one-mcp-smoke", version: "0.1.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`${tools.length} tools registered\n`);

async function call(name, args = {}) {
  const started = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const ms = Date.now() - started;
  const text = res.content?.[0]?.text ?? "";
  const flag = res.isError ? "ERR " : "ok  ";
  const oneLine = text.replace(/\s+/g, " ").slice(0, 160);
  console.log(`${flag}${name} (${ms}ms)  ${oneLine}`);
  return { res, text };
}

await call("co_status");
await call("co_list_documents");
await call("co_list_styles");
await call("co_get_document");
await call("co_list_collections", { include_counts: false });
await call("co_list_variants", { scope: "collection", limit: 3 });
await call("co_list_recipes");
await call("co_list_keywords", { limit: 10 });

await client.close();
