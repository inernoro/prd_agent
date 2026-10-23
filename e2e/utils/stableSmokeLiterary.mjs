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

function requireIllustration(value, message) {
  if (!value) throw new Error(`LIT-006/${message}`);
}

export function readLiterarySingleImagePrompt(detail, expected) {
  const workspace = assertLiteraryWorkspacePersisted(detail, expected);
  const workflow = workspace.articleWorkflow;
  requireIllustration(workflow?.phase === 2 && Array.isArray(workflow.markers), '本轮持久化详情尚未完成标记生成');
  requireIllustration(Number.isInteger(expected.markerIndex) && expected.markerIndex >= 0, '已解析卡索引无效');
  const matches = workflow.markers.filter(item => item.index === expected.markerIndex);
  requireIllustration(matches.length === 1, '本轮持久化详情缺少唯一对应标记');
  const marker = matches[0];
  // f711 GenerateArticleMarkers 的新 workflow 只保证 index/text；planItem 可空。
  // 对齐页面 extractMarkers 及 runSingleMarker 的已有缓存优先级，不读 DOM 自由文本或补造 plan。
  const finalMarkers = [...expected.fullText.matchAll(/\[插图\]\s*:\s*(.+?)(?=\n|$)/gm)]
    .map(match => match[1].trim()).filter(Boolean);
  const generatedText = finalMarkers[expected.markerIndex];
  requireIllustration(generatedText && typeof marker.text === 'string' && marker.text.trim() === generatedText, '持久化标记与本轮真实完成正文不一致');
  requireIllustration(marker.planItem == null || (typeof marker.planItem === 'object' && !Array.isArray(marker.planItem)), '实际planItem不是已公布的对象字段');
  const planPrompt = typeof marker.planItem?.prompt === 'string' ? marker.planItem.prompt.trim() : '';
  const draftPrompt = typeof marker.draftText === 'string' ? marker.draftText.trim() : '';
  const source = planPrompt ? 'planItem.prompt' : draftPrompt ? 'draftText' : 'text';
  const prompt = planPrompt || draftPrompt || marker.text.trim();
  requireIllustration(prompt === generatedText, '缓存提示词与本轮真实完成标记不一致');
  return { markerIndex: expected.markerIndex, prompt, source };
}

// 前置拦截只阻止越界请求，不伪造任何成功响应或故障。
export function createLiterarySingleImagePolicy(inspectionRunId) {
  requireIllustration(/^stsmk-[A-Za-z0-9-]+$/.test(inspectionRunId), '本轮标识无效');
  let context = {};
  let markerRequests = 0;
  let imageRequests = 0;
  const violations = [];
  return {
    configure(value) { context = { ...context, ...value }; },
    inspect(method, path, body) {
      if (method !== 'POST') return true;
      try {
        requireIllustration(!/^\/api\/submissions(?:\/|$)/.test(path), '禁止投稿');
        requireIllustration(!/\/image-gen\/plan$/.test(path), '禁止额外意图模型调用');
        if (path.endsWith('/article/generate-markers')) {
          markerRequests++;
          requireIllustration(markerRequests === 1, '最多一次真实标记生成');
          requireIllustration(path === `/api/visual-agent/image-master/workspaces/${context.workspaceId}/article/generate-markers`, '标记不属于本轮作品');
          requireIllustration(body?.articleContent === context.article && body?.modelId === context.chatModelId, '标记原文或默认模型不符');
        }
        if (/\/image-gen\/runs$/.test(path)) {
          imageRequests++;
          requireIllustration(markerRequests === 1, '图片必须基于本轮真实标记流');
          requireIllustration(imageRequests === 1, '最多一次真实单图生成');
          requireIllustration(path === '/api/literary-agent/image-gen/runs', '必须使用文学专属图片入口');
          requireIllustration(context.publicationDisabled === true, '须先在页面关闭自动投稿');
          requireIllustration(body?.workspaceId === context.workspaceId && body?.appKey === 'literary-agent', '图片作品或应用身份不符');
          requireIllustration(body?.modelId === context.imageModelId && body?.platformId === context.platformId, '不能更换默认图片模型');
          requireIllustration(Number.isInteger(context.markerIndex) && body?.articleMarkerIndex === context.markerIndex, '图片标记位置不符');
          requireIllustration(body?.maxConcurrency === 1 && body?.items?.length === 1 && body.items[0].count === 1, '只能生成单卡一张');
          requireIllustration(body.items[0].prompt === context.prompt, '图片提示词必须来自已解析卡');
          requireIllustration(context.minimumSizes?.includes(body.size) && body.items[0].size === body.size, '尺寸必须来自当前模型最小公开档');
        }
        return true;
      } catch (error) {
        violations.push(String(error.message));
        return false;
      }
    },
    snapshot() { return { markerRequests, imageRequests, violations: [...violations] }; },
    assertNoViolations() { requireIllustration(violations.length === 0, `检测到越界请求：${violations.join('；')}`); },
  };
}

export function assertLiteraryImageInsertion(detail, expected, placement) {
  const { workspaceId, title, article, fullText, markerIndex, runId } = expected;
  const workspace = detail?.workspace;
  requireIllustration(workspace?.id === workspaceId && workspace.title === title, '图片不是同一作品');
  requireIllustration(workspace.articleContent === article && workspace.articleContentWithMarkers === fullText, '原文或配图标记正文丢失');
  const workflow = workspace.articleWorkflow;
  const marker = workflow?.markers?.find(item => item.index === markerIndex);
  const assetId = workflow?.assetIdByMarkerIndex?.[String(markerIndex)];
  const asset = detail?.assets?.find(item => item.id === assetId);
  requireIllustration(marker?.status === 'done' && marker.runId === runId, '单卡未由本轮真实任务完成');
  requireIllustration(workflow.doneImageCount === 1 && detail.assets.length === 1, '不能把多个图片任务算一张');
  requireIllustration(asset?.workspaceId === workspaceId && asset.articleInsertionIndex === markerIndex && asset.url, '图片资产未绑定正确正文位置');
  requireIllustration(placement?.count === 1 && placement.src === asset.url && placement.width > 0 && placement.height > 0, '正文对应图片没有真实解码');
  const position = fullText.indexOf(marker.text);
  requireIllustration(position >= 0 && fullText.lastIndexOf(marker.text) === position, '标记位置不唯一');
  const paragraphs = article.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  for (const paragraph of paragraphs) {
    requireIllustration(placement.allText.includes(paragraph), '正文图片插入后原段落丢失');
    const side = fullText.indexOf(paragraph) < position ? placement.beforeText : placement.afterText;
    requireIllustration(side.includes(paragraph), '图片插入到错误段落位置');
  }
  return { assetId, url: asset.url, markerIndex, runId };
}

export async function readLiteraryImagePlacement(content, markerIndex) {
  const image = content.locator(`img[data-marker-idx="${markerIndex}"]`);
  requireIllustration(await image.count() === 1, '正文必须只有对应位置的一张图片');
  return image.evaluate(async element => {
    await element.decode();
    const root = element.closest('[data-tour-id="literary-editor-content"]');
    if (!root) throw new Error('LIT-006/正文容器不存在');
    const before = document.createRange(); before.selectNodeContents(root); before.setEndBefore(element);
    const after = document.createRange(); after.selectNodeContents(root); after.setStartAfter(element);
    return { count: 1, src: element.src, width: element.naturalWidth, height: element.naturalHeight,
      allText: root.textContent || '', beforeText: before.toString(), afterText: after.toString() };
  });
}
