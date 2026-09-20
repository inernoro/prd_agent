import { describe, expect, it } from 'vitest';

import { readDeploymentSseOutcome } from '../../src/services/infra-credential-rotation-runtime.js';

const frame = (event: string, payload: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

/**
 * 分支部署的权威结论只在终态事件的 payload 里：路由算完 hasError 之后发
 * `event: complete` 且 `ok: !hasError`——失败时它同样发 complete，只是 ok 是 false
 * （cds/src/routes/branches.ts 的终态分支）。
 *
 * 原判据是一条正则：响应里出现 `event: complete` 或任何 `"ok":true` 就算成功。
 * 两半都太宽，而它的下游是「把消费者标记为已部署，继续走向撤销旧凭据」——
 * 读错一次，就是拿着没部署成功的消费者去吊销它还在用的那份凭据（Codex P1，2026-09-15）。
 */
describe('部署 SSE 的终态结论', () => {
  it('终态 complete 带 ok:true 才算成功', () => {
    const body = frame('progress', { step: 'build' }) + frame('complete', { ok: true, message: '部署完成' });
    expect(readDeploymentSseOutcome(body)).toEqual({ ok: true, reason: 'ok' });
  });

  it('终态 complete 带 ok:false 是失败——这正是旧正则读成成功的那一种', () => {
    const body = frame('progress', { step: 'build' }) + frame('complete', { ok: false, message: '有服务未就绪' });
    // companion：这段响应确实含 `event: complete`，旧写法正是因此判成功的。
    expect(body).toContain('event: complete');
    expect(readDeploymentSseOutcome(body).ok, '失败的终态被读成了成功').toBe(false);
  });

  it('中途某一帧带 "ok":true 不算数，只认终态那一帧', () => {
    const body = frame('service', { name: 'api', ok: true })
      + frame('complete', { ok: false, message: '另一个服务失败' });
    expect(body).toContain('"ok":true');
    expect(readDeploymentSseOutcome(body).ok, '中途的 ok 被当成了整体结论').toBe(false);
  });

  it('以 error 事件收场是失败', () => {
    const body = frame('progress', { step: 'pull' }) + frame('error', { message: '拉取失败' });
    expect(readDeploymentSseOutcome(body)).toEqual({ ok: false, reason: 'deploy_error_event' });
  });

  it('根本没有终态事件（连接中断）是失败，不是成功', () => {
    expect(readDeploymentSseOutcome(frame('progress', { step: 'build' })).ok).toBe(false);
    expect(readDeploymentSseOutcome('').ok).toBe(false);
  });

  it('终态 payload 解析不出来是「不知道」，按失败处理', () => {
    expect(readDeploymentSseOutcome('event: complete\ndata: {不是 JSON\n\n'))
      .toEqual({ ok: false, reason: 'unparsable_complete_payload' });
  });

  it('CRLF 与多行 data 都能读出结论', () => {
    const body = 'event: complete\r\ndata: {"ok":\r\ndata: true}\r\n\r\n';
    expect(readDeploymentSseOutcome(body).ok).toBe(true);
  });
});

/**
 * 导出产物那一步原先启动的是编译进来的默认镜像，而能力探测、准备、主会话全走
 * this.image（options.image / CDS_OPEN_DESIGN_IMAGE 选出来的那个）。于是「配置的镜像
 * 验过了、能跑」与「导出时拉的是另一个镜像」可以同时成立：离线节点上整轮跑完，
 * 只在导出那一刻失败，失败原因还指向一个与本次运行无关的镜像（Codex P2，2026-09-15）。
 */
describe('OpenDesign 运行时镜像只有一个来源', () => {
  it('默认常量只出现在声明与构造兜底两处，没人拿它直接 docker run', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/services/agent-workspace-session-runtime.ts'), 'utf8');

    // companion：常量与兜底都还在。
    expect(source).toContain('export const OPEN_DESIGN_IMAGE =');
    expect(source).toContain("this.image = options.image || process.env.CDS_OPEN_DESIGN_IMAGE || OPEN_DESIGN_IMAGE;");

    // 三处：常量声明、环境变量名 CDS_OPEN_DESIGN_IMAGE（含同一串字符）、构造里的兜底。
    // 多出第四处，多半又有一个 docker run 绕过了 this.image。
    const uses = source.split('OPEN_DESIGN_IMAGE').length - 1;
    expect(uses, '常量被多引用了一处：多半又有一个 docker run 绕过了 this.image').toBe(3);
    expect(source, '导出校验必须用这次会话真正在跑的镜像')
      .not.toContain('shellQuote(OPEN_DESIGN_IMAGE)');
  });
});
