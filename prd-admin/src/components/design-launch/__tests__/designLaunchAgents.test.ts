import { describe, expect, it } from 'vitest';
import { DESIGN_ARTIFACT_TARGETS, parseDesignArtifactLaunch } from '@/lib/designArtifactLaunch';
import { buildGenerateLaunchPath, contentSourceEntryId, DESIGN_LAUNCH_AGENTS } from '../designLaunchAgents';

describe('生成入口的智能体清单', () => {
  it('每个生成目标都有一张卡，且只有一张', () => {
    expect(DESIGN_LAUNCH_AGENTS.map((agent) => agent.target)).toEqual([...DESIGN_ARTIFACT_TARGETS]);
    for (const agent of DESIGN_LAUNCH_AGENTS) {
      expect(agent.title.trim()).not.toBe('');
      expect(agent.description.trim()).not.toBe('');
    }
  });

  it('入口构造的深链能被工作台原样解析回来源', () => {
    const source = { storeId: 'store-a', entryId: 'entry-b', title: '周会 & 复盘', storeName: '团队知识库' };
    for (const target of DESIGN_ARTIFACT_TARGETS) {
      const path = buildGenerateLaunchPath(target, source);
      expect(parseDesignArtifactLaunch(path.slice(path.indexOf('?')))).toEqual({
        target,
        sourceStoreId: 'store-a',
        sourceEntryId: 'entry-b',
        sourceTitle: '周会 & 复盘',
        sourceStoreName: '团队知识库',
      });
    }
  });
});

describe('条目正文落在哪一条', () => {
  it('音频条目取转录笔记：旧数据指向独立笔记，新数据指向自身', () => {
    expect(contentSourceEntryId({ id: 'audio', contentType: 'audio/webm', metadata: { transcribe_entry_id: 'note' } })).toBe('note');
    expect(contentSourceEntryId({ id: 'audio', contentType: 'Audio/MP4', metadata: { transcribe_entry_id: 'audio' } })).toBe('audio');
    expect(contentSourceEntryId({ id: 'video', contentType: 'video/mp4', metadata: { transcribe_entry_id: 'note-v' } })).toBe('note-v');
  });

  it('没有转录或不是音视频：就是条目自身', () => {
    expect(contentSourceEntryId({ id: 'audio', contentType: 'audio/webm' })).toBe('audio');
    expect(contentSourceEntryId({ id: 'audio', contentType: 'audio/webm', metadata: { transcribe_entry_id: '  ' } })).toBe('audio');
    // 普通文档即便带了这个键也不跟：只有音视频的正文才在转录稿上
    expect(contentSourceEntryId({ id: 'doc', contentType: 'text/markdown', metadata: { transcribe_entry_id: 'x' } })).toBe('doc');
    expect(contentSourceEntryId({ id: 'doc' })).toBe('doc');
  });
});
