#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createDtsBridge } from './dts-bridge.mjs';
import { createDesignBridge } from './design-bridge.mjs';
import { createPlanningBridge } from './planning-bridge.mjs';
import { createAccountBridge, readAccountCredentials } from './account-bridge.mjs';
import { createBridge, readProjectCredentials } from './bridge.mjs';

async function main() {
  const accounts = process.argv.includes('--accounts');
  const credentials = await (accounts ? readAccountCredentials() : readProjectCredentials());
  const dts = process.argv.includes('--dts');
  const planning = process.argv.includes('--planning');
  const design = process.argv.includes('--design');
  if ([dts, planning, design, accounts].filter(Boolean).length > 1) throw new Error('请为不同的 CDS 能力分别配置 MCP 服务');
  const [name, create] = accounts ? ['cds-accounts', createAccountBridge] : design ? ['cds-design', createDesignBridge] : planning ? ['cds-planning', createPlanningBridge]
    : dts ? ['cds-dts', createDtsBridge] : ['cds-code-review', createBridge];
  const bridge = create(credentials);
  const server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } });
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
