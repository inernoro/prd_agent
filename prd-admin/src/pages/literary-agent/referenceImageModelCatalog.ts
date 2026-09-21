export async function reloadReferenceImageScenario(
  loadReferenceImageConfigs: () => Promise<void>,
  reloadImageGenPools: () => Promise<void>,
) {
  await Promise.all([
    loadReferenceImageConfigs(),
    reloadImageGenPools(),
  ]);
}
