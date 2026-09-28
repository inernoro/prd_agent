/**
 * 转录校对此刻在干什么：宿主据此判断「现在能不能拿服务端那份正文去做别的事」。
 *
 * - editing：有一句原文或一个说话人名的编辑框开着——里面的字还没交给保存；
 * - saving：保存请求已发出、还没落地（包括在写队列里排着的那一发）；
 * - idle：屏幕上看到的就是已经交出去的全部内容。
 *
 * 只从 TranscriptKaraoke 已有的三个状态推出来，不另建一套。
 */
export type TranscriptEditActivity = 'idle' | 'editing' | 'saving';

export function deriveTranscriptEditActivity(input: {
  editingIndex: number | null;
  renamingSpeaker: string | null;
  savingEdit: boolean;
}): TranscriptEditActivity {
  if (input.savingEdit) return 'saving';
  if (input.editingIndex !== null || input.renamingSpeaker !== null) return 'editing';
  return 'idle';
}
