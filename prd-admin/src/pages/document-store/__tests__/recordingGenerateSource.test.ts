import { describe, expect, it } from 'vitest';
import { deriveTranscriptEditActivity } from '@/components/doc-browser/transcriptEditActivity';
import { resolveRecordingGenerateSource } from '../recordingGenerateSource';

const base = {
  storeId: 'store-owning',
  storeName: '会议库',
  title: '周一例会',
  noteId: 'note-1',
  noteMd: '## 摘要\n[00:01] 张三：开始',
  offline: false,
  pendingEditCount: 0,
};

describe('录音结果页「生成网页」的来源与挡板', () => {
  it('交出去的是转录笔记条目与条目真正归属的库，不是路由上的音频条目', () => {
    expect(resolveRecordingGenerateSource(base)).toEqual({
      kind: 'ready',
      source: { storeId: 'store-owning', entryId: 'note-1', title: '周一例会', storeName: '会议库' },
    });
  });

  it('转录还没出来：挡住并说明等什么', () => {
    expect(resolveRecordingGenerateSource({ ...base, noteMd: '  \n' })).toEqual({ kind: 'blocked', reason: '转录完成后可用' });
    expect(resolveRecordingGenerateSource({ ...base, noteId: '' })).toEqual({ kind: 'blocked', reason: '转录完成后可用' });
  });

  it('离线或本机还有未同步校对：挡住，免得生成用的是旧正文', () => {
    expect(resolveRecordingGenerateSource({ ...base, offline: true })).toEqual({ kind: 'blocked', reason: '联网后可用' });
    expect(resolveRecordingGenerateSource({ ...base, pendingEditCount: 3 })).toEqual({ kind: 'blocked', reason: '3 处校对同步后可用' });
  });

  it('标题为空时给一个可读的来源名，库名为空不硬塞空串', () => {
    const result = resolveRecordingGenerateSource({ ...base, title: '  ', storeName: '' });
    expect(result).toEqual({
      kind: 'ready',
      source: { storeId: 'store-owning', entryId: 'note-1', title: '录音转录', storeName: undefined },
    });
  });
});

describe('页内校对未落地时不许生成（生成读的是服务端正文）', () => {
  it('编辑框开着：挡住并说明修改还没保存', () => {
    expect(resolveRecordingGenerateSource({ ...base, editActivity: 'editing' }))
      .toEqual({ kind: 'blocked', reason: '转写修改还没保存' });
  });

  it('保存请求在飞：挡住并说明还在保存', () => {
    expect(resolveRecordingGenerateSource({ ...base, editActivity: 'saving' }))
      .toEqual({ kind: 'blocked', reason: '转写修改还在保存' });
  });

  it('空闲时照常放行', () => {
    expect(resolveRecordingGenerateSource({ ...base, editActivity: 'idle' }).kind).toBe('ready');
  });

  it('校对状态从跟读组件已有的三个状态推出：保存优先于编辑', () => {
    expect(deriveTranscriptEditActivity({ editingIndex: null, renamingSpeaker: null, savingEdit: false })).toBe('idle');
    expect(deriveTranscriptEditActivity({ editingIndex: 0, renamingSpeaker: null, savingEdit: false })).toBe('editing');
    expect(deriveTranscriptEditActivity({ editingIndex: null, renamingSpeaker: '张三', savingEdit: false })).toBe('editing');
    expect(deriveTranscriptEditActivity({ editingIndex: 2, renamingSpeaker: null, savingEdit: true })).toBe('saving');
  });
});

describe('一键整理 / 重新生成在途时不许生成（它跑完会改写同一条笔记）', () => {
  it('整理在途：挡住并说明还在整理', () => {
    expect(resolveRecordingGenerateSource({ ...base, reorganizing: true }))
      .toEqual({ kind: 'blocked', reason: '整理还在进行' });
  });

  it('整理结束后照常放行', () => {
    expect(resolveRecordingGenerateSource({ ...base, reorganizing: false }).kind).toBe('ready');
  });
});
