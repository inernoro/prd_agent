import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const RUNTIME = path.join(process.cwd(), 'src/services/agent-workspace-session-runtime.ts');

/**
 * 模型出口中继是一段注入容器执行的脚本字符串，单测跑不到它的真进程。
 * `pipe()` 不会把上游响应体的中断传给下游：MAP 发完响应头后断流，OpenDesign 要等 90 秒
 * 套接字超时才知道这一轮没了（Codex P1，2026-09-24）。独立设计执行服务里的同一个中继有真进程
 * 用例（design-runtime/opendesign/tests/components.test.ts），这里守住 CDS 这一份不回退。
 */
describe('模型出口中继：上游断流立刻掐掉下游', () => {
  const source = fs.readFileSync(RUNTIME, 'utf8');

  it('上游响应体 aborted / error 都会销毁下游响应', () => {
    const pipeAt = source.indexOf('upstreamResponse.pipe(res);');
    expect(pipeAt, '中继脚本里找不到 upstreamResponse.pipe(res)，结构可能被挪走了').toBeGreaterThan(-1);
    const after = source.slice(pipeAt, pipeAt + 600);
    expect(after).toContain('const abortDownstream = () => res.destroy();');
    expect(after).toContain("upstreamResponse.on('aborted', abortDownstream);");
    expect(after).toContain("upstreamResponse.on('error', abortDownstream);");
  });

  it('下游断开（不是正常写完）立刻掐掉上游模型调用，不再烧 token 占连接', () => {
    expect(source).toContain("res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });");
  });
});
