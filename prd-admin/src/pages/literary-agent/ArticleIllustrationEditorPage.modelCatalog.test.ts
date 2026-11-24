import { describe, expect, it, vi } from 'vitest';
import { mutateReferenceImageScenario } from './referenceImageModelCatalog';

describe('文学配图场景模型目录刷新', () => {
  it('变更成功后等待配置目录和模型目录都完成', async () => {
    const mutate = vi.fn(async () => ({ success: true }));
    const loadReferenceImageConfigs = vi.fn(async () => undefined);
    const reloadImageGenPools = vi.fn(async () => undefined);

    const result = await mutateReferenceImageScenario(
      mutate,
      loadReferenceImageConfigs,
      reloadImageGenPools,
    );

    expect(result.success).toBe(true);
    expect(mutate).toHaveBeenCalledOnce();
    expect(loadReferenceImageConfigs).toHaveBeenCalledOnce();
    expect(reloadImageGenPools).toHaveBeenCalledOnce();
    expect(mutate.mock.invocationCallOrder[0]).toBeLessThan(loadReferenceImageConfigs.mock.invocationCallOrder[0]!);
    expect(mutate.mock.invocationCallOrder[0]).toBeLessThan(reloadImageGenPools.mock.invocationCallOrder[0]!);
  });

  it('变更失败时不刷新任何目录', async () => {
    const mutate = vi.fn(async () => ({ success: false }));
    const loadReferenceImageConfigs = vi.fn(async () => undefined);
    const reloadImageGenPools = vi.fn(async () => undefined);

    const result = await mutateReferenceImageScenario(
      mutate,
      loadReferenceImageConfigs,
      reloadImageGenPools,
    );

    expect(result.success).toBe(false);
    expect(loadReferenceImageConfigs).not.toHaveBeenCalled();
    expect(reloadImageGenPools).not.toHaveBeenCalled();
  });
});
