/**
 * 分支名转换为 docker/metadata-action 使用的镜像 tag 片段。
 *
 * metadata-action 的 sanitizeTag 会把不属于 `[A-Za-z0-9._-]` 的连续字符替换为
 * `-`，保留大小写、下划线和点，并移除开头的 `.` / `-`。CDS 的镜像模板解析
 * 与容器运行时元数据必须共用这一实现，避免同一分支产生两个不同标识。
 */
export function slugifyBranchForImage(branch: string): string {
  return branch
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 128);
}
