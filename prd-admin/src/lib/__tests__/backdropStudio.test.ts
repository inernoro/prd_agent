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
