/** 分区读取失败保留未知，不把网络或权限错误变成空数据。 */
export async function partialRead<T>(source: string, read: Promise<T>, failures: Record<string, string>): Promise<T | null> {
  try { return await read; }
  catch (error) { failures[source] = error instanceof Error ? error.message : String(error); return null; }
}
