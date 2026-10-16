function requireCondition(value, message) {
  if (!value) throw new Error(`LIT-009/${message}`);
}

export function assertRealLiteraryMarkerStream(stream, article) {
  const events = [];
  for (const line of String(stream).replaceAll('\r\n', '\n').split('\n')) {
    if (!line.startsWith('data:')) continue;
    let event;
    try { event = JSON.parse(line.slice(5).trim()); }
    catch { throw new Error('LIT-009/真实标记流包含无法解析的数据'); }
    requireCondition(event && typeof event.type === 'string', '真实标记流缺少事件类型');
    requireCondition(event.type !== 'error', '真实标记生成返回错误，不得作为成功');
    events.push(event);
  }
  const done = events.filter(event => event.type === 'done');
  requireCondition(done.length === 1, '真实标记流必须有且只有一个完成事件');
  requireCondition(events.some(event => event.type === 'progress' && event.message), '真实标记流缺少阶段反馈');
  const completedAt = events.indexOf(done[0]);
  requireCondition(events.slice(0, completedAt).some(event => ['thinking', 'delta', 'chunk', 'marker'].includes(event.type) && event.text), '真实标记流缺少完成前的增量内容');
  requireCondition(completedAt === events.length - 1, '完成后仍有标记流事件');
  const fullText = done[0].fullText;
  requireCondition(typeof fullText === 'string' && fullText.includes('[插图]'), '完成事件缺少真实配图标记');
  requireCondition(Number.isInteger(done[0].markerCount) && done[0].markerCount > 0, '完成事件没有确认实际解析出的配图标记');
  for (const line of article.split('\n').map(value => value.trim()).filter(Boolean)) {
    requireCondition(fullText.includes(line), '完成正文缺失自有输入内容');
  }
  return { fullText, eventTypes: events.map(event => event.type), markerCount: done[0].markerCount };
}

export function assertLiteraryWorkspacePersisted(detail, { workspaceId, title, article, fullText }) {
  const workspace = detail?.workspace;
  requireCondition(workspace?.id === workspaceId, '持久化详情不是本轮同一工作区');
  requireCondition(workspace.title === title, '持久化标题不等于本轮输入');
  requireCondition(workspace.articleContent === article, '持久化原文不完整或不一致');
  requireCondition(workspace.articleContentWithMarkers === fullText, '持久化配图标记正文不完整或不一致');
  return workspace;
}

export async function deleteAndVerifyLiteraryWorkspace(request, { workspaceId, headers, timeout }) {
  requireCondition(/^[a-f0-9]{32}$/i.test(workspaceId), '清理工作区标识无效');
  const path = `/api/literary-agent/workspaces/${workspaceId}`;
  const deleted = await request.delete(path, { headers, timeout });
  requireCondition(deleted.ok(), '删除本轮工作区失败');
  const body = await deleted.json();
  requireCondition(body?.success === true && body?.data?.deleted === true, '删除回执没有确认本轮工作区已删除');
  const readback = await request.get(`${path}/detail`, { headers, timeout });
  requireCondition(readback.status() === 404, '删除后详情仍非404，清理未完成');
  return { workspaceId, deleted: true, detailStatus: 404 };
}
