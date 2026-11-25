import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FileText } from 'lucide-react';
import type { DesignAttachmentItem } from '../designAttachments';
import { UserBubble, WorkbenchComposer, composerState, fitComposerHeight, type ComposerChip } from './WorkbenchParts';

function render(overrides: Partial<Parameters<typeof WorkbenchComposer>[0]> = {}) {
  return renderToStaticMarkup(
    <WorkbenchComposer
      id="composer-test"
      value=""
      onChange={() => undefined}
      placeholder="说说要做成什么样"
      plusItems={[{ id: 'upload', title: '上传文件', description: '文档或纪要', icon: FileText, onPick: () => undefined }]}
      chips={[]}
      sendLabel="生成网页"
      onSend={() => undefined}
      {...overrides}
    />,
  );
}

const chip: ComposerChip = { key: 'notes', label: '会议纪要-1.md', status: '可以用', onRemove: () => undefined };
const file: DesignAttachmentItem = { key: 'pdf', fileName: '评审记录.pdf', status: 'ready', progress: 100, attachmentId: 'a1', size: 12000, textPreview: '架构决策会议纪要' };

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
  it('资料、文本输入与工具都在同一张卡片内', () => {
    const html = render({ value: '给合作方看', chips: [chip] });
    const inside = card(html);
    expect(inside).toContain('<textarea');
    expect(inside).toContain('aria-label="添加资料"');
    expect(inside).toContain('aria-label="已放入的资料"');
    expect(inside).toContain('会议纪要-1.md');
    expect(inside).toContain('aria-label="生成网页"');
    expect(html).toBe(inside);
    expect(inside.indexOf('会议纪要-1.md')).toBeLessThan(inside.indexOf('<textarea'));
  });

  it('上传预览位于文本框上方，发送后的同一个文件可回看且没有移除操作', () => {
    const inside = card(render({
      attachments: { items: [file], onRemove: () => undefined, onRetry: () => undefined, onReplace: () => undefined },
    }));
    expect(inside.indexOf('预览 评审记录.pdf')).toBeGreaterThan(-1);
    expect(inside.indexOf('预览 评审记录.pdf')).toBeLessThan(inside.indexOf('<textarea'));
    expect(inside).toContain('移除 评审记录.pdf');
    expect(inside).toContain('架构决策会议纪要');
    const sent = renderToStaticMarkup(<UserBubble text="生成 ADR 交接页" attachments={[file]} />);
    expect(sent).toContain('预览 评审记录.pdf');
    expect(sent).not.toContain('移除 评审记录.pdf');
  });

  it('上传、读取和两种失败分别显示进度、状态与相应恢复入口', () => {
    const inside = card(render({ attachments: {
      items: [
        { ...file, status: 'uploading', progress: 64 },
        { ...file, key: 'word', fileName: '交接.docx', status: 'reading' },
        { ...file, key: 'md', fileName: '清单.md', status: 'failed', canRetry: true, error: '没有完成上传，请重试' },
        { ...file, key: 'video', fileName: '演示.mp4', status: 'failed', rejected: true, error: '文件格式不支持' },
      ],
      onRemove: () => undefined, onRetry: () => undefined, onReplace: () => undefined,
    } }));
    expect(inside).toContain('64%');
    expect(inside).toContain('正在读取正文');
    expect(inside).toContain('重试上传');
    expect(inside).toContain('重新选择');
  });

  it('不能发送时按钮置灰，原因放在按钮提示中', () => {
    const html = render({ sendDisabled: true, sendDisabledReason: '资料还在上传，传完就能生成' });
    expect(html).toContain('data-composer-state="blocked"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="生成网页"/);
    expect(html).toContain('title="资料还在上传，传完就能生成"');
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

  it('按内容高度设高，夹在 50 到 160 之间', () => {
    const short = element(40);
    fitComposerHeight(short);
    expect(short.style.height).toBe('50px');
    const medium = element(120);
    fitComposerHeight(medium);
    expect(medium.style.height).toBe('120px');
    const long = element(900);
    fitComposerHeight(long);
    expect(long.style.height).toBe('160px');
  });
});
