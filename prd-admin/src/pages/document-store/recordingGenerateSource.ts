import type { GenerateContentSource } from '@/components/design-launch/designLaunchAgents';
import type { TranscriptEditActivity } from '@/components/doc-browser/transcriptEditActivity';

/**
 * 录音结果页「用这份转录生成网页」能不能点、点了交出去的是哪一条。
 *
 * 来源必须是**转录笔记条目**（`noteId`），不是路由上的音频条目：
 * 新数据里两者是同一条（转录稿写回音频条目自身），旧数据里是另一条独立笔记。
 * 服务端按条目读正文，交错了条目，生成用的就不是用户眼前这份转录。
 *
 * 挡住时给一句人话原因，按钮照样摆出来——看得见但点不了、且说得清为什么，
 * 比按钮凭空不出现更能让人知道「等一下就能用」。
 */
export type RecordingGenerateSource =
  | { kind: 'ready'; source: GenerateContentSource }
  | { kind: 'blocked'; reason: string };

export function resolveRecordingGenerateSource(input: {
  storeId: string;
  storeName: string;
  title: string;
  noteId: string;
  noteMd: string;
  offline: boolean;
  /** 本机排队、还没传上去的校对处数 */
  pendingEditCount: number;
  /** 页内校对：编辑框开着或保存在飞时，服务端那份还不是屏幕上这份 */
  editActivity?: TranscriptEditActivity;
}): RecordingGenerateSource {
  if (!input.noteId || !input.noteMd.trim()) return { kind: 'blocked', reason: '转录完成后可用' };
  if (input.offline) return { kind: 'blocked', reason: '联网后可用' };
  // 生成读的是服务端那份正文；本机还有没传上去的校对，照读会丢掉这些改动
  if (input.pendingEditCount > 0) return { kind: 'blocked', reason: `${input.pendingEditCount} 处校对同步后可用` };
  if (input.editActivity === 'saving') return { kind: 'blocked', reason: '转写修改还在保存' };
  if (input.editActivity === 'editing') return { kind: 'blocked', reason: '转写修改还没保存' };
  return {
    kind: 'ready',
    source: {
      storeId: input.storeId,
      entryId: input.noteId,
      title: input.title.trim() || '录音转录',
      storeName: input.storeName || undefined,
    },
  };
}
