import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const threadSource = readFileSync(new URL('./AskThread.tsx', import.meta.url), 'utf8');
const hookSource = readFileSync(new URL('./useAskStream.ts', import.meta.url), 'utf8');

describe('网页提问等待交互', () => {
  it('等待首字期间持续显示耗时并允许用户停止', () => {
    expect(threadSource).toContain('已等待 ${elapsedSeconds} 秒');
    expect(threadSource).toContain('aria-label="停止回答"');
    expect(threadSource).toContain('onClick={onCancel}');
  });

  it('停止后终止请求并把流式消息收口为可恢复状态', () => {
    expect(hookSource).toContain("error: '已停止回答，可修改问题后再次发送。'");
    expect(hookSource).toContain("setStatus('idle')");
    expect(hookSource).toContain('abortRef.current?.abort()');
  });
});
