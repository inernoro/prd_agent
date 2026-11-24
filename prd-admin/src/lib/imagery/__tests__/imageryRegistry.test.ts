import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  SYSTEM_IMAGERY_MODULES,
  BOOKSHELF_IMAGERY,
  HOME_IMAGERY,
  IMAGERY_STYLES,
  allImagerySlots,
  applyImageryStyleToPrompt,
  buildImageryPrompt,
  imageryStyle,
} from '@/lib/imagery';
import { VOLUMES } from '@/lib/bookshelf/catalog';

/**
 * 系统配图注册表的守卫。
 *
 * 这些图位不是「多一张装饰图」，而是**替换掉页面上那块兜底渲染**。所以两种漂移都要防：
 *   · 注册表登记了、页面上没人读它 → 管理员生成完，图永远不显示；
 *   · 页面上读了、注册表没登记 → 那个位置永远是兜底，管理员在设置页里找不到它。
 *
 * 两头都断言才拦得住（`predicate-and-wiring-discipline` 形状 2：链路只建了一半，
 * 编译过、测试绿、通读也挑不出）。
 */

const SRC_DIR = path.resolve(__dirname, '../../..');

function readAppSources(): string {
  const out: string[] = [];
  const skip = new Set(['node_modules', '__tests__', 'imagery']);
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if ((e.name.endsWith('.tsx') || e.name.endsWith('.ts')) && !e.name.includes('.test.')) {
        out.push(fs.readFileSync(full, 'utf8'));
      }
    }
  };
  walk(SRC_DIR);
  return out.join('\n');
}

const source = readAppSources();

describe('系统配图注册表', () => {
  it('slot 字符串全局唯一', () => {
    const seen = new Map<string, string>();
    const dup: string[] = [];
    allImagerySlots().forEach(({ module, slot }) => {
      const prev = seen.get(slot.slot);
      if (prev) dup.push(`${slot.slot}（${prev} 与 ${module.id}）`);
      else seen.set(slot.slot, module.id);
    });
    expect(dup, `slot 是这张图在库里的主键，撞了就是两个位置抢同一张图：${dup.join('、')}`).toEqual([]);
  });

  it('模块 id 唯一', () => {
    const ids = SYSTEM_IMAGERY_MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /*
   * 这一条是安全边界，不是命名洁癖：后端那个匿名端点
   * （`api/v1/landing/preview-assets`）只放行 `landing.` 前缀。
   * 换句话说——
   *   · public 模块的 slot 不带这个前缀 → 未登录页面上那一组图集体取不到，静默不显示；
   *   · internal 模块的 slot 带了这个前缀 → 它会被公网无鉴权面一并吐出去。
   * 两个方向都要断言。
   */
  it('public 模块的 slot 必须是 landing. 前缀（匿名端点只放行这一族）', () => {
    const bad = SYSTEM_IMAGERY_MODULES
      .filter((m) => m.reach === 'public')
      .flatMap((m) => m.slots.filter((s) => !s.slot.startsWith('landing.')).map((s) => `${m.id}:${s.slot}`));
    expect(bad, `这些 slot 在未登录页面上会取不到图：${bad.join('、')}`).toEqual([]);
  });

  it('internal 模块的 slot 不许用 landing. 前缀（否则被公网面吐出去）', () => {
    const bad = SYSTEM_IMAGERY_MODULES
      .filter((m) => m.reach === 'internal')
      .flatMap((m) => m.slots.filter((s) => s.slot.startsWith('landing.')).map((s) => `${m.id}:${s.slot}`));
    expect(bad, `这些 slot 会被匿名端点一并返回给未登录访客：${bad.join('、')}`).toEqual([]);
  });

  it('每个图位都有非空的画面描述（提示词不能是空壳）', () => {
    const empty = allImagerySlots()
      .filter(({ slot }) => slot.subject.trim().length < 40)
      .map(({ module, slot }) => `${module.id}:${slot.id}`);
    expect(empty, `这些图位的 subject 太短，生不出可用的图：${empty.join('、')}`).toEqual([]);
  });

  it('每个模块的默认拍法都真实存在', () => {
    const known = new Set(IMAGERY_STYLES.map((s) => s.key));
    const bad = SYSTEM_IMAGERY_MODULES.filter((m) => !known.has(m.defaultStyle)).map((m) => m.id);
    expect(bad, `这些模块的 defaultStyle 认不出来，会静默退回第一档：${bad.join('、')}`).toEqual([]);
  });
});

describe('图位接线', () => {
  /** 源码里出现过的、长得像系统配图 slot 的字面量 */
  const usedLiterals = new Set(
    Array.from(source.matchAll(/'((?:landing|bookshelf)\.[a-z0-9.-]+)'/g), (m) => m[1]),
  );

  it('对外首页的每个图位，源码里都有人读它', () => {
    const orphan = HOME_IMAGERY.slots.map((s) => s.slot).filter((slot) => !usedLiterals.has(slot));
    expect(
      orphan,
      '这些图位登记了，但源码里没有任何地方引用 —— 管理员生成出来的图永远不会显示：'
        + orphan.join('、'),
    ).toEqual([]);
  });

  it('源码里读到的每个 slot 字面量，注册表里都登记了', () => {
    const known = new Set(allImagerySlots().map((e) => e.slot.slot));
    const unregistered = [...usedLiterals].filter((slot) => !known.has(slot));
    expect(
      unregistered,
      '这些 slot 在页面里被引用，但注册表里没有对应条目，管理员在设置页里根本看不到它、'
        + '也就没法给它生成图：' + unregistered.join('、'),
    ).toEqual([]);
  });

  /*
   * 藏书阁走的是查表（`bookshelfVolumeSlot(vol.id)`）而不是字面量，
   * 所以上面那条字面量判据扫不到它 —— 这里换一条：确认它真的被读过。
   * 没有这条，把藏书阁的消费代码整段删掉，上面全部依旧绿。
   */
  it('藏书阁的卷面图有人读（整组 + 单张两条路都在）', () => {
    // 断言布尔而不是 expect(source).toContain(...)：后者失败时会把整份 src 源码
    // 当 diff 打出来（几万行），真正的那句话反而找不到了。
    expect(
      source.includes("useImageryModule('bookshelf')"),
      '没有任何地方调用 useImageryModule(\'bookshelf\')，整组卷面图取不到',
    ).toBe(true);
    expect(
      source.includes('bookshelfVolumeSlot('),
      '没有任何地方调用 bookshelfVolumeSlot，卷页与桌面卷卡拿不到自己那张图',
    ).toBe(true);
  });

  /*
   * 一卷一张，不多不少。加了第八卷却忘了给它配图位时，这条会红 ——
   * 而光看页面是看不出来的：没配图的卷会静默回落到汉字方块，一切正常。
   */
  it('藏书阁图位与卷一一对应', () => {
    const volumeIds = VOLUMES.map((v) => v.id).sort();
    const slotIds = BOOKSHELF_IMAGERY.slots.map((s) => s.id).sort();
    expect(slotIds, '图位的 id 必须就是 catalog 里的卷 id，多一个少一个都说明漏配或配错了')
      .toEqual(volumeIds);
  });
});

/**
 * 守卫：**换了拍法再点「整组重生成」，出来的必须真是新拍法。**
 *
 * 图位一旦生成过，库里存的是「上一次那个拍法的前缀 + 画面描述」。重新生成时如果
 * 直接把它拿去跑，换拍法这件事根本不会发生——用户切了拍法、七次生图的钱花掉了、
 * 出来还是老样子，而按钮上写着「整组重生成」。
 *
 * 另一头也得守住：画面描述可能被人手工调过（「这次别要雾」），一律重建会把他的
 * 修改冲掉。所以判据是两条一起：**前缀跟着当前拍法走，描述原样留着。**
 */
describe('重新生成时的拍法切换', () => {
  const slot = HOME_IMAGERY.slots[0];
  const styles = ['muted', 'mono'] as const;

  it('存过的提示词换拍法：前缀换新的，画面描述留着', () => {
    const stored = buildImageryPrompt(slot, styles[0]);
    const swapped = applyImageryStyleToPrompt(stored, slot, styles[1]);
    expect(swapped.startsWith(imageryStyle(styles[1]).prefix)).toBe(true);
    expect(swapped).not.toBe(stored);
    expect(swapped.endsWith(slot.subject)).toBe(true);
  });

  it('画面描述被手工改过时不许冲掉', () => {
    const edited = `${imageryStyle(styles[0]).prefix}\n\n山谷，这次别要雾`;
    const swapped = applyImageryStyleToPrompt(edited, slot, styles[1]);
    expect(swapped).toContain('这次别要雾');
    expect(swapped.startsWith(imageryStyle(styles[1]).prefix)).toBe(true);
  });

  it('没存过就按当前拍法重建', () => {
    expect(applyImageryStyleToPrompt(null, slot, styles[1])).toBe(buildImageryPrompt(slot, styles[1]));
    expect(applyImageryStyleToPrompt('   ', slot, styles[1])).toBe(buildImageryPrompt(slot, styles[1]));
  });

  it('认不出结构（没有空行分隔）就重建，不猜哪段是前缀', () => {
    expect(applyImageryStyleToPrompt('一整段没有空行的东西', slot, styles[1]))
      .toBe(buildImageryPrompt(slot, styles[1]));
  });

  it('每两档拍法的前缀都不同（否则上面几条是恒真的）', () => {
    const prefixes = IMAGERY_STYLES.map((s) => s.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  /*
   * 三条硬约束写在拍法前缀里，而不是每条 subject 里重复一遍。
   * 少了任何一条，这一档生出来的就不是能用的图：带字的图当产物展示必糊，
   * 插画风的图在「演示真实作品」的位置上一眼假。
   */
  it('每档拍法都自带那三条硬约束', () => {
    const missing = IMAGERY_STYLES.filter(
      (s) => !/no text of any kind/i.test(s.prefix) || !/photograph/i.test(s.prefix),
    ).map((s) => s.key);
    expect(missing, `这些拍法漏了硬约束（照片 / 画面里不许有字）：${missing.join('、')}`).toEqual([]);
  });
});
