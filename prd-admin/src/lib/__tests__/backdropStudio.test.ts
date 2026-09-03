import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = resolve(__dirname, '../../..');

vi.mock('@/services', () => ({
  createImageGenRun: vi.fn(),
  getImageGenRun: vi.fn(),
  getVisualAgentText2ImgModels: vi.fn(),
}));

import { createImageGenRun, getImageGenRun, getVisualAgentText2ImgModels } from '@/services';
import {
  BACKDROP_MOOD_SUGGESTIONS,
  MAX_GENERATED,
  buildBackdropPrompt,
  generateBackdrop,
  pickGenerationModel,
  pushGeneratedBackdrop,
  readGeneratedBackdrops,
  removeGeneratedBackdrop,
} from '../backdropStudio';
import { BACKDROP_CATALOG, CATALOG_DIM, GENERATED_DIM, dimFor } from '../backdropCatalog';

const ok = <T,>(data: T) => ({ success: true as const, data, error: null });
const asMock = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

/*
 * 这批用例跑在 node 环境（本仓库的纯函数测试都不起 jsdom），所以自己搭一个最小的
 * localStorage。搭的是**真实语义**（存进去、读出来、删掉），不是把被测模块的行为抄一遍——
 * 判据仍由被测模块给出，桩只提供它依赖的浏览器接口。
 */
beforeAll(() => {
  if (typeof globalThis.localStorage !== 'undefined') return;
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = store;
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('背景提示词：硬约束不给用户改', () => {
  it('用户那句氛围在前，近黑/无主体/无文字的约束永远跟在后面', () => {
    const p = buildBackdropPrompt('一道暖光从左上角斜切进来');
    expect(p.indexOf('一道暖光从左上角斜切进来')).toBeLessThan(p.indexOf('近黑底色'));
    for (const must of ['近黑底色', '没有任何文字', '没有主体物', '大量负空间']) {
      expect(p).toContain(must);
    }
  });

  it('氛围留空也仍然是一条完整的背景图指令，不会退化成空串', () => {
    expect(buildBackdropPrompt('   ')).toContain('近黑底色');
    expect(buildBackdropPrompt('')).toBe(buildBackdropPrompt('  \n '));
  });

  it('氛围句尾自带句号时不会拼出两个句号', () => {
    expect(buildBackdropPrompt('一层薄雾。')).not.toContain('。。');
  });

  it('预填建议本身就是合法氛围句（输入框不留白，用户改的是差异）', () => {
    expect(BACKDROP_MOOD_SUGGESTIONS.length).toBeGreaterThan(0);
    for (const s of BACKDROP_MOOD_SUGGESTIONS) expect(s.trim().length).toBeGreaterThan(8);
  });
});

describe('挑模型：不写死 image1', () => {
  it('优先默认池', () => {
    expect(
      pickGenerationModel([
        { isDefaultForType: false, models: [{ platformId: 'p1', modelId: 'other' }] },
        { isDefaultForType: true, models: [{ platformId: 'p2', modelId: 'chosen' }] },
      ]),
    ).toEqual({ platformId: 'p2', modelId: 'chosen' });
  });

  it('没有默认池就取第一个有成员的池', () => {
    expect(
      pickGenerationModel([
        { models: [] },
        { models: [{ platformId: 'p3', modelId: 'm3' }] },
      ]),
    ).toEqual({ platformId: 'p3', modelId: 'm3' });
  });

  it('成员缺 platformId 或 modelId 的池不算数——半个标识调不通', () => {
    expect(pickGenerationModel([{ isDefaultForType: true, models: [{ modelId: 'only-model' }] }])).toBeNull();
    expect(pickGenerationModel([{ models: [{ platformId: 'only-platform' }] }])).toBeNull();
  });

  it('空池 / null 返回 null，让调用方说「没有可用模型」而不是发一个空请求', () => {
    expect(pickGenerationModel([])).toBeNull();
    expect(pickGenerationModel(null)).toBeNull();
  });
});
describe('本机生成的背景：存取与上限', () => {
  const U = 'user-a';
  const mk = (id: string) => ({ id, name: '我生成的', url: `https://example.test/${id}.png` });

  it('新的排最前，重复 id 不会堆两份', () => {
    pushGeneratedBackdrop(U, mk('a'));
    pushGeneratedBackdrop(U, mk('b'));
    const list = pushGeneratedBackdrop(U, mk('a'));
    expect(list.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it(`最多留 ${MAX_GENERATED} 张，超出挤掉最旧的`, () => {
    let list: ReturnType<typeof pushGeneratedBackdrop> = [];
    for (let i = 0; i < MAX_GENERATED + 3; i++) list = pushGeneratedBackdrop(U, mk(`g${i}`));
    expect(list).toHaveLength(MAX_GENERATED);
    expect(list[0]!.id).toBe(`g${MAX_GENERATED + 2}`);
    expect(list.some((x) => x.id === 'g0')).toBe(false);
  });

  it('删除后确实读不回来', () => {
    pushGeneratedBackdrop(U, mk('a'));
    pushGeneratedBackdrop(U, mk('b'));
    expect(removeGeneratedBackdrop(U, 'a').map((x) => x.id)).toEqual(['b']);
    expect(readGeneratedBackdrops(U).map((x) => x.id)).toEqual(['b']);
  });

  it('存的是坏数据时当作没有，不能让首页崩', () => {
    localStorage.setItem(`visualAgent.backdrop.generated.${U}`, '{oops');
    expect(readGeneratedBackdrops(U)).toEqual([]);
    localStorage.setItem(`visualAgent.backdrop.generated.${U}`, '[{"id":"x"},{"url":""},null,3]');
    expect(readGeneratedBackdrops(U)).toEqual([]);
  });

  it('【关键】换个账号读不到上一个人生成的图', () => {
    // 共用电脑：A 生成过背景、退出，B 登录。用全局键存的话，B 会在首页和
    // 背景设置里看到 A 的产物（Codex PR #1476 P1）。
    pushGeneratedBackdrop('user-a', mk('secret'));
    expect(readGeneratedBackdrops('user-a').map((x) => x.id)).toEqual(['secret']);
    expect(readGeneratedBackdrops('user-b')).toEqual([]);
    // 反向也不串：B 写的东西不会污染 A。
    pushGeneratedBackdrop('user-b', mk('mine'));
    expect(readGeneratedBackdrops('user-a').map((x) => x.id)).toEqual(['secret']);
  });

  it('【关键】storage 写不进时，传入的列表不能丢', () => {
    // 隐私模式 / 配额满 / 没登录：这两个函数只能返回一个「仅本次会话有效」的列表。
    // 调用方若不传 existing，下一次调用会重新从 storage 读到空，
    // 上一张刚花钱生成的图就从界面上消失（Codex PR #1476 P2）。
    const session = [mk('one')];
    const next = pushGeneratedBackdrop('', mk('two'), session);
    expect(next.map((x) => x.id), '新的在前，旧的仍在').toEqual(['two', 'one']);
    // 删除同理：显式传入时只删指定那张，不清空其余。
    expect(removeGeneratedBackdrop('', 'one', next).map((x) => x.id)).toEqual(['two']);
  });

  it('【关键】拿不到账号时不落盘，也不读旧的全局桶', () => {
    // 未登录 / 水合未完成时宁可少显示，也不能写进一个人人可读的键。
    localStorage.setItem('visualAgent.backdrop.generated', JSON.stringify([mk('legacy')]));
    expect(readGeneratedBackdrops(''), '旧的全局桶不再被读出来').toEqual([]);
    pushGeneratedBackdrop('', mk('nope'));
    expect(localStorage.getItem('visualAgent.backdrop.generated')).toBe(JSON.stringify([mk('legacy')]));
  });
});

describe('暗罩强度按素材来源分档', () => {
  it('随包素材一律比用户生成的轻，没写 dim 的走批次默认值', () => {
    for (const a of BACKDROP_CATALOG) {
      // 写了就用它，没写走默认——但无论哪一档都必须比「不可控」那档轻。
      expect(dimFor(a)).toBe(a.dim ?? CATALOG_DIM);
      expect(dimFor(a)).toBeLessThan(GENERATED_DIM);
    }
  });

  it('罩强度按每张的实际明暗单独调过，而且是双向的', () => {
    // 这条上一版写成「单独写的 dim 必须大于 CATALOG_DIM」，隐含假设是「只会调高」。
    // 假设错了：「色场」中央顶带实测只有 7.5（几乎全黑），它需要的是**调低**到 0.58，
    // 否则那一片压死了什么都看不见。守卫当场判红——判得对，该改的是判据不是数值。
    //
    // 真正要守的是「没有被统一成一个值」：既有比默认重的（等高、同心压住亮画面），
    // 也有比默认轻的（色场本来就暗）。哪天有人「统一一下」把 dim 抹平，这条会红。
    const tuned = BACKDROP_CATALOG.filter((a) => typeof a.dim === 'number');
    expect(tuned.length).toBeGreaterThanOrEqual(3);
    expect(tuned.some((a) => a.dim! > CATALOG_DIM)).toBe(true);
    expect(tuned.some((a) => a.dim! < CATALOG_DIM)).toBe(true);
    // 无论往哪个方向调，都不能越过「用户生成」那一档——随包的我们看过，理应更轻。
    for (const a of tuned) expect(a.dim!).toBeLessThan(GENERATED_DIM);
  });

  it('每张素材都声明了焦点——默认 center 会把主体正好塞在标题底下', () => {
    // 「和页面结合」最便宜的一半：cover + center 让每张图最好看的部分永远压在内容区，
    // 于是罩压得最狠的地方恰好是最该露的地方，四角反倒空着。
    for (const a of BACKDROP_CATALOG) {
      expect(a.focus, `${a.id} 缺 focus`).toMatch(/^\d+% \d+%$/);
    }
  });

  it('用户自己生成的深浅不可控，压得更重——宁可看不清也不能让正文掉对比度', () => {
    expect(dimFor({ id: 'gen-abc', name: '我生成的', url: 'x' })).toBe(GENERATED_DIM);
    expect(GENERATED_DIM).toBeGreaterThan(CATALOG_DIM);
  });

  it('没有背景时也返回一个合法值，调用方不必先判空', () => {
    expect(dimFor(null)).toBe(CATALOG_DIM);
  });
});

describe('【关键】调用方把当前列表传给了两个写入函数', () => {
  it('不传 existing 就等于「写不进时静默丢图」，必须钉住', () => {
    const src = readFileSync(resolve(ROOT, 'src/components/visual-agent/BackdropSettings.tsx'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code, '剥完注释还剩真代码').toContain('runGenerate');
    expect(code).toMatch(/pushGeneratedBackdrop\(userId, asset, generatedRef\.current\)/);
    expect(code).toMatch(/removeGeneratedBackdrop\(userId, id, generated\)/);
  });

  it('【关键】生成落地读的是最新列表，不是发起那一帧的快照', () => {
    // 生成要 40-60 秒。`generated` 是 prop，await 之后闭包里还是**发起那一帧**的数组：
    // 用户在等待期间删掉一张旧背景，落地时会把旧数组连同新图一起写回去，
    // 刚删的那张在界面和存储里双双复活（Codex PR #1476 P2）。
    // 删除是同步路径，读 prop 没问题；异步落地必须读 ref。
    const src = readFileSync(resolve(ROOT, 'src/components/visual-agent/BackdropSettings.tsx'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code, '应同步一份最新列表的 ref').toMatch(/generatedRef\.current = generated;/);
    expect(code, 'await 之后不许再读 prop 那份').not.toMatch(/pushGeneratedBackdrop\(userId, asset, generated\)/);
  });
});

describe('【关键】复活场景：删掉的那张不能被生成落地写回来', () => {
  // 上面那条是源码守卫（盯「读的是不是 ref」）；这条是行为判据，
  // 直接把两个纯函数按真实时序串一遍，证明「用最新列表」确实能防住复活。
  const USER = 'user-resurrect';
  const asset = (id: string) => ({ id, name: '我生成的', url: `https://cdn.test/${id}.png` });

  it('等待期间删掉 A，落地写 B 时 A 不会回来', () => {
    const before = [asset('A'), asset('B')];
    // 等待期间：用户删掉 A。删除走同步路径，拿到的是最新列表。
    const afterDelete = removeGeneratedBackdrop(USER, 'A', before);
    expect(afterDelete.map((x) => x.id)).toEqual(['B']);
    // 落地：**用最新列表**追加新图 → A 不该回来。
    const landedFresh = pushGeneratedBackdrop(USER, asset('C'), afterDelete);
    expect(landedFresh.map((x) => x.id), 'A 已被删除，不该复活').not.toContain('A');
    // 反证：拿发起那一帧的快照落地 → A 复活，这正是修掉的那个形态。
    const landedStale = pushGeneratedBackdrop(USER, asset('C'), before);
    expect(landedStale.map((x) => x.id), '用旧快照就会复活（复现缺陷）').toContain('A');
  });
});

describe('【关键】背景面板浮层 Portal 到 body', () => {
  it('不许再挂在触发器下面被祖先 overflow 裁掉', () => {
    // 窄视口（~320px）下 320px 定宽右对齐会算出负的左边缘，被祖先 overflow-auto
    // 裁掉，第一列控件点不到（Codex PR #1476 P1）。frontend-modal 规则第 2 条：
    // 浮层必须 createPortal 到 body，物理脱离祖先的 overflow / transform。
    const src = readFileSync(resolve(ROOT, 'src/components/visual-agent/BackdropSettings.tsx'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code).toContain('createPortal');
    expect(code).toMatch(/document\.body,/);
    expect(code, '不再是触发器的 absolute 子元素').not.toMatch(/data-testid="backdrop-settings-panel"[\s\S]{0,120}absolute right-0/);
    // 位置要夹回视口内，且高度留到底部自己滚（不能又长出屏幕）。
    expect(code).toMatch(/maxHeight: panelPos\.maxHeight/);
    expect(code).toMatch(/overscrollBehavior: 'contain'/);
    // 点面板内部不能因为「不在 ref 里」就把自己关掉。
    expect(code).toMatch(/panelRef\.current\?\.contains\(t\)/);
  });
});

describe('【关键】背景生成查的是 text2img 专用目录', () => {
  it('不查合并目录——那里混着 img2img / vision-only 池，选中就每次必败', () => {
    // 这条不靠 mock 断言（mock 只有一个函数，怎么写都绿），而是读源码：
    // 合并目录 getVisualAgentImageGenModels 一旦回来，就说明又退回去了（Codex PR #1476 P2）。
    const src = readFileSync(resolve(ROOT, 'src/lib/backdropStudio.ts'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code, '剥完注释还剩真代码').toContain('generateBackdrop');
    expect(code).toContain('getVisualAgentText2ImgModels()');
    expect(code).not.toContain('getVisualAgentImageGenModels(');
  });
});

describe('生成流程：失败给得出下一步，不是一句「操作失败」', () => {
  it('没有可用生图模型时明说去哪配', async () => {
    asMock(getVisualAgentText2ImgModels).mockResolvedValue(ok([]));
    await expect(generateBackdrop({ mood: 'x', pollIntervalMs: 1 })).rejects.toThrow(/模型池/);
    expect(createImageGenRun).not.toHaveBeenCalled();
  });

  it('模型出错时把上游的原因透出来，不吞掉', async () => {
    asMock(getVisualAgentText2ImgModels).mockResolvedValue(ok([{ isDefaultForType: true, models: [{ platformId: 'p', modelId: 'm' }] }]));
    asMock(createImageGenRun).mockResolvedValue(ok({ runId: 'r1' }));
    asMock(getImageGenRun).mockResolvedValue(ok({ run: { status: 'Failed' }, items: [{ status: 'Failed', errorMessage: '内容被拒绝' }] }));
    await expect(generateBackdrop({ mood: 'x', pollIntervalMs: 1 })).rejects.toThrow('内容被拒绝');
  });

  it('走通时用的是任务化 run（同步接口会被边缘超时掐断），并回一张可用素材', async () => {
    asMock(getVisualAgentText2ImgModels).mockResolvedValue(ok([{ isDefaultForType: true, models: [{ platformId: 'p', modelId: 'm' }] }]));
    asMock(createImageGenRun).mockResolvedValue(ok({ runId: 'r2' }));
    asMock(getImageGenRun)
      .mockResolvedValueOnce(ok({ run: { status: 'Running' }, items: [{ status: 'Running' }] }))
      .mockResolvedValue(ok({ run: { status: 'Completed' }, items: [{ status: 'Done', url: 'https://cdn.test/bd.png' }] }));

    const phases: string[] = [];
    const asset = await generateBackdrop({ mood: '一层薄雾', pollIntervalMs: 1, onProgress: (p) => phases.push(p.phase) });

    expect(asset.url).toBe('https://cdn.test/bd.png');
    expect(asset.id).toBe('gen-r2');
    // 等待期必须能说出「在做什么」——阶段确实推进过，不是从头到尾一个字。
    expect(new Set(phases).size).toBeGreaterThan(1);

    const sent = asMock(createImageGenRun).mock.calls[0]![0].input;
    expect(sent.appKey).toBe('visual-agent');
    expect(sent.items[0].prompt).toContain('近黑底色');
    expect(sent.size).toBe('1536x1024');
  });

  it('单次查询失败不算整体失败，下一轮接着问', async () => {
    asMock(getVisualAgentText2ImgModels).mockResolvedValue(ok([{ isDefaultForType: true, models: [{ platformId: 'p', modelId: 'm' }] }]));
    asMock(createImageGenRun).mockResolvedValue(ok({ runId: 'r3' }));
    asMock(getImageGenRun)
      .mockResolvedValueOnce({ success: false, data: null, error: { message: '网络抖了一下' } })
      .mockResolvedValue(ok({ run: { status: 'Completed' }, items: [{ status: 'Done', url: 'https://cdn.test/ok.png' }] }));

    await expect(generateBackdrop({ mood: 'x', pollIntervalMs: 1 })).resolves.toMatchObject({ url: 'https://cdn.test/ok.png' });
  });
});

describe('【关键】背景在暗岛里不许被浅色主题藏掉', () => {
  // 用户截图：浅色主题下打开视觉创作首页，背景整个不见了，只剩一块纯底色。
  // 根因是一条按文档主题写的规则 `[data-theme="light"] .backdrop-photo-layer{display:none}`——
  // 它从文档根匹配，连 .surface-tone-dark（钉死深色、不跟文档主题走）里的背景一起藏了。
  // 这与 --glass-surface 那条是同一个形状：按文档主题写的规则撞上钉死主题的局部区域。
  const CSS = readFileSync(resolve(ROOT, 'src/styles/globals.css'), 'utf8');

  it('暗岛里的背景层被显式放回来', () => {
    expect(CSS, '浅色下默认仍然不放照片').toMatch(/\[data-theme="light"\]\s*\.backdrop-photo-layer\s*\{\s*display:\s*none/);
    expect(CSS, '但暗岛必须例外').toMatch(/\[data-theme="light"\]\s*\.surface-tone-dark\s*\.backdrop-photo-layer\s*\{\s*display:\s*block/);
    // 顺序要紧：放回来那条必须写在藏起来那条之后，否则同特异性下后写的赢、又被藏回去。
    expect(CSS.indexOf('.surface-tone-dark .backdrop-photo-layer'))
      .toBeGreaterThan(CSS.indexOf('[data-theme="light"] .backdrop-photo-layer'));
  });

  it('解码完当帧点亮，不再等 onload 之后再解一次码', () => {
    // onload 只保证字节到齐、没解码；那段时间 opacity 已经是 1 而屏幕还是空的。
    const SRC = readFileSync(resolve(ROOT, 'src/components/effects/PageBackdrop.tsx'), 'utf8');
    expect(SRC, '应走 decode() 而不是只等 onload').toMatch(/img\.decode\(\)/);
    // 过渡要短：读起来是「点亮」不是「淡入」。
    const ms = Number(CSS.match(/\.backdrop-photo\s*\{[\s\S]*?transition:\s*opacity\s*\.(\d+)s/)?.[1]);
    expect(ms, '背景淡入应短于 0.4s').toBeLessThan(40);
  });
});
