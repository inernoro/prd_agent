import { describe, expect, it } from 'vitest';
import {
  collectSemanticLayerFrames,
  computeHorizontalClampShift,
  planLayeredCopyRect,
  planSemanticLayerFrame,
  selectExportableLayers,
} from '@/lib/semanticLayerFrame';

describe('可拆解副本落在哪', () => {
  const source = { x: 100, y: 200, w: 1000, h: 500 };

  it('【关键】副本落在原图右侧，与原图等大，绝不盖在原图身上', () => {
    // 用户口述的步骤（2026-08-11）：「点击分层 → 创建一个新的同等大小的图片在当前图片的
    // 右侧 → 然后开始生成」。盖在原图上就没有参照物了，也就谈不上「表观上和参考图一致」。
    const rect = planLayeredCopyRect({ source, occupied: [source] });
    expect(rect.y).toBe(200);
    expect(rect.w).toBe(1000);
    expect(rect.h).toBe(500);
    expect(rect.x).toBeGreaterThanOrEqual(1100);
  });

  it('【关键】再拆一次要另找一块空地，不许压住上一次的结果', () => {
    // 2026-08-11 反馈：「我重新生成新的图层时候，他居然将原来的清理掉了？这是bug吗」——是。
    // 正确行为是右边再多一份，两份并排让用户比较着挑。
    const first = planLayeredCopyRect({ source, occupied: [source] });
    const second = planLayeredCopyRect({ source, occupied: [source, first] });
    expect(second.x).toBeGreaterThanOrEqual(first.x + first.w);
  });

  it('原图右边本来就有别的东西时继续往右找', () => {
    const blocker = { x: 1100, y: 200, w: 1000, h: 500 };
    const rect = planLayeredCopyRect({ source, occupied: [source, blocker] });
    expect(rect.x).toBeGreaterThanOrEqual(blocker.x + blocker.w);
  });

  it('挪不动时也必须收敛，不能死循环', () => {
    // 造一排堵到天边的元素：函数必须在有限步内返回，宁可重叠也不能挂住主线程。
    const wall = Array.from({ length: 200 }, (_, i) => ({ x: 1100 + i * 1100, y: 200, w: 1000, h: 500 }));
    const rect = planLayeredCopyRect({ source, occupied: [source, ...wall] });
    expect(Number.isFinite(rect.x)).toBe(true);
  });
});

describe('semantic layer frame', () => {
  it('【默认】各部件叠在副本那块地上，副本看起来就是原图', () => {
    // 用户心智（2026-08-10）：「分层之后不应该展开，而是还在原来的位置」——
    // 多数时候只是想把 logo 挪一点，摊开成一排等于让用户自己再拼一次。
    const source = { x: 100, y: 200, w: 1000, h: 500 };
    const copy = { x: 1220, y: 200, w: 1000, h: 500 };
    const result = planSemanticLayerFrame(source, 4, 'stacked', copy);

    expect(result.placements).toHaveLength(4);
    for (const placement of result.placements) {
      expect(placement).toEqual(copy);
    }
    // Frame 框住的就是副本那块，不额外占地方
    expect(result.frame).toEqual(copy);
  });

  it('spread 视图才铺开成一排，且每块仍按原图尺寸', () => {
    const copy = { x: 1220, y: 200, w: 1000, h: 500 };
    const result = planSemanticLayerFrame({ x: 100, y: 200, w: 1000, h: 500 }, 4, 'spread', copy);

    expect(result.frame.x).toBe(1220);
    expect(result.placements).toHaveLength(4);
    expect(result.placements[0].w / result.placements[0].h).toBe(2);
    expect(new Set(result.placements.map((item) => `${item.x}:${item.y}`)).size).toBe(4);
  });

  it('rebuilds a frame from independently movable persisted layers', () => {
    const frames = collectSemanticLayerFrames([
      { key: 'source', prompt: '海报' },
      { key: 'layer-2', x: 500, y: 250, w: 200, h: 100, layerGroupId: 'group-1', layerSourceKey: 'source', layerRole: 'layer', layerIndex: 2 },
      { key: 'layer-1', x: 250, y: 250, w: 200, h: 100, layerGroupId: 'group-1', layerSourceKey: 'source', layerRole: 'layer', layerIndex: 1 },
    ]);

    expect(frames).toHaveLength(1);
    expect(frames[0].sourceKey).toBe('source');
    expect(frames[0].name).toBe('海报');
    expect(frames[0].layerKeys).toEqual(['layer-1', 'layer-2']);
    expect(frames[0].w).toBeGreaterThan(450);
  });

  it('【关键】原图被拆过两次时，两个 Frame 各自指回同一张原图', () => {
    // 原图身上只能记住一个 groupId，所以原图必须靠图层的 layerSourceKey 反查。
    // 早先按「原图身上打的组号」找，拆第二次就把第一组的原图指针指没了。
    const frames = collectSemanticLayerFrames([
      { key: 'source', prompt: '海报' },
      { key: 'a1', x: 0, y: 0, w: 100, h: 100, layerGroupId: 'g1', layerSourceKey: 'source', layerRole: 'layer', layerIndex: 1 },
      { key: 'b1', x: 500, y: 0, w: 100, h: 100, layerGroupId: 'g2', layerSourceKey: 'source', layerRole: 'layer', layerIndex: 1 },
    ]);
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame.sourceKey).toBe('source');
      expect(frame.name).toBe('海报');
    }
  });

  it('keeps the selected-image toolbar inside the visible canvas', () => {
    expect(computeHorizontalClampShift({
      stageLeft: 0,
      stageRight: 1000,
      elementLeft: 760,
      elementRight: 1100,
    })).toBe(-112);

    expect(computeHorizontalClampShift({
      stageLeft: 0,
      stageRight: 1000,
      elementLeft: 300,
      elementRight: 640,
      currentShift: -80,
    })).toBe(0);
  });
});

describe('selectExportableLayers', () => {
  const base = [
    { key: 'source', layerGroupId: 'g1', layerRole: 'source' as const, src: 'src.png', createdAt: 1 },
    { key: 'l1', layerGroupId: 'g1', layerRole: 'layer' as const, layerIndex: 1, src: 'l1.png', createdAt: 10 },
    { key: 'l2', layerGroupId: 'g1', layerRole: 'layer' as const, layerIndex: 2, src: 'l2.png', createdAt: 11 },
  ];

  it('exports every layer once, ordered by index', () => {
    expect(selectExportableLayers(base, 'g1').map((item) => item.key)).toEqual(['l1', 'l2']);
  });

  it('exports the quick-edited version instead of the layer it replaced', () => {
    // 编辑产物继承同一 layerIndex；不取最新那版的话，编辑在画布上看得见、PSD 里却是编辑前的图。
    const edited = [...base, {
      key: 'qa_1', layerGroupId: 'g1', layerRole: 'layer' as const, layerIndex: 1, src: 'edited.png', createdAt: 99,
    }];
    const exported = selectExportableLayers(edited, 'g1');
    expect(exported.map((item) => item.key)).toEqual(['qa_1', 'l2']);
  });

  it('falls back to the original layer while an edit is still running or has failed', () => {
    // 生成中/失败的产物 src 为空，不能顶替掉原图层导出一张空层。
    const pending = [...base, {
      key: 'qa_1', layerGroupId: 'g1', layerRole: 'layer' as const, layerIndex: 1, src: '', createdAt: 99,
    }];
    expect(selectExportableLayers(pending, 'g1').map((item) => item.key)).toEqual(['l1', 'l2']);
  });

  it('ignores other groups, the source image, and unrelated items', () => {
    const mixed = [...base, {
      key: 'other', layerGroupId: 'g2', layerRole: 'layer' as const, layerIndex: 1, src: 'x.png', createdAt: 50,
    }];
    expect(selectExportableLayers(mixed, 'g1').map((item) => item.key)).toEqual(['l1', 'l2']);
    expect(selectExportableLayers(mixed, '')).toEqual([]);
  });

  it('keeps index-less layers separate instead of collapsing them into one', () => {
    const unnumbered = [
      { key: 'a', layerGroupId: 'g1', layerRole: 'layer' as const, src: 'a.png', createdAt: 1 },
      { key: 'b', layerGroupId: 'g1', layerRole: 'layer' as const, src: 'b.png', createdAt: 2 },
    ];
    expect(selectExportableLayers(unnumbered, 'g1')).toHaveLength(2);
  });

  it('lists still-generating placeholders for the panel but never for export', () => {
    // 图层面板要显示「第 3 层正在生成」的空位；导出链路拿到空 src 会写出一张空层。
    const withPlaceholder = [...base, {
      key: 'l3', layerGroupId: 'g1', layerRole: 'layer' as const, layerIndex: 3, src: '', createdAt: 12,
    }];
    expect(selectExportableLayers(withPlaceholder, 'g1', { includeEmpty: true }).map((item) => item.key))
      .toEqual(['l1', 'l2', 'l3']);
    expect(selectExportableLayers(withPlaceholder, 'g1').map((item) => item.key)).toEqual(['l1', 'l2']);
  });

  it('does not let an in-flight edit blank out the finished layer in the panel', () => {
    // includeEmpty 打开后，同一层的「编辑中空版本」比原成品新——按时间取最新会把成品挤掉，
    // 面板上那一层就凭空变成空位。有图的那版必须赢。
    const editing = [...base, {
      key: 'qa_1', layerGroupId: 'g1', layerRole: 'layer' as const, layerIndex: 1, src: '', createdAt: 99,
    }];
    const panel = selectExportableLayers(editing, 'g1', { includeEmpty: true });
    expect(panel.map((item) => item.key)).toEqual(['l1', 'l2']);
  });

  it('stacks by the panel-assigned order, falling back to the layer index', () => {
    // 面板里把 l2 拖到最下面：导出与合成都必须按 layerZ 走，不能还按 layerIndex。
    const reordered = [
      { ...base[1], layerZ: 2 },
      { ...base[2], layerZ: 1 },
    ];
    expect(selectExportableLayers(reordered, 'g1').map((item) => item.key)).toEqual(['l2', 'l1']);
    // 没调过顺序的旧数据没有 layerZ，仍按分层序号排。
    expect(selectExportableLayers(base, 'g1').map((item) => item.key)).toEqual(['l1', 'l2']);
  });
});
