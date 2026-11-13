import assert from 'node:assert/strict';

/** 同一不可变仓库内容跨 image store 恢复；本地 Id 仍由各自 daemon 独立绑定。 */
export function assertPortableArtifactContents(original: {
  RepoDigests: string[]; Config: Record<string, unknown>; RootFS: { Type: string; Layers: string[] }; Os: string; Architecture: string;
}, recovered: typeof original, repositoryDigest: string): void {
  assert.match(repositoryDigest, /@sha256:[a-f0-9]{64}$/);
  assert.ok(original.RepoDigests.includes(repositoryDigest)); assert.ok(recovered.RepoDigests.includes(repositoryDigest));
  assert.ok(original.RootFS.Layers.length > 0); assert.ok(original.Config);
  assert.deepEqual(recovered.RootFS, original.RootFS); assert.deepEqual(recovered.Config, original.Config);
  assert.equal(recovered.Os, original.Os); assert.equal(recovered.Architecture, original.Architecture);
}

export function fixtureContentReference(image: { sha: string; reference: string; repoDigests: string[] }): string {
  assert.match(image.sha, /^[a-f0-9]{40}$/); assert.ok(image.reference.endsWith(':sha-' + image.sha));
  const repository = image.reference.slice(0, -45);
  const digests = image.repoDigests.filter(reference => reference.startsWith(repository + '@sha256:'));
  assert.equal(digests.length, 1); assert.match(digests[0], /@sha256:[a-f0-9]{64}$/);
  return image.reference + '@' + digests[0].split('@')[1];
}

/** expectedImage 来自独立的原registry引用inspect，不从被测运行对象倒推期望。 */
export function assertPinnedArtifactRuntime(runtime: { Image: string; Config: { Image: string } },
  expectedImage: { Id: string; RepoDigests: string[]; Os: string; Architecture: string; Config: { Labels: Record<string, string> } },
  expected: { manifest: string; revision: string; platform: string; owner: string }): void {
  assert.match(expectedImage.Id, /^sha256:[a-f0-9]{64}$/);
  assert.ok(expectedImage.RepoDigests.includes(expected.manifest));
  assert.equal(expectedImage.Config.Labels['org.opencontainers.image.revision'], expected.revision);
  assert.equal(expectedImage.Config.Labels['cds.acceptance.owner'], expected.owner);
  assert.equal(expectedImage.Os + '/' + expectedImage.Architecture, expected.platform);
  assert.equal(runtime.Config.Image, expectedImage.Id); assert.equal(runtime.Image, expectedImage.Id);
}
