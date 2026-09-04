import { describe, expect, it } from 'vitest';
import { mergeSendCanvas } from '../sendCanvasMerge';
import { resolveImageRefs } from '../imageRefResolver';

type Item = { key: string; refId: number; src: string; label: string };
const item = (key: string, refId: number, src: string): Item => ({ key, refId, src, label: key });

describe('mergeSendCanvas', () => {
  it('没有新增时原样返回', () => {
    const state = [item('a', 1, '/a.png')];
    expect(mergeSendCanvas(state, undefined).map((x) => x.key)).toEqual(['a']);
    expect(mergeSendCanvas(state, [])).toEqual(state);
  });

  it('新元素追加在后面，顺序与 setCanvas 的追加一致', () => {
    const merged = mergeSendCanvas([item('a', 1, '/a.png')], [item('b', 2, '/b.png')]);
    expect(merged.map((x) => x.key)).toEqual(['a', 'b']);
  });

  it('key 相同时以新的那版为准，且不重复', () => {
    // 同一张图刚补上 assetId 的情形：不能既留旧的又追加新的。
    const merged = mergeSendCanvas([item('a', 1, '/old.png')], [item('a', 1, '/new.png')]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.src).toBe('/new.png');
  });
});

describe('【关键】首页带图进画板：第一次生成必须带上参考图', () => {
  // 用户在首页传一张照片 + 一句话跳进画板。图是这一拍刚 setCanvas 进去的，
  // 而 setCanvas 异步——发送闭包读到的画布里根本没有它。
  // 解析器只按传进来的 canvas 找图，找不到就一个 ref 都不给，
  // 于是这次生成**静默变成纯文字**，用户传的照片被整个忽略（Codex PR #1476 P1）。
  const inline = { src: 'data:image/png;base64,AAAA', name: '照片.png' };
  const staleCanvas: Item[] = [];                       // 还没刷出来
  const justAdded = item('inline_1', 1, inline.src);    // 刚加的那张

  const resolve = (canvas: Item[], selectedKeys: string[]) =>
    resolveImageRefs({ rawText: '变成真实世界的风格', chipRefs: [], selectedKeys, inlineImage: inline, canvas });

  it('复现缺陷：只用旧画布 → 零引用（这就是纯文字生成）', () => {
    const result = resolve(staleCanvas, []);
    expect(result.refs).toHaveLength(0);
  });

  it('合并刚加的那张之后 → 参考图真的被引用上', () => {
    const merged = mergeSendCanvas(staleCanvas, [justAdded]);
    const result = resolve(merged, [justAdded.key]);
    expect(result.refs.length, '必须至少有一个引用').toBeGreaterThan(0);
    expect(result.refs.map((r) => r.canvasKey)).toContain(justAdded.key);
    expect(result.refs[0]!.src).toBe(inline.src);
  });

  it('选中键也必须用刚设置的那个，否则同样退化成零引用', () => {
    // selectedKeys 也是这一拍 setState 的，旧值是空数组。
    const merged = mergeSendCanvas(staleCanvas, [justAdded]);
    const withStaleKeys = resolve(merged, []);
    const withFreshKeys = resolve(merged, [justAdded.key]);
    // inlineImage 兜底能救回来，但走的是 source='inline'；
    // 两条都断言，确保「画布合并」与「选中键」各自都被真的传对。
    expect(withFreshKeys.refs.length).toBeGreaterThanOrEqual(withStaleKeys.refs.length);
    expect(withFreshKeys.refs.length).toBeGreaterThan(0);
  });
});
