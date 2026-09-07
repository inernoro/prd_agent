import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CapabilityDot } from '../SignalDots';
import { capabilityVisual } from '../capabilityRegistry';
import { tierLabel, type CapabilityTier } from '../signalEncoding';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.resolve(here, '..', f), 'utf8');

/** 去掉注释再判：注释里的解释文字会左右结论（写着「不许只靠颜色」的注释本身就能满足断言）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 把一个色点真的渲染出来，读它落到 DOM 上的属性与样式 —— 断言的是结果，不是源码怎么拼的。 */
function renderDot(tier: CapabilityTier, over: { capKey?: string; title?: string; decorative?: boolean } = {}) {
  const html = renderToStaticMarkup(
    <CapabilityDot capKey={over.capKey ?? 'knowledge'} title={over.title ?? '知识库'} tier={tier} decorative={over.decorative} />,
  );
  const attr = (name: string) => html.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;
  const style = Object.fromEntries(
    (attr('style') ?? '')
      .split(';')
      .filter(Boolean)
      .map((d) => d.split(':').map((x) => x.trim()) as [string, string]),
  );
  return { html, attr, style };
}

const TIERS: CapabilityTier[] = ['write', 'full', 'read', 'none'];

/**
 * 视觉编码方向的硬契约：**颜色不能是唯一通道**。
 *
 * 这个方向的设计稿上白纸黑字写着它的代价 ——「色点要学一次才认得，且对色觉障碍不友好，
 * 真要用得配形状或长按提示」。所以落地时颜色只承担「这是哪一块能力」，
 * 而「这块能力给到哪一档」必须另有形状；识别能力名字也必须另有文字通道。
 *
 * 这几条删掉都不会红：把圆环改回半透明实心、把 aria-label 删掉，界面照样渲染、
 * 上面那批行为用例照样绿 —— 只有真的用灰度屏或读屏去看才现形。所以要有守卫。
 * 守卫看的是**渲染出来的 DOM**：改样式写法、换变量名都不该让它红，只有形状或标签真丢了才红。
 */
describe('色点：颜色不是唯一通道', () => {
  it('三档各用一种形状，不是同一形状的三种深浅', () => {
    const solid = renderDot('write').style;
    const ring = renderDot('read').style;
    const dashed = renderDot('none').style;

    // 能写 = 实心（有填充、无描边）
    expect(solid.background, '「能写」不是实心填充').toBeTruthy();
    expect(solid.background).not.toBe('transparent');
    expect(solid.border, '「能写」不该有描边，否则与圆环只差深浅').toBeUndefined();

    // 只读 = 圆环（描边 + 中心透空）—— 半透明实心与实心在灰度下分不开
    expect(ring.background, '「只读」中心必须透空').toBe('transparent');
    expect(ring.border, '「只读」不是描边圆环').toMatch(/solid/);

    // 未开 = 虚线圈（中心透空、描边是虚线，与圆环的实线也分得开）
    expect(dashed.background, '「未开」中心必须透空').toBe('transparent');
    expect(dashed.border, '「未开」不是虚线').toMatch(/dashed/);

    // 「已开」与「能写」都是拿满了，形状同为实心；区别只在说法（tierLabel），不在形状
    expect(renderDot('full').style).toEqual(solid);
  });

  it('每个色点都念得出名字与档位（读屏与长按都拿得到）', () => {
    for (const tier of TIERS) {
      const { attr } = renderDot(tier, { title: '知识库' });
      const expected = `知识库 · ${tierLabel(tier)}`;
      expect(attr('role'), `${tier} 档没有 role=img`).toBe('img');
      // label 必须同时含能力名与档位，只报其一等于没有文字冗余
      expect(attr('aria-label'), `${tier} 档读屏念不出名字与档位`).toBe(expected);
      expect(attr('title'), `${tier} 档长按提示不全`).toBe(expected);
    }
  });

  it('色点的颜色按能力 key 查，不按 title 查', () => {
    // 按 title 查会全部落到兜底中性色：五个点长得一模一样，颜色通道当场作废，
    // 而界面照常渲染、测试照常绿 —— 写这个组件时当场犯过一次。
    const byKey = renderDot('write', { capKey: 'knowledge', title: '随便一个名字' }).style.background;
    expect(byKey).toBe(capabilityVisual('knowledge').text);
    const other = renderDot('write', { capKey: 'visual', title: '随便一个名字' }).style.background;
    expect(other, '不同能力的点必须是不同颜色').not.toBe(byKey);
    // 圆环那一档的描边也走同一个颜色
    expect(renderDot('read', { capKey: 'knowledge' }).style.border).toContain(capabilityVisual('knowledge').text);
  });

  it('旁边已有同样文字的点做装饰，不让读屏把每块能力念两遍', () => {
    // 展开区逐块清单里名字与档位就在点的旁边；点再带一遍标签，读屏就是「知识库 · 能写、知识库、能写」。
    for (const tier of TIERS) {
      const { attr, style } = renderDot(tier, { decorative: true });
      expect(attr('aria-hidden'), `${tier} 档的装饰点没对读屏隐藏`).toBe('true');
      expect(attr('role')).toBeNull();
      expect(attr('aria-label')).toBeNull();
      // 只是不念，形状与颜色一个都不能少 —— 装饰点与正常点画出来必须一样
      expect(style).toEqual(renderDot(tier).style);
    }
    // 折叠态的色点行没有那段文字，那里的点必须保留标签 —— 所以是按位置二选一，不是一刀切。
    const page = stripComments(read('McpConsolePage.tsx'));
    const uses = page.match(/<CapabilityDot[^>]*\/>/g) ?? [];
    expect(uses.length, '页面里应有折叠态与展开区两处色点').toBe(2);
    expect(uses.filter((u) => /\bdecorative\b/.test(u)).length, '恰好一处（展开区）是装饰点').toBe(1);
  });
});

describe('图例：常识讲一次，例外才占卡片的位置', () => {
  const page = stripComments(read('McpConsolePage.tsx'));

  it('图例整屏只出现一次，不是每张卡重复一遍', () => {
    const uses = page.match(/<SignalLegend\s*\/>/g) ?? [];
    expect(uses.length, '图例出现了不止一次，那就退回成每张卡都在说同一件常识').toBe(1);
  });

  it('客户端卡上不再逐张重复「自动/手动」那两句常识', () => {
    // 这两句解释是常识，交给图例与左侧色带说一次；卡片上只留要用户去做点什么的话。
    // 它们仍然存在于展开区（用户想看随时点得开），所以断言的是**只出现一次**，不是消失。
    const auto = page.match(/跟着你的权限走/g) ?? [];
    const pinned = page.match(/按当初那份清单钉死/g) ?? [];
    expect(auto.length, '「跟着你的权限走」在页面里出现了不止一处').toBe(1);
    expect(pinned.length, '「按当初那份清单钉死」在页面里出现了不止一处').toBe(1);
  });

  it('左侧色带是手动档的可见标记，且不做唯一通道', () => {
    // 色带只是提示，档位的完整说法在展开区里有文字。色带自己 aria-hidden，
    // 免得读屏把一个没有名字的装饰条念出来。
    expect(page).toMatch(/aria-hidden[\s\S]{0,220}signal\.pinned \? 'var\(--accent-primary\)'/);
  });
});
