/**
 * 录音转录全链路的阶段清单推导（纯函数，供 TranscribeFlowDrawer 渲染与单测共用）。
 * 后端 phase 序列：排队中 → 准备中 → 下载素材 → (提取音轨) → 解析音频 → 识别中 → 生成摘要 → 写入中 → 完成
 */

export type TranscribeStepState = 'pending' | 'active' | 'done' | 'failed';

export type TranscribeFlowStatus = 'uploading' | 'running' | 'done' | 'failed';

export type TranscribeStep = {
  key: 'upload' | 'transcribe' | 'summary' | 'save';
  label: string;
  sub?: string;
  state: TranscribeStepState;
};

/** 转录中细分阶段（后端 phase → 第二步的副标题） */
export const TRANSCRIBE_PHASES = new Set(['排队中', '准备中', '下载素材', '提取音轨', '解析音频', '识别中']);

export function deriveTranscribeSteps(input: {
  status: TranscribeFlowStatus;
  phase: string;
  /** 是否为「新上传录音」场景（否则为已有条目场景） */
  hasFile: boolean;
  /** 源 entry 是否已就绪（上传完成 / 已有条目） */
  hasEntry: boolean;
  summaryFailed: boolean;
}): TranscribeStep[] {
  const { status, phase, hasFile, hasEntry, summaryFailed } = input;

  const uploadState: TranscribeStepState =
    status === 'uploading' ? 'active'
      : (status === 'failed' && !hasEntry && hasFile) ? 'failed'
        : 'done';

  const inTranscribe = status === 'running' && TRANSCRIBE_PHASES.has(phase);
  const pastTranscribe = status === 'done' || phase === '生成摘要' || phase === '写入中' || phase === '完成';
  const transcribeState: TranscribeStepState =
    status === 'failed' && hasEntry ? (pastTranscribe ? 'done' : 'failed')
      : pastTranscribe ? 'done'
        : inTranscribe ? 'active'
          : 'pending';

  const summaryState: TranscribeStepState =
    summaryFailed ? 'failed'
      : status === 'done' || phase === '写入中' || phase === '完成' ? 'done'
        : phase === '生成摘要' ? 'active'
          : 'pending';

  const saveState: TranscribeStepState =
    status === 'done' ? 'done'
      : phase === '写入中' ? 'active'
        : 'pending';

  return [
    { key: 'upload', label: hasFile ? '上传音频' : '音频已就绪', state: uploadState },
    {
      key: 'transcribe',
      label: '转录',
      sub: TRANSCRIBE_PHASES.has(phase) && phase !== '排队中' ? phase : undefined,
      state: transcribeState,
    },
    {
      key: 'summary',
      label: 'AI 摘要',
      sub: summaryFailed ? '摘要生成失败，保留转录全文' : undefined,
      state: summaryState,
    },
    { key: 'save', label: '保存为转录笔记', state: saveState },
  ];
}
