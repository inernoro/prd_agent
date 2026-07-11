import { describe, expect, it } from 'vitest';
import { useDefectStore } from '../defectStore';

describe('defectStore pendingSharePayload（手机截图分享注入通道）', () => {
  it('set 后 consume 返回同一 payload 并清空；再次 consume 得 null', () => {
    const payload = { files: [] as File[], text: '分享文字' };
    useDefectStore.getState().setPendingSharePayload(payload);
    expect(useDefectStore.getState().pendingSharePayload).toBe(payload);

    expect(useDefectStore.getState().consumePendingSharePayload()).toBe(payload);
    expect(useDefectStore.getState().pendingSharePayload).toBeNull();
    expect(useDefectStore.getState().consumePendingSharePayload()).toBeNull();
  });

  it('面板打开期间再次分享：第二个 payload 覆盖并可再次领取', () => {
    const first = { files: [] as File[], text: 'first' };
    const second = { files: [] as File[], text: 'second' };
    useDefectStore.getState().setPendingSharePayload(first);
    expect(useDefectStore.getState().consumePendingSharePayload()).toBe(first);

    // 模拟面板仍开着时又一次 share_target 到达
    useDefectStore.getState().setPendingSharePayload(second);
    expect(useDefectStore.getState().consumePendingSharePayload()).toBe(second);
    expect(useDefectStore.getState().consumePendingSharePayload()).toBeNull();
  });
});
