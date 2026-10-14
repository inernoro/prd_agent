import { describe, expect, it } from 'vitest';
import { resolveImageRefs } from '../imageRefResolver';

describe('图片复制占位符的发送契约', () => {
  const canvas = [{ key: 'original', refId: 7, src: 'https://example.com/original.png', label: '蓝色参考' }];
  it('编辑器中的旧编号按稳定身份更新，不与模型收到的编号分裂', () => {
    const result = resolveImageRefs({ rawText: '@img1 保持构图', chipRefs: [{ canvasKey: 'original', refId: 1 }], canvas });
    expect(result.ok).toBe(true);
    expect(result.cleanText).toBe('@img7 保持构图');
    expect(result.refs.map(ref => ref.refId)).toEqual([7]);
  });

  it('按图片身份恢复引用，并使用当前编号构造模型请求', () => {
    const result = resolveImageRefs({ rawText: '让 [@image:#1:original:https://example.com/original.png] 变为水彩', canvas });
    expect(result.ok).toBe(true);
    expect(result.refs).toHaveLength(1);
    expect(result.refs[0].canvasKey).toBe('original');
    expect(result.cleanText).toBe('让 @img7 变为水彩');
  });

  it('便携占位符与编号已变化的卡片混用时不会二次改绑图片', () => {
    const result = resolveImageRefs({
      rawText: '[@image:#2:second:https://example.com/second.png] 与 @img1 保持构图',
      chipRefs: [{ canvasKey: 'original', refId: 1 }],
      canvas: [...canvas, { key: 'second', refId: 1, src: 'https://example.com/second.png', label: '第二张参考' }],
    });
    expect(result.ok).toBe(true);
    expect(result.cleanText).toBe('@img1 与 @img7 保持构图');
    expect(result.refs.map(ref => ref.canvasKey)).toEqual(['original', 'second']);
  });

  it('失效复制引用阻止生成，保留输入并明确恢复动作', () => {
    const result = resolveImageRefs({ rawText: '[@image:#1:removed:https://example.com/removed.png] 保持构图', canvas });
    expect(result.ok).toBe(false);
    expect(result.errors.join('')).toMatch(/重新选择/);
    expect(result.refs).toHaveLength(0);
  });

  it('失效编辑器卡片不会被当前选中图片偷偷替换', () => {
    const result = resolveImageRefs({ rawText: '@img1 保持构图', chipRefs: [{ canvasKey: 'removed', refId: 1 }], selectedKeys: ['original'], canvas });
    expect(result.ok).toBe(false);
    expect(result.refs).toHaveLength(0);
  });
});
