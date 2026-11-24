type MutationResult = { success: boolean };

export async function mutateReferenceImageScenario<T extends MutationResult>(
  mutate: () => Promise<T>,
  loadReferenceImageConfigs: () => Promise<void>,
  reloadImageGenPools: () => Promise<void>,
) {
  const result = await mutate();
  if (!result.success) return result;

  await Promise.all([
    loadReferenceImageConfigs(),
    reloadImageGenPools(),
  ]);
  return result;
}
