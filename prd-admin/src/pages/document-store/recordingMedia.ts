/**
 * 现场录音优先选择 MP4/AAC：iOS 上 WebM/Opus 的 MediaRecorder 分片常缺少时长元数据，
 * 能被服务端 ffmpeg 转录，却可能无法被同一台手机稳定播放。桌面浏览器不支持 MP4 时
 * 再回退到 WebM/Opus；选择能力完全以 MediaRecorder.isTypeSupported 为准。
 */
export const RECORDING_MIME_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
] as const;

export function selectRecordingMimeType(
  isSupported: (mime: string) => boolean,
): string {
  return RECORDING_MIME_CANDIDATES.find(isSupported) ?? '';
}

export function recordingExtension(mime: string): string {
  if (mime.includes('mp4')) return '.m4a';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('ogg')) return '.ogg';
  return '.webm';
}
