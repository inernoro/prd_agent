/**
 * 藏书阁手机档守卫（390 终稿复刻）。
 *
 * 这一批判据全部对准 predicate-and-wiring-discipline 里那几种**不会变红**的形状：
 *
 *  - 形状 2（链路只建一半）：手机组件写好了、测试也绿，但 BookshelfPage 根本
 *    没有渲染它；或者 useExamSession 只被其中一侧用着，另一侧仍在自己算分。
 *    删掉那行接线不会有任何红灯，页面照样渲染——渲染的是旧的那棵树。
 *  - 形状 1（判据太窄）：?vol= 认不出时若沿用桌面的「回落卷一」，一个拼错的
 *    链接看起来会像「正常打开了卷一」，用户永远不知道自己打错了。
 *  - 形状 3（判据分裂）：档位一旦以字面量散进四个组件，第二屏必然与第一屏漂移——
 *    这正是改版前「歪歪扭扭」的成因，所以数值只许来自 appStoreTokens。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AS_TYPE, AS_SPACE, AS_SIZE } from '@/lib/appStoreTokens';
import { VOLUMES } from '@/lib/bookshelf/catalog';
import { selectedVolumeFromUrl, examIsActive } from '../mobile/BookshelfMobile';

const DIR = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(DIR, rel), 'utf-8');

describe('手机档 ?vol= 解析', () => {
  it('认得出的卷 id 给出那一卷', () => {
    VOLUMES.forEach((v) => {
      expect(selectedVolumeFromUrl(v.id)?.id).toBe(v.id);
    });
  });

  it('没有 vol 参数时停在落地页（返回 null，不预选任何卷）', () => {
    expect(selectedVolumeFromUrl(null)).toBeNull();
    expect(selectedVolumeFromUrl('')).toBeNull();
  });

  it('认不出的值停在落地页，绝不静默回落到卷一', () => {
    // 回落到卷一会让一个拼错的链接看起来「正常打开了」，
    // 收链接的人永远不知道自己看的不是别人要给他的那一卷。
    ['vol-nope', '../etc', '1', 'vol-boot '].forEach((bad) => {
      expect(selectedVolumeFromUrl(bad), `「${bad}」不该被解析成某一卷`).toBeNull();
    });
  });
});

describe('手机档接线（删掉不会红的那几处）', () => {
  it('BookshelfPage 真的按视口渲染 BookshelfMobile', () => {
    const src = read('BookshelfPage.tsx');
    expect(src).toContain('useIsMobile');
    expect(src, 'BookshelfPage 必须导入手机档外壳').toMatch(/import \{ BookshelfMobile \}/);

    /*
     * 判的是**结构**不是字面距离。
     * 第一版写成 `/isMobile[\s\S]{0,400}<BookshelfMobile/`，结果只是在那两行之间
     * 多写了几行注释就红了——它测的是「这两段文字挨得够近吗」，而不是
     * 「手机分支真的渲染了手机档吗」（形状 4a：断言实现的字面存在）。
     * 换成三个位置关系：手机分支存在、渲染点落在它之后、且早于桌面兜底的那次 return。
     */
    const branch = src.indexOf('if (isMobile)');
    const mobile = src.indexOf('<BookshelfMobile');
    const desktop = src.indexOf('<BookshelfDesktop');
    expect(branch, '找不到 if (isMobile) 分支').toBeGreaterThan(-1);
    expect(mobile, '找不到 <BookshelfMobile> 的渲染点').toBeGreaterThan(branch);
    expect(desktop, '桌面兜底必须排在手机分支之后').toBeGreaterThan(mobile);
  });

  it('考试状态机只有一处：桌面弹窗与手机整屏都用 useExamSession', () => {
    expect(read('ExamDialog.tsx'), '桌面弹窗没接 useExamSession，两边会各自算分')
      .toContain('useExamSession');
    expect(read('mobile/MobileExam.tsx'), '手机整屏没接 useExamSession')
      .toContain('ExamSession');
  });

  it('看板取数只有一处：桌面卡片与手机整屏都用 useTeamBoard', () => {
    // 那段防御是 2026-09-11 线上事故换来的，抄成两份就等于只修好一半。
    expect(read('TeamBoard.tsx')).toContain('useTeamBoard');
    expect(read('mobile/MobileBoard.tsx')).toContain('useTeamBoard');
    expect(read('TeamBoard.tsx'), '桌面看板不该再自己 fetch')
      .not.toContain('getBookshelfTeamBoard');
  });

  it('手机档五屏都被外壳渲染，没有建了一半的屏', () => {
    const shell = read('mobile/BookshelfMobile.tsx');
    ['MobileLanding', 'MobileVolume', 'MobileBook', 'MobileExam', 'MobileBoard'].forEach((c) => {
      expect(shell, `${c} 没有被外壳渲染，等于建了一半`).toMatch(new RegExp(`<${c}\\b`));
    });
  });
});

describe('手机档版式只走 appStoreTokens（防第二屏漂移）', () => {
  // 新增一屏必须加进这张表 —— 漏了的话它就是一块不受档位纪律约束的飞地，
  // 而「第二屏漂移」正是这组守卫存在的理由（本次 MobileBook 就差点漏掉）。
  const FILES = ['parts.tsx', 'MobileLanding.tsx', 'MobileVolume.tsx', 'MobileBook.tsx', 'MobileExam.tsx', 'MobileBoard.tsx']
    .map((f) => ({ f, src: read(`mobile/${f}`) }));

  it('终稿的字号档位在 AS_TYPE 里都有出处', () => {
    // 34 / 26 / 20 / 17 / 15 / 13 / 11 —— 量自设计稿，见
    // .claude/skills/design-replication/exports/bookshelf-mobile/design-spec.json
    const scale = new Set(Object.values(AS_TYPE).map((t) => (t as { fontSize: number }).fontSize));
    [34, 26, 20, 17, 15, 13, 11].forEach((n) => {
      expect(scale.has(n), `设计稿用了 ${n}px，AS_TYPE 里却没有这一档`).toBe(true);
    });
  });

  it('终稿的圆角与间距档位在 AS_SPACE / AS_SIZE 里都有出处', () => {
    expect(AS_SPACE.featuredRadius).toBe(22);
    expect(AS_SPACE.shelfCardRadius).toBe(18);
    expect(AS_SPACE.iconRadius).toBe(12);
    expect(AS_SPACE.pillRadius).toBe(999);
    expect(AS_SPACE.gutter).toBe(20);
    expect(AS_SPACE.sectionGap).toBe(36);
    expect(AS_SPACE.titleGap).toBe(16);
    expect(AS_SPACE.listItemPaddingY).toBe(14);
    expect(AS_SPACE.listItemPaddingX).toBe(16);
    expect(AS_SPACE.featuredPaddingY).toBe(18);
    expect(AS_SPACE.featuredPaddingX).toBe(20);
    expect(AS_SPACE.chipHeight).toBe(34);
    // 卷序块刻意小于 appIconSize 52：七行叠一屏时 52 会盖过处境卡组。
    expect(AS_SIZE.rowBoxSize).toBe(44);
    expect(AS_SIZE.rowBoxSize).toBeLessThan(AS_SIZE.appIconSize);
    expect(AS_SIZE.shelfCardWidth).toBe(308);
    expect(AS_SIZE.pillHeight).toBe(30);
  });

  it('组件里不写裸的圆角字面量（22/18/12/999 必须来自 AS_SPACE）', () => {
    FILES.forEach(({ f, src }) => {
      const hits = [...src.matchAll(/borderRadius:\s*(\d+)/g)].map((m) => m[1]);
      // 允许 4（成员通关小方块）与 22（勾选圈直径同名巧合已排除，圈走 pillRadius）
      const bad = hits.filter((h) => !['4'].includes(h));
      expect(bad, `${f} 里有写死的 borderRadius: ${bad.join('/')}——档位必须走 AS_SPACE`).toEqual([]);
    });
  });

  it('组件里不写裸的十六进制颜色（双皮肤靠 token，不靠字面量）', () => {
    FILES.forEach(({ f, src }) => {
      const hex = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect(hex, `${f} 里出现硬编码颜色 ${hex.join('/')}`).toEqual([]);
    });
  });

  it('粗野骨架已从手机档退场：不再有墨边与硬投影', () => {
    FILES.forEach(({ f, src }) => {
      expect(src, `${f} 还留着 --shelf-edge 墨边，这正是 390 宽「歪歪扭扭」的成因`)
        .not.toContain('--shelf-edge');
      // 终稿只保留 hairline(1px) 与勾选圈(1.5px)，不许回到 2.5/3/4px 墨边
      const widths = [...src.matchAll(/(\d+(?:\.\d+)?)px solid/g)].map((m) => m[1]);
      widths.forEach((w) => {
        expect(['1', '1.5'], `${f} 出现 ${w}px 描边，手机档只允许 1px hairline 与 1.5px 勾选圈`)
          .toContain(w);
      });
    });
  });

  it('角色 chip 不给没有书的角色留入口', () => {
    const src = read('mobile/MobileLanding.tsx');
    // 终稿画了八个 chip，后五个在 catalog 里没有对应的 track 取值。
    // 留着它们就是给用户一条走进空屋子的路（no-rootless-tree）。
    ['测试', '设计', '运维', '技术负责人', '新人'].forEach((label) => {
      expect(src, `chip「${label}」没有对应的 track 数据，不该出现在筛选行`)
        .not.toMatch(new RegExp(`label:\\s*'${label}'`));
    });
  });
});

describe('藏书阁的面走自己的一档，不蹭全局 --bg-card', () => {
  const SHELF_FILES = [
    'BookshelfPage.tsx', 'TeamBoard.tsx', 'ExamDialog.tsx',
    'mobile/parts.tsx', 'mobile/MobileLanding.tsx', 'mobile/MobileVolume.tsx',
    'mobile/MobileExam.tsx', 'mobile/MobileBoard.tsx',
  ];

  it('不再直接用 --bg-card / --bg-sunken / --bg-input', () => {
    /*
     * 2026-09-14 用户：「太透明了」。全局 --bg-card 在暗档是 8% 白叠在 #141418 上，
     * 合成出来只比底色亮 7%，这一页大面积铺开就发虚。
     * 全局那档不能动（全站 420 处在用），所以藏书阁有自己的 --shelf-surface。
     * 这条守的是「别有人顺手改回去」——改回去不会报错，只会悄悄变虚回原样。
     */
    SHELF_FILES.forEach((f) => {
      const src = read(f);
      ['var(--bg-card)', 'var(--bg-sunken)', 'var(--bg-input)'].forEach((tok) => {
        expect(src, `${f} 用了 ${tok}，该用 --shelf-surface / --shelf-inset`)
          .not.toContain(tok);
      });
    });
  });

  it('两档的面都比底色拉开足够距离，嵌块方向各自正确', () => {
    const css = fs.readFileSync(
      path.resolve(__dirname, '../../../styles/tokens.css'), 'utf-8',
    );
    const grab = (scope: string, name: string) => {
      const block = css.slice(css.indexOf(scope));
      const m = block.match(new RegExp(`\\${name}:\\s*(#[0-9A-Fa-f]{6})`));
      return m ? m[1] : null;
    };
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
    };

    /*
     * 两条判据，各自治一种翻车：
     *
     * 1) 面与底色的距离要够。2026-09-14 第一次调这个值时我从 +18.9 改到 +22.2
     *    就宣布修好了，实际肉眼几乎看不出差别——「我改大了一点」的手感不是判据，
     *    量出来的差值才是。下限 24 是 iOS 暗档分组卡对纯黑底那个台阶的量级。
     *
     * 2) 嵌块的方向**按主题相反**，不是笔误：
     *    暗档没法再往更暗走，iOS 的惯例是嵌入层更亮（#1C1C1E 卡 / #2C2C2E 嵌块），
     *    设计稿算出来也正是 39 → 54；浅档反过来，纸面是最亮的一层。
     *    这条原先写成「嵌块必须比面暗」，那是把我自己的直觉当judgment判据写进了守卫。
     */
    /*
     * 门槛按主题分开，不是把浅档调松了事——是浅档物理上到不了 24：
     * 底色 #EEEAE3 亮度 234.4，到纯白只剩 +20.6 的空间，而 themeSystem 的契约
     * 又禁止浅档出现近白值。现在的 #FDFBF8 是 +16.9，已经吃掉可用空间的 82%。
     * 14 这个下限刚好卡死「滑回原来的 #F8F5EF（+10.8）」这条退路。
     * 暗档没有天花板问题，按 iOS 的台阶量级给 24。
     */
    const CASES = [
      { scope: ':root', base: '--bg-base', insetLighter: true, minGap: 24 },
      { scope: '[data-theme="light"]', base: '--bg-base', insetLighter: false, minGap: 14 },
    ];

    for (const { scope, base, insetLighter, minGap } of CASES) {
      const baseHex = grab(scope, base);
      const surface = grab(scope, '--shelf-surface');
      const inset = grab(scope, '--shelf-inset');
      expect(surface, `${scope} 缺 --shelf-surface（token 必须暗浅双写）`).toBeTruthy();
      expect(inset, `${scope} 缺 --shelf-inset`).toBeTruthy();
      expect(baseHex, `${scope} 缺 ${base}`).toBeTruthy();

      const gap = Math.abs(lum(surface!) - lum(baseHex!));
      expect(gap, `${scope} 的面只比底色差 ${gap.toFixed(1)} 亮度（下限 ${minGap}），看着还是发虚`)
        .toBeGreaterThanOrEqual(minGap);

      const delta = lum(inset!) - lum(surface!);
      expect(Math.abs(delta), `${scope} 的嵌块与面差 ${Math.abs(delta).toFixed(1)}，分不出层`)
        .toBeGreaterThanOrEqual(8);
      if (insetLighter) {
        expect(delta, `${scope}（暗档）的嵌块该比面更亮——暗色里没法再往更暗走`)
          .toBeGreaterThan(0);
      } else {
        expect(delta, `${scope}（浅档）的嵌块该比面更暗——纸面是最亮的一层`)
          .toBeLessThan(0);
      }
    }
  });
});

describe('桌面档点了要真的「去」', () => {
  it('痛点卡与卷卡都走 gotoVolume，不是只换选中色', () => {
    const src = read('BookshelfPage.tsx');
    /*
     * 2026-09-14：卡片上写着「去 懂业务 →」，点下去只把选中态换了个颜色——
     * 真正变化的书目区在下面两屏之外，屏幕上什么都没动。
     * 这条接线删掉不会有任何红灯：页面照常渲染，选中色照常变，只是「去」变成了空话。
     */
    expect(src, '痛点卡不该只 setActiveVolumeId，要带用户去书目区')
      .not.toContain('onClick={() => setActiveVolumeId(r.volumeId)}');
    expect(src, '卷卡同上')
      .not.toContain('onClick={() => setActiveVolumeId(vol.id)}');
    expect(src).toContain('onClick={() => gotoVolume(r.volumeId)}');
    expect(src).toContain('onClick={() => gotoVolume(vol.id)}');

    // gotoVolume 必须真的滚过去，而不是换了个名字的同一件事
    const fn = src.slice(src.indexOf('function gotoVolume'), src.indexOf('function gotoVolume') + 400);
    expect(fn, 'gotoVolume 里没有 scrollIntoView，改名不等于修好').toContain('scrollIntoView');
    expect(fn, '滚动目标必须是书目区的 ref').toContain('booksRef');
    // 尊重系统的「减少动态效果」偏好，不硬写 smooth
    expect(fn, '动效要看系统偏好，不许写死 smooth').toContain('reducedMotion');
  });

  it('书目区挂了 ref，滚动有落点', () => {
    const src = read('BookshelfPage.tsx');
    expect(src).toContain('ref={booksRef}');
  });
});

describe('桌面档没有被改动', () => {
  it('桌面仍保留粗野骨架（墨边 + 硬投影 + 网格）', () => {
    const src = read('BookshelfPage.tsx');
    expect(src).toContain('--shelf-edge');
    expect(src).toContain('GRID_BG');
    expect(src, '桌面根容器不该再带手机断点类名（手机走的是另一棵树）')
      .not.toContain('sm:w-full sm:ml-0');
  });
});

describe('考试屏必须绑在卷上（治浏览器返回把它甩下）', () => {
  /*
   * 考试不进 URL，所以手势返回只改 ?vol=、不经过 MobileExam 的 onBack。
   * 判据若只是一个「点过开始考」的布尔量，它会一直挂着：接着点开另一卷，
   * 那一卷会直接渲染成考试屏，而且带着上一卷的作答与交卷结果——
   * 用户还没开始考，屏幕上已经有答案和成绩了。
   *
   * 把 examIsActive 改回 `examOfVolumeId !== null`，这里第二条必红。
   */
  it('在哪一卷上开的考，就只在那一卷上成立', () => {
    expect(examIsActive('vol-boot', 'vol-boot')).toBe(true);
  });

  it('换到另一卷，考试屏不许跟过去', () => {
    expect(examIsActive('vol-ai', 'vol-boot')).toBe(false);
  });

  it('返回落地页（没有 ?vol=）时考试屏一律不成立', () => {
    expect(examIsActive(null, 'vol-boot')).toBe(false);
  });

  it('没开过考就是没开过', () => {
    expect(examIsActive('vol-boot', null)).toBe(false);
  });
});
