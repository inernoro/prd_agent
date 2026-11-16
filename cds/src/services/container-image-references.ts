/** Resolve every running/stopped container's native image ID to all aliases.
 * Query failure or a changing inventory is unknown, never an empty reference set.
 */
export async function containerImageReferences(read: (args: string[]) => Promise<string>): Promise<string[]> {
  const deadline = Date.now() + 30000;
  const query = async (args: string[]) => {
    if (Date.now() >= deadline) throw new Error('容器引用盘点超过时限');
    const value = await read(args);
    if (Date.now() >= deadline) throw new Error('容器引用盘点超过时限');
    return value;
  };
  const parse = (value: string) => value.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const inventory = async () => [...new Set((await query(['ps', '-aq', '--no-trunc'])).trim().split(/\s+/).filter(Boolean))].sort();
  const ids = await inventory();
  if (ids.length > 5000) throw new Error('容器引用盘点超过预算，保留镜像');
  const references = new Set<string>();
  const imageIds = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    // Project only identity fields: container Env/command credentials never cross this boundary.
    const rows = parse(await query(['container', 'inspect', '--format', '{"Id":{{json .Id}},"Image":{{json .Image}}}', ...batch]));
    if (!Array.isArray(rows) || rows.length !== batch.length
      || rows.map(row => row.Id).sort().join('\n') !== batch.join('\n')) throw new Error('容器引用盘点不完整');
    for (const row of rows) {
      if (typeof row.Image !== 'string' || !row.Image) throw new Error('容器镜像身份未知');
      imageIds.add(row.Image); references.add(row.Image);
    }
  }
  const nativeIds = [...imageIds];
  for (let offset = 0; offset < nativeIds.length; offset += 100) {
    const batch = nativeIds.slice(offset, offset + 100).sort();
    const rows = parse(await query(['image', 'inspect', '--format', '{"Id":{{json .Id}},"RepoTags":{{json .RepoTags}}}', ...batch]));
    if (!Array.isArray(rows) || rows.length !== batch.length
      || rows.map(row => row.Id).sort().join('\n') !== batch.join('\n')) throw new Error('镜像别名盘点不完整');
    // Aliases are resolved from the native ID. A digest-only Config.Image must not
    // unnecessarily protect every other version in the repository.
    for (const row of rows) for (const ref of row.RepoTags || []) references.add(ref);
  }
  if ((await inventory()).join('\n') !== ids.join('\n')) throw new Error('容器清单发生变化，保留本轮镜像');
  return [...references];
}
