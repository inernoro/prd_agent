/**
 * 自动 / 手动两档的接线守卫。
 *
 * 这两条接线删掉之后，页面照常渲染、类型照常过、上面那几个纯函数测试照常绿 ——
 * 只有真的去接一台客户端、并且等到平台下次新增能力，才会发现「自动档」从来没生效过。
 * 正是 predicate-and-wiring-discipline 形状 2（链路只建一半）说的那种静默退化。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8');

describe('自动 / 手动能力范围的接线', () => {
  it('接入弹窗签发时必须把 scopeMode 一起发过去', () => {
    const source = read('ConnectAgentDialog.tsx');
    const call = source.slice(
      source.indexOf('await createAgentApiKey('),
      source.indexOf('if (!res.success'),
    );
    expect(call.length).toBeGreaterThan(0);
    // 不传的话服务端按 manual 建：钥匙被钉在弹窗当时算出的那份预览清单上，
    // 平台以后新上的能力永远不会自动进来，而界面上写着「跟着你的权限走」。
    expect(call).toContain('scopeMode');
  });

  it('模式由「这份清单跟默认档一不一样」决定，不由「有没有点开过面板」决定', () => {
    const source = read('ConnectAgentDialog.tsx');
    expect(source).toMatch(/scopeMode[^=]*=\s*samePicks\(picks, defaults\)\s*\?\s*'auto'\s*:\s*'manual'/);
  });

  it('客户端那一行要把模式与「你还没给它什么」说出来', () => {
    // 手动档的语义是「用户知道、钥匙没权限」。不渲染这两样，前半句就没了：
    // 用户既不知道它已经被钉死，也不知道自己还能给什么。
    const source = read('McpConsolePage.tsx');
    expect(source).toContain('client.scopeMode');
    expect(source).toContain('missingCapabilities');
  });

  it('接入弹窗只有两屏，选能力收在高级设置里', () => {
    const source = read('ConnectAgentDialog.tsx');
    // 主路径上不放选择（minimal-user-input）：默认那一屏只有名字和一个可改的入口
    expect(source).toContain('高级设置');
    expect(source).not.toContain("type Step = 'capabilities'");
  });
});
