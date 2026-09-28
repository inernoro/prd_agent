import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FileText } from 'lucide-react';
import { WorkbenchComposer, composerState, fitComposerHeight, type ComposerChip } from './WorkbenchParts';

function render(overrides: Partial<Parameters<typeof WorkbenchComposer>[0]> = {}) {
  return renderToStaticMarkup(
    <WorkbenchComposer
      id="composer-test"
      value=""
      onChange={() => undefined}
      placeholder="说说要做成什么样"
      plusItems={[{ id: 'upload', title: '上传文件', description: '文档或纪要', icon: FileText, onPick: () => undefined }]}
      chips={[]}
      sendLabel="生成网页 · 约 9–12 分钟"
      onSend={() => undefined}
      hint="点下去：对话里一步步显示进度"
      options={<span data-testid="options">产出形式</span>}
      {...overrides}
    />,
  );
}

const chip: ComposerChip = { key: 'notes', label: '会议纪要-1.md', status: '可以用', onRemove: () => undefined };

/** 取出输入卡片（带 data-composer-state 的那一层）自身的 HTML。 */
function card(html: string): string {
  const start = html.indexOf('data-composer-state=');
  expect(start).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<div', start);
  let depth = 0;
  const tag = /<\/?div\b[^>]*>/g;
  tag.lastIndex = open;
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(open, match.index + match[0].length);
  }
  throw new Error('卡片没有闭合');
}

describe('WorkbenchComposer 状态', () => {
  it('生成中一律是 busy，哪怕同时不能发送', () => {
    expect(composerState({ disabled: true, sendDisabled: true, value: 'x', chipCount: 1 })).toBe('busy');
  });

  it('不能发送时是 blocked', () => {
    expect(composerState({ sendDisabled: true, value: '', chipCount: 0 })).toBe('blocked');
  });

  it('写了要求或放了资料就是 ready，什么都没有但允许发送是 idle', () => {
    expect(composerState({ value: '改短标题', chipCount: 0 })).toBe('ready');
    expect(composerState({ value: '   ', chipCount: 1 })).toBe('ready');
    expect(composerState({ value: '  ', chipCount: 0 })).toBe('idle');
  });
});

describe('WorkbenchComposer 布局', () => {
  it('输入区、左下角的「+」与资料、右下角的发送按钮同在一张卡片里；选项在卡片之外', () => {
    const html = render({ value: '给合作方看', chips: [chip] });
    const inside = card(html);
    expect(inside).toContain('<textarea');
    expect(inside).toContain('aria-label="添加资料"');
    expect(inside).toContain('aria-label="已放入的资料"');
    expect(inside).toContain('会议纪要-1.md');
    expect(inside).toContain('aria-label="生成网页 · 约 9–12 分钟"');
    expect(inside).not.toContain('data-testid="options"');
    expect(html).toContain('data-testid="options"');
    // 资料排在发送按钮之前：左下角放引用，右下角才是发送。
    expect(inside.indexOf('会议纪要-1.md')).toBeLessThan(inside.indexOf('aria-label="生成网页 · 约 9–12 分钟"'));
  });

  it('发送按钮只放图标，按下去得到什么写在卡片下方的说明行，且不重复按钮文字', () => {
    const html = render({ value: '给合作方看', hint: '点下去：对话里一步步显示进度；按经验值约 9–12 分钟' });
    expect(html).toContain('data-composer-state="ready"');
    const hintLine = html.slice(html.lastIndexOf('<p'));
    expect(hintLine).toContain('点下去：对话里一步步显示进度；按经验值约 9–12 分钟');
    // 耗时只说一次：按钮文字（含耗时）只在读屏标签与悬停提示里。
    expect(hintLine).not.toContain('生成网页 · 约 9–12 分钟');
  });

  it('不能发送时按钮置灰，说明行换成原因', () => {
    const html = render({ sendDisabled: true, sendDisabledReason: '资料还在上传，传完就能生成' });
    expect(html).toContain('data-composer-state="blocked"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="生成网页 · 约 9–12 分钟"/);
    expect(html).toContain('资料还在上传，传完就能生成');
    expect(html).not.toContain('点下去：对话里一步步显示进度');
  });

  it('生成中输入与发送都锁住', () => {
    const html = render({ value: '给合作方看', disabled: true, sendLabel: '正在生成…' });
    expect(html).toContain('data-composer-state="busy"');
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="正在生成…"/);
  });

  it('接近字数上限才显示字数', () => {
    expect(render({ value: 'a'.repeat(3499) })).not.toContain('/4000');
    expect(render({ value: 'a'.repeat(3500) })).toContain('3500/4000');
  });
});

describe('fitComposerHeight', () => {
  function element(scrollHeight: number) {
    return { scrollHeight, style: { height: '' } } as unknown as HTMLTextAreaElement;
  }

  it('按内容高度设高，夹在 96 到 240 之间', () => {
    const short = element(40);
    fitComposerHeight(short);
    expect(short.style.height).toBe('96px');
    const medium = element(180);
    fitComposerHeight(medium);
    expect(medium.style.height).toBe('180px');
    const long = element(900);
    fitComposerHeight(long);
    expect(long.style.height).toBe('240px');
  });
});
