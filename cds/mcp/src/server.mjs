#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createDtsBridge } from './dts-bridge.mjs';
import { createPlanningBridge } from './planning-bridge.mjs';
import { createBridge, readProjectCredentials } from './bridge.mjs';

async function main() {
  const credentials = await readProjectCredentials();
  const dts = process.argv.includes('--dts');
  const planning = process.argv.includes('--planning');
  if (dts && planning) throw new Error('请为数据同步和工程规划分别配置 MCP 服务');
  const bridge = planning ? createPlanningBridge(credentials) : dts ? createDtsBridge(credentials) : createBridge(credentials);
  const server = new Server({ name: planning ? 'cds-planning' : dts ? 'cds-dts' : 'cds-code-review', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await bridge.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await bridge.call(request.params.name, request.params.arguments);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      // The bridge never includes credentials, filesystem paths or response bodies
      // in errors. Validation errors only expose the caller's own input shape.
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'CDS 工具调用失败' }] };
    }
  });
  server.onclose = () => { void bridge.close(); };
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'CDS MCP 启动失败'}\n`);
  process.exitCode = 1;
});
