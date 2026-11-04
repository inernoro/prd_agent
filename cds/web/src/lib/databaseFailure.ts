export interface DatabaseFailure {
  summary: string;
  recovery: string;
  diagnostic?: { status?: number; requestId?: string };
}

/** Only classify known failures; never render raw SQL, request URLs or exception text. */
export function databaseFailure(error: unknown, engine: 'sql' | 'mongo'): DatabaseFailure {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const body = value.body && typeof value.body === 'object' ? value.body as Record<string, unknown> : {};
  const reason = String(body.error || body.message || value.message || '');
  const status = typeof value.status === 'number' ? value.status : undefined;
  const requestId = typeof value.requestId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value.requestId) ? value.requestId : undefined;
  const diagnostic = status || requestId ? { status, requestId } : undefined;
  const result = (summary: string, recovery: string): DatabaseFailure => ({ summary, recovery, diagnostic });
  if (status === 401) return result('登录已失效，无法执行操作。', '请重新登录后核对数据库状态，再决定是否重试。');
  if (status === 403) return result('当前账号无权执行此操作。', '请联系项目管理员确认资源权限，或通过技能提交具体操作审批。');
  if (/timeout|timed out|超时/i.test(reason)) return result('数据库操作等待超时，执行状态需要核对。', '请先查询核对数据或联系管理员，不要直接重复提交。');
  if (engine === 'mongo' && /deleteMany.*非空.*filter/i.test(reason)) return result('删除已阻止：请填写明确的筛选条件。', '请限定要删除的记录，再核对目标集合后重试。');
  if (engine === 'sql' && /doesn't exist|relation .+ does not exist/i.test(reason)) return result('找不到 SQL 中指定的表。', '请核对左侧库表列表、表名及所属数据库后重试。');
  if (engine === 'sql' && /syntax error|SQL syntax/i.test(reason)) return result('SQL 语句格式有误。', '请检查语法、引号及分号后重试。');
  if (/duplicate entry|duplicate key/i.test(reason)) return result('写入被拒绝：记录的唯一值重复。', '请检查主键或唯一字段，核对已有记录后再修改。');
  if (status === 400) return result('操作未执行，填写内容不符合要求。', '请检查命令、JSON 格式及资源确认名称后重试。');
  return result('数据库操作未完成。', requestId ? '请核对连接和输入内容；仍失败时将诊断编号提供给管理员。' : '请检查连接和输入内容；仍失败时请联系管理员核对服务状态。');
}
