import { describe, expect, it } from 'vitest';
import { capabilityTier, clientSignal, tierLabel } from '../signalEncoding';
import type { McpCapabilityDto } from '@/services/contracts/mcpConsole';

function cap(over: Partial<McpCapabilityDto> = {}): McpCapabilityDto {
  return {
    key: 'knowledge',
    title: '知识库',
    summary: '',
    readScope: 'document-store:read',
    writeScope: 'document-store:write',
    writeNeedsApproval: false,
    availableToMe: true,
    writeAvailableToMe: true,
    granted: false,
    todayCalls: 0,
    tools: [],
    ...over,
  };
}

const held = (...s: string[]) => new Set(s.map((x) => x.toLowerCase()));

describe('色点的档位判据', () => {
  it('读写都有的能力：拿到写档是实心，只拿到读档是只读', () => {
    expect(capabilityTier(cap(), held('document-store:write'))).toBe('write');
    expect(capabilityTier(cap(), held('document-store:read'))).toBe('read');
    expect(capabilityTier(cap(), held())).toBe('none');
  });

  /**
   * 只有写档的能力（视觉创作、文学创作：`readScope` 为空）。
   * 拿到那一个 scope 就是完整权限，不该因为「没有读档」而落到别处。
   */
  it('只有写档的能力：拿到那一个 scope 就是完整权限', () => {
    const visual = cap({ key: 'visual', title: '视觉创作', readScope: null, writeScope: 'visual-agent:use' });
    expect(capabilityTier(visual, held('visual-agent:use'))).toBe('write');
    expect(capabilityTier(visual, held())).toBe('none');
  });

  /**
   * 只有读档的能力（海鲜市场：`writeScope` 为空）—— 这条是这个判据最容易错的地方。
   *
   * 按「没拿到写档就是只读」写的话，海鲜市场会永远显示成空心圆环，
   * 等于告诉用户「还有一档没给它」，而那一档根本不存在。同一个功能里
   * 接入弹窗对海鲜市场什么都不标，两处说法就此打架。
   */
  it('只有读档的能力：拿到那一个 scope 也是完整权限，不许标成只读', () => {
    const market = cap({ key: 'market', title: '海鲜市场', readScope: 'marketplace.skills:read', writeScope: null });
    expect(capabilityTier(market, held('marketplace.skills:read'))).toBe('write');
    expect(capabilityTier(market, held())).toBe('none');
  });

  it('档位的说法只此一处，色点与文字不会各说各的', () => {
    expect(tierLabel('write')).toBe('能写');
    expect(tierLabel('read')).toBe('只能看');
    expect(tierLabel('none')).toBe('未开');
  });
});

describe('一把钥匙的色点行', () => {
  const catalog = [
    cap({ key: 'visual', title: '视觉创作', readScope: null, writeScope: 'visual-agent:use' }),
    cap({ key: 'knowledge', title: '知识库' }),
    cap({ key: 'market', title: '海鲜市场', readScope: 'marketplace.skills:read', writeScope: null }),
  ];

  it('色点按目录顺序排，顺序本身也是识别通道', () => {
    const s = clientSignal({ scopes: [], scopeMode: 'auto' }, catalog);
    expect(s.dots.map((d) => d.key)).toEqual(['visual', 'knowledge', 'market']);
  });

  /**
   * 摘要必须挂着数字。
   *
   * 色点是主通道，这句话是它的**文字冗余** —— 色觉障碍的用户、以及还没学会这套点的人，
   * 只靠这句话也要能读出同一件事。写成「已授权」这种放到任何一把钥匙上都成立的空话，
   * 冗余通道就等于没有。
   */
  it('摘要自带数字，不写放到任何钥匙上都成立的空话', () => {
    const none = clientSignal({ scopes: [], scopeMode: 'auto' }, catalog);
    expect(none.summary).toContain('3');
    expect(none.summary).not.toMatch(/已授权|正常|良好/);

    const all = clientSignal(
      { scopes: ['visual-agent:use', 'document-store:write', 'marketplace.skills:read'], scopeMode: 'auto' },
      catalog,
    );
    expect(all.summary).toContain('3');
    expect(all.grantedCount).toBe(3);
    expect(all.readOnlyCount).toBe(0);

    const partial = clientSignal({ scopes: ['visual-agent:use', 'document-store:read'], scopeMode: 'auto' }, catalog);
    expect(partial.grantedCount).toBe(2);
    expect(partial.readOnlyCount).toBe(1);
    expect(partial.summary).toContain('2');
    expect(partial.summary).toContain('只能看');
  });

  /**
   * 登记表里的开放接口走 `agent.*`，能力卡一个都对不上。
   * 不单独说的话，一把调得动东西的钥匙会被这一行报成「一块也没开」。
   */
  it('能力卡认领不到的 scope 单独留着，不被算成零', () => {
    const s = clientSignal({ scopes: ['agent.demo', 'visual-agent:use'], scopeMode: 'auto' }, catalog);
    expect(s.extraScopes).toEqual(['agent.demo']);
    expect(s.grantedCount).toBe(1);
  });

  /**
   * 只拿到读档时，那块能力的**读 scope 已经被认领**，不能再混进「另有 N 项开放接口」里
   * —— 否则同一个 scope 会被数两次，用户看到一个凭空多出来的接口数。
   */
  it('只读那一档的 scope 算已认领，不重复计入开放接口', () => {
    const s = clientSignal({ scopes: ['document-store:read'], scopeMode: 'auto' }, catalog);
    expect(s.extraScopes).toEqual([]);
    expect(s.readOnlyCount).toBe(1);
  });

  it('左侧色带认的是手动档', () => {
    expect(clientSignal({ scopes: [], scopeMode: 'auto' }, catalog).pinned).toBe(false);
    expect(clientSignal({ scopes: [], scopeMode: 'manual' }, catalog).pinned).toBe(true);
    // 旧后端不回这个字段时按手动处理：钉死是保守的那一侧，
    // 把手动档说成自动档会让用户以为「以后新能力它自动就有」，而实际不会有。
    expect(clientSignal({ scopes: [], scopeMode: undefined as never }, catalog).pinned).toBe(true);
  });
});
