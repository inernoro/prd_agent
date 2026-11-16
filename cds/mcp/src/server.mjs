#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createBridge, readProjectCredentials } from './bridge.mjs';

async function main() {
  const credentials = await readProjectCredentials();
  const bridge = createBridge(credentials);
  const server = new Server({ name: 'cds-code-review', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await bridge.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await bridge.call(request.params.name, request.params.arguments);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      // The bridge never includes credentials, filesystem paths or response bodies
      // in errors. Validation errors only expose the caller's own input shape.
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : '代码审查调用失败' }] };
    }
  });
  server.onclose = () => { void bridge.close(); };
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'CDS MCP 启动失败'}\n`);
  process.exitCode = 1;
});
