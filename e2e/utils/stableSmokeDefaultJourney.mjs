export function assertDefaultPeachRequest({ pool, selectedLabel, request }) {
  if (!pool?.isDefault || !pool.code || !pool.name || /默认池|default\s*pool|图片生成默认池/i.test(pool.name)) throw Error('后端未明确配置具体默认型号');
  if (!selectedLabel?.includes(pool.name) || /默认池|图片生成默认池/i.test(selectedLabel)) throw Error('界面默认型号与后端配置不一致');
  const prompts = ['白桃', 'Generate an image based on the following description:\n白桃'];
  if (!prompts.includes(request?.prompt) || request?.size !== '1024x1024') throw Error('真人默认主例必须为白桃1024方图');
  if (request.modelId !== pool.code || request.platformId !== 'logical-model') throw Error('界面选择与真实发送模型不一致');
  if (!request.targetKey) throw Error('真实请求缺少画布任务身份');
  if (request.expectedImageRefCount !== 0 || (request.imageRefs?.length || 0) !== 0) {
    const error = Error('无参考主例不得静默带入引用');
    error.code = 'IMAGE_REFERENCE_DECLARATION';
    throw error;
  }
}

export async function readMultiImageResultLayoutThroughUi(page, { targetKey }) {
  if (!/^[a-z0-9_.-]+$/i.test(targetKey || '')) throw Error('[multi/layout] 本轮结果身份无效');
  const root = page.locator('[data-tour-id="visual-editor-root"]');
  const frame = root.locator('[data-canvas-key="' + targetKey + '"]');
  if (await frame.count() !== 1) throw Error('[multi/layout] 本轮结果画框不唯一');
  await frame.waitFor({ state: 'visible', timeout: 15_000 }); // 仅等待挂载，不以visible充当完整布局通过。
  return frame.evaluate(async (element, key) => {
    const doc = element.ownerDocument, win = doc.defaultView;
    await new Promise(done => win.requestAnimationFrame(() => win.requestAnimationFrame(done)));
    const rect = node => {
      const r = node.getBoundingClientRect();
      return { x:r.x, y:r.y, width:r.width, height:r.height };
    };
    const editor = element.closest('[data-tour-id="visual-editor-root"]');
    const canvas = editor?.querySelector('[data-tour-id="visual-editor-canvas"]');
    const images = element.querySelectorAll('[data-testid="canvas-image"]');
    const inputs = [...(editor?.querySelectorAll('[contenteditable="true"],textarea') || [])].filter(node => {
      const r = rect(node); return r.width > 0 && r.height > 0;
    });
    // f711右侧聊天浮层由该真实输入区的外层absolute/z-30容器承载；不猜420px宽度。
    const panel = inputs[0]?.closest('.absolute.z-30.flex.flex-col');
    if (!canvas || images.length !== 1 || inputs.length !== 1 || !panel) throw Error('[multi/layout] 结果、输入或浮动面板锚点不可核验');
    const viewport = { x:0, y:0, width:Math.min(win.innerWidth, doc.documentElement.clientWidth), height:Math.min(win.innerHeight, doc.documentElement.clientHeight) };
    const panelBounds = rect(panel), canvasBounds = rect(canvas);
    const inside = (a,b) => a.width > 0 && a.height > 0 && a.x >= b.x - .5 && a.y >= b.y - .5
      && a.x + a.width <= b.x + b.width + .5 && a.y + a.height <= b.y + b.height + .5;
    const overlap = (a,b) => Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x) > .5
      && Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y) > .5;
    const targets = [element, images[0], inputs[0]], bounds = targets.map(rect);
    for (const [index, target] of targets.entries()) {
      const current = bounds[index];
      if (!inside(current, viewport) || (index < 2 && !inside(current, canvasBounds))) throw Error('[multi/layout] 画框、图片或输入超出可视边界');
      for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = win.getComputedStyle(ancestor), clip = rect(ancestor);
        if ((/^(hidden|clip|auto|scroll)$/.test(style.overflowX) && (current.x < clip.x-.5 || current.x+current.width > clip.x+clip.width+.5))
          || (/^(hidden|clip|auto|scroll)$/.test(style.overflowY) && (current.y < clip.y-.5 || current.y+current.height > clip.y+clip.height+.5))) throw Error('[multi/layout] 所需目标被祖先滚动或裁切容器截断');
      }
      if (index < 2 && overlap(current, panelBounds)) throw Error('[multi/layout] 结果被真实右侧聊天浮层覆盖');
    }
    let sampledPoints = 0;
    for (const [index, target] of targets.entries()) {
      const current = bounds[index];
      for (const x of [.02,.5,.98]) for (const y of [.02,.5,.98]) {
        const hit = doc.elementFromPoint(current.x+current.width*x, current.y+current.height*y);
        if (!hit || (hit !== target && !target.contains(hit))) throw Error('[multi/layout] 结果命中点被其它层遮挡');
        sampledPoints += 1;
      }
    }
    return { targetKey:key, viewport, canvas:canvasBounds, frame:bounds[0], image:bounds[1], input:bounds[2], chatPanel:panelBounds, sampledPoints };
  }, targetKey);
}

export async function fitMultiImageResultThroughUi(page, { targetKey }) {
  const root = page.locator('[data-tour-id="visual-editor-root"]');
  // 本旅程已真实reload，选中态不持久化。防止按钮只适配旧参考图而漏掉新结果。
  if (await root.locator('.image-chip-node').count()) throw Error('[multi/layout] 刷新后仍有旧选择，不能把适配选中冒充适配全部');
  const fit = root.getByRole('button', { name:'适配', exact:true });
  if (await fit.count() !== 1) throw Error('[multi/layout] 原生适配入口不唯一');
  await fit.waitFor({ state:'visible', timeout:15_000 });
  await fit.click(); // 只走真实UI；不改DOM/CSS、不伪造视口、不创建或重新生成任务。
  return { ...await readMultiImageResultLayoutThroughUi(page, { targetKey }), action:'native-fit-button' };
}

function multiImageCanvasError(message, pending = false) {
  const error = Error(message);
  error.code = pending ? 'MULTI_CANVAS_PENDING' : 'MULTI_CANVAS_IDENTITY';
  return error;
}

export function readPersistedMultiImageReferences(detail, references) {
  if (!Array.isArray(detail?.assets)) throw multiImageCanvasError('[multi/canvas] 资产回读格式无效');
  if (!detail.canvas?.payloadJson) throw multiImageCanvasError('[multi/canvas] 画布尚未持久化', true);
  const canvas = JSON.parse(detail.canvas.payloadJson);
  if (canvas.schemaVersion !== 1 || !Array.isArray(canvas.elements)) throw multiImageCanvasError('[multi/canvas] 持久化画布格式无效');
  const resolved = references.map(reference => {
    const assets = detail.assets.filter(asset => asset.id === reference.assetId);
    if (!assets.length) throw multiImageCanvasError('[multi/canvas] 本轮上传资产尚未回读', true);
    if (assets.length !== 1 || assets[0].sha256 !== reference.sha256 || !assets[0].url) throw multiImageCanvasError('[multi/canvas] 上传资产身份不一致');
    // 生产恢复合同按assetId关联资产；sha256和name均可选，文件名不是画布身份。
    const elements = canvas.elements.filter(element => element.kind === 'image' && element.assetId === reference.assetId);
    if (!elements.length) throw multiImageCanvasError('[multi/canvas] 本轮图像元素尚未持久化', true);
    if (elements.length !== 1 || typeof elements[0].id !== 'string' || !elements[0].id.trim() || (elements[0].sha256 && elements[0].sha256 !== reference.sha256)) throw multiImageCanvasError('[multi/canvas] 持久化图像身份不一致');
    const element = elements[0];
    if (!Number.isSafeInteger(element.refId) || element.refId <= 0) throw multiImageCanvasError('[multi/canvas] 本轮稳定refId尚未持久化', true);
    return { ...reference, url: assets[0].url, canvasKey: element.id, refId: element.refId };
  });
  if (new Set(resolved.map(reference => reference.refId)).size !== references.length
    || new Set(resolved.map(reference => reference.canvasKey)).size !== references.length) throw multiImageCanvasError('[multi/canvas] 多图持久化身份不唯一');
  return resolved;
}

export async function waitForPersistedMultiImageReferences({ readDetail, references, timeoutMs = 30_000, intervalMs = 500 }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000 || !Number.isFinite(intervalMs) || intervalMs < 0) throw Error('[multi/canvas] 只读等待必须有界');
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const detail = await readDetail(); // 实际读取异常不被轮询吞掉；不创建或修改任何资源。
    try {
      return readPersistedMultiImageReferences(detail, references);
    } catch (error) {
      if (error.code !== 'MULTI_CANVAS_PENDING' || Date.now() >= deadline) throw error;
    }
    await new Promise(done => setTimeout(done, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
}

export function assertDefaultMultiImageRequest({ pool, selectedLabel, request, references, prompt, size }) {
  if (!pool?.isDefault || !pool.code || !pool.name || /默认池|default\s*pool/i.test(pool.name)
    || !selectedLabel?.includes(pool.name)) throw Error('[multi/default] 页面与后端必须保持当前唯一具体默认，不另选型号');
  if (![2,3].includes(references?.length) || new Set(references.map(r => r.sha256)).size !== references.length) throw Error('[multi/fixture] 两图、三图必须独立且逐张身份不同');
  if (request?.modelId !== pool.code || request.platformId !== 'logical-model' || request.size !== size || !request.targetKey
    || !request.prompt?.includes(prompt)) throw Error('[multi/request] 页面实际请求的型号、描述、尺寸选择或画框身份不一致');
  if (request.imageRefs?.length !== references.length) throw Error('[multi/reference] 真实结构化引用数量不符');
  for (const [index, reference] of references.entries()) {
    const actual = request.imageRefs[index];
    if (actual.assetSha256 !== reference.sha256 || actual.url !== reference.url || actual.refId !== reference.refId
      || actual.label !== `第${index+1}张图`) throw Error('[multi/reference] 实际引用身份、顺序或标签与真实UI重排不一致');
  }
  if (request.expectedImageRefCount !== references.length) {
    const error = Error('[multi/reference] 页面必须显式声明本次参考图数量');
    error.code = 'IMAGE_REFERENCE_DECLARATION';
    throw error;
  }
}

export function assertMultiImageWireReferences({ log, requestId, modelId, references }) {
  if (log?.requestId !== requestId || log.logicalModelPublicId !== modelId
    || log.appCallerCode !== 'visual-agent.image.vision::generation'
    || !['openrouter-image','openai','openai-compatible'].includes(log.protocol)) throw Error('[multi/wire] 本轮精确调用没有保持默认逻辑型号和参考图协议');
  const wire = JSON.parse(log.requestBodyRedacted || '{}');
  if (log.protocol === 'openrouter-image') {
    if (wire.input_references?.length !== references.length || references.some((reference,index) => {
      const actual = wire.input_references[index];
      return actual.type !== 'image_url' || actual.image_url?.url !== `[BASE64_IMAGE:${reference.sha256}:${reference.mime}]`;
    })) throw Error('[multi/wire] OpenRouter实际请求缺图、错哈希或顺序漂移');
  } else if (wire.content_type !== 'multipart/form-data' || !/\/images\/edits$/.test(wire.endpoint_path || '')
    || wire.file_count !== references.length || wire.files?.length !== references.length || references.some((reference,index) => {
      const actual = wire.files[index];
      return actual.field !== 'image[]' || actual.sha256 !== reference.sha256 || actual.mime_type !== reference.mime || actual.size_bytes !== reference.bytes;
    })) throw Error('[multi/wire] OpenAI实际image[]文件数量、顺序、原始字节或MIME不符');
  if (!(log.imageSuccessCount > 0) || !/"data"\s*:\s*\[/.test(log.answerText || '')
    || /input must have at least|chat\/completions|modalities/i.test(log.answerText || '')) throw Error('[multi/wire] 不能用200或空响应替代真实图片响应');
  return { requestId, modelId, protocol: log.protocol, referenceCount: references.length };
}

export async function submitDefaultMultiImageThroughUi(page, { workspaceId, pool, references, prompt, size, onCreated, beforeSubmit, onSubmitted, onMissingReferenceDeclaration }) {
  if (!pool?.isDefault || !pool.code || !pool.name || /默认池|default\s*pool/i.test(pool.name)
    || new URL(page.url()).pathname !== `/visual-agent/${workspaceId}`) throw Error('[multi/default] 必须在首页真人新建的工作区保持当前具体默认');
  const model = page.getByRole('button', { name: '模型偏好', exact: true });
  await model.filter({ hasText: pool.name }).waitFor({ state: 'visible', timeout: 30_000 });
  const selectedLabel = (await model.innerText()).trim();
  if (!selectedLabel.includes(pool.name) || /默认池|default\s*pool/i.test(selectedLabel)) throw Error('[multi/default] 页面默认与配置不符，不付费试探');
  const publication = page.getByRole('button', { name: '投稿已开启（点击关闭）', exact: true });
  if (await publication.count()) await publication.click();
  if (!/1K[\s\S]*1:1/.test(await page.getByRole('button', { name: '尺寸比例', exact: true }).innerText())) throw Error('[multi/size] 当前默认不是最低1K方图，不猜尺寸或换型号');
  for (const [index, reference] of references.entries()) {
    const persistedFrame = reference.canvasKey ? `[data-canvas-key="${reference.canvasKey}"] ` : '';
    await page.locator(`${persistedFrame}[data-testid="canvas-image"][alt="${reference.name}"]`).click(index ? { modifiers: ['Shift'] } : {});
  }
  const chips = page.locator('.image-chip-node');
  if (await chips.count() !== references.length) throw Error('[multi/chips] 页面未保留全部选择');
  const chipLabels = await chips.allTextContents();
  if (references.some((reference,index) => chipLabels[index]?.trim() !== reference.name)) throw Error('[multi/chips] 页面引用顺序与真实选择不同');
  const input = page.locator('[contenteditable="true"]:visible,textarea:visible');
  if (await input.count() !== 1) throw Error('[multi/input] 描述锚点不唯一');
  await input.pressSequentially(prompt); // fill会删除Lexical chips，必须保留真人参考图。
  if (beforeSubmit) await beforeSubmit();
  const pending = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/visual-agent/image-master/workspaces/${workspaceId}/image-gen/runs`, { timeout: 60_000 });
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const response = await pending, body = await response.json();
  if (!response.ok() || !body.success || !body.data?.runId) throw Error(`[multi/request] 真人多图提交失败：${body.error?.code || response.status()}`);
  onCreated(body.data.runId);
  const request = response.request().postDataJSON();
  const proof = { runId: body.data.runId, targetKey: request.targetKey, selectedLabel, chipLabels, request };
  if (onSubmitted) await onSubmitted(proof);
  try {
    assertDefaultMultiImageRequest({ pool, selectedLabel, request, references, prompt, size });
  } catch (error) {
    if (error.code !== 'IMAGE_REFERENCE_DECLARATION' || request.expectedImageRefCount !== undefined
      || typeof onMissingReferenceDeclaration !== 'function') throw error;
    await onMissingReferenceDeclaration(proof); // 缺声明仍由原case记红；不修改页面实际POST。
  }
  return proof;
}

export async function createDefaultWorkspaceThroughUi(page, { runId, onCreated }) {
  // 工作区标题后端最多40字符；本轮完整身份必须保留，不能等创建后才发现截断。
  if (typeof runId !== 'string' || !runId.startsWith('stsmk-') || runId.length > 40) throw Error('runId必须为40字符以内的stsmk-巡检身份，创建前停止');
  if (new URL(page.url()).pathname !== '/visual-agent') throw Error('必须先从首页真实进入视觉创作');
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  const dialog=page.getByRole('dialog');
  const title=runId;
  await dialog.getByRole('textbox').fill(title);
  const responsePromise=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/visual-agent/image-master/workspaces');
  await dialog.getByRole('button',{name:'创建',exact:true}).click();
  const response=await responsePromise,body=await response.json();
  if(!response.ok()||!body.success||!body.data?.workspace?.id||body.data.workspace.title!==title)throw Error('真人创建未返回本轮精确工作区，不触碰其它资源');
  onCreated(body.data.workspace);
  await page.waitForURL(u=>u.pathname===`/visual-agent/${body.data.workspace.id}`,{timeout:30000});
  return body.data.workspace;
}

export async function submitDefaultPeachThroughUi(page,{workspaceId,pool,onCreated,beforeSubmit,onSubmitted,onMissingReferenceDeclaration}) {
  const model=page.getByRole('button',{name:'模型偏好',exact:true});
  await model.filter({hasText:pool.name}).waitFor({state:'visible',timeout:30000});
  const selectedLabel=(await model.innerText()).trim();
  if(/默认池|图片生成默认池/.test(selectedLabel)||!selectedLabel.includes(pool.name))throw Error('默认项不具体，拒绝付费提交');
  const publication=page.getByRole('button',{name:'投稿已开启（点击关闭）',exact:true});
  if(await publication.count())await publication.click();
  const input=page.locator('[contenteditable="true"]:visible,textarea:visible');
  if(await input.count()!==1)throw Error('真实描述输入锚点不唯一');
  await input.fill('白桃');
  const sizeLabel=await page.getByRole('button',{name:'尺寸比例',exact:true}).innerText();
  if(!/1K[\s\S]*1:1/.test(sizeLabel))throw Error('当前默认不为1024方图，拒绝猜尺寸或切换型号');
  if(beforeSubmit)await beforeSubmit(input,model);
  const pending=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`/api/visual-agent/image-master/workspaces/${workspaceId}/image-gen/runs`,{timeout:60000});
  await page.getByRole('button',{name:'发送',exact:true}).click();
  const response=await pending,body=await response.json();
  if(!response.ok()||!body.success||!body.data?.runId)throw Error(`真人默认生图提交失败：${body.error?.code||response.status()}`);
  onCreated(body.data.runId);
  const request=response.request().postDataJSON();
  const proof={runId:body.data.runId,targetKey:request.targetKey,selectedLabel,placement:{x:request.x,y:request.y,w:request.w,h:request.h},request:{prompt:request.prompt,size:request.size,modelId:request.modelId,platformId:request.platformId,expectedImageRefCount:request.expectedImageRefCount,imageRefCount:(request.imageRefs||[]).length}};
  if(onSubmitted)await onSubmitted(proof);
  try {
    assertDefaultPeachRequest({pool,selectedLabel,request});
  } catch (error) {
    // 旧页面漏声明仍须由调用方原断言记红，但已提交的零引用任务应继续取证，
    // 不能因执行器提前取消而把“尚未检查产物”误报成模型生成失败。
    if (error.code !== 'IMAGE_REFERENCE_DECLARATION' || request.expectedImageRefCount !== undefined
      || (request.imageRefs?.length || 0) !== 0 || typeof onMissingReferenceDeclaration !== 'function') throw error;
    await onMissingReferenceDeclaration(proof);
  }
  // The real UI may omit optional request coordinates. The actual desktop frame
  // keeps unscaled world coordinates as inline left/top/width/height; read that
  // exact created target rather than substituting a guessed API origin.
  if (!['x','y','w','h'].every(key => Number.isFinite(proof.placement[key]))) {
    proof.placement = await readCanvasPlacementThroughUi(page, request.targetKey);
  }
  return proof;
}

export async function readCanvasPlacementThroughUi(page, targetKey) {
  if (!/^[a-z0-9_.-]+$/i.test(targetKey || '')) throw Error('[test/canvas-fixture] 本轮画框身份无效');
  const frame = page.locator(`[data-canvas-key="${targetKey}"]`);
  await frame.waitFor({state:'visible',timeout:15_000});
  if (await frame.count() !== 1) throw Error('[test/canvas-fixture] 本轮主画框不唯一');
  const placement = await frame.evaluate(element => ({
    x:parseFloat(element.style.left),y:parseFloat(element.style.top),
    w:parseFloat(element.style.width),h:parseFloat(element.style.height),
  }));
  secondaryImagePlacement(placement); // Reuse the same finite/positive predicate.
  return placement;
}

export function secondaryImagePlacement(primary) {
  if (!primary || !['x','y','w','h'].every(key => Number.isFinite(primary[key])) || primary.w <= 0 || primary.h <= 0) {
    throw Error('[test/canvas-fixture] 首张图片缺少真实画布位置，不猜测并发图片坐标');
  }
  return { x: primary.x + primary.w + 96, y: primary.y };
}

export function selectSupportedDefaultSizes(info,modelId) {
  if(!info?.matched||info.modelId!==modelId||info.sizesNotApplicable)throw Error('[configuration/model-size] 当前具体型号没有可核对的尺寸合同');
  const sizes=Object.values(info.sizesByResolution||{}).flat().map(x=>x.size).filter(x=>/^\d+x\d+$/.test(x||''));
  const parsed=[...new Set(sizes)].map(size=>{const [width,height]=size.split('x').map(Number);return {size,width,height};}).filter(x=>x.width>0&&x.height>0);
  const square=parsed.find(x=>x.size==='1024x1024');
  const choose=(predicate,preferred)=>parsed.find(x=>x.size===preferred&&predicate(x))||parsed.filter(predicate).sort((a,b)=>a.width*a.height-b.width*b.height)[0];
  const landscape=choose(x=>x.width>x.height,'1536x1024'),portrait=choose(x=>x.width<x.height,'1024x1536');
  if(!square||!landscape||!portrait)throw Error('[configuration/model-size] 具体型号未公布本例所需方横竖尺寸，不猜测或强制不支持尺寸');
  return {square,landscape,portrait};
}

// VIS004仅消费当前具体型号公开且页面能选择的档位；不改白桃1024主例合同。
export function planDefaultAspectJourney(info, modelId, { environment, commit }) {
  if (!info?.matched || info.modelId !== modelId || info.sizesNotApplicable
    || !['cds', 'production'].includes(environment) || !/^[a-f0-9]{40}$/i.test(commit || '')) {
    throw Error('[configuration/model-size] 当前默认型号、尺寸合同或轮换身份不可核验');
  }
  const selectable = [];
  for (const tier of ['1k', '2k', '4k']) {
    const seen = new Set();
    for (const option of info.sizesByResolution?.[tier] || []) {
      if (!/^\d+x\d+$/.test(option.size || '') || !/^\d+:\d+$/.test(option.aspectRatio || '')) {
        throw Error('[configuration/model-size] 尺寸或页面比例标识缺失，不猜测静态选项');
      }
      // 真实页面同档同一比例只渲染第一项，不能选择其后更小的隐藏尺寸。
      if (seen.has(option.aspectRatio)) continue;
      seen.add(option.aspectRatio);
      const [width, height] = option.size.split('x').map(Number);
      if (!(width > 0 && height > 0)) throw Error('[configuration/model-size] 尺寸必须为正数');
      selectable.push({ ...option, tier, width, height,
        orientation: width === height ? 'square' : width > height ? 'landscape' : 'portrait' });
    }
  }
  const orientations = ['square', 'landscape', 'portrait'];
  const labels = { square: '方形', landscape: '横版', portrait: '竖版' };
  const available = orientations.flatMap(orientation => {
    const smallest = selectable.filter(item => item.orientation === orientation)
      .sort((a, b) => a.width * a.height - b.width * b.height)[0];
    return smallest ? [{ ...smallest, prompt: `${labels[orientation]}产品照，一枚蓝色陶瓷杯，纯白背景，不要文字` }] : [];
  });
  if (!available.length) throw Error('[configuration/model-size] 当前具体默认没有可选择的固定尺寸，不付费试探');
  const rotation = [...commit].reduce((sum, character) => sum + character.charCodeAt(0), 0) % available.length;
  return { available, requested: environment === 'production' ? [available[rotation]] : available,
    unsupportedOrientations: orientations.filter(orientation => !available.some(item => item.orientation === orientation)) };
}

export async function submitDefaultAspectThroughUi(page, { workspaceId, pool, requested, onCreated, onSubmitted }) {
  if (!pool?.isDefault || !pool.code || !pool.name || /默认池|default\s*pool/i.test(pool.name)) throw Error('[configuration/model-size] 后端没有唯一具体默认，不另选健康型号');
  if (new URL(page.url()).pathname !== `/visual-agent/${workspaceId}`) throw Error('[test/aspect-navigation] 必须从首页真实新建本轮项目');
  const model = page.getByRole('button', { name: '模型偏好', exact: true });
  await model.filter({ hasText: pool.name }).waitFor({ state: 'visible', timeout: 30_000 });
  const selectedLabel = (await model.innerText()).trim();
  if (!selectedLabel.includes(pool.name) || /默认池|default\s*pool/i.test(selectedLabel)) throw Error('[configuration/model-size] 页面具体默认与配置不一致，不提交');
  const publication = page.getByRole('button', { name: '投稿已开启（点击关闭）', exact: true });
  if (await publication.count()) await publication.click();
  const sizeButton = page.getByRole('button', { name: '尺寸比例', exact: true });
  await sizeButton.click();
  await page.getByRole('button', { name: requested.tier.toUpperCase(), exact: true }).click();
  await page.getByRole('button', { name: requested.aspectRatio, exact: true }).click();
  if (!(await sizeButton.innerText()).includes(`${requested.tier.toUpperCase()} · ${requested.aspectRatio}`)) throw Error('[test/aspect-selection] 页面未保留所选档位和比例，不提交');
  const input = page.locator('[contenteditable="true"]:visible,textarea:visible');
  if (await input.count() !== 1) throw Error('[test/aspect-input] 真实描述输入锚点不唯一');
  await input.fill(requested.prompt);
  const pending = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/visual-agent/image-master/workspaces/${workspaceId}/image-gen/runs`, { timeout: 60_000 });
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const response = await pending, body = await response.json();
  if (!response.ok() || !body.success || !body.data?.runId) throw Error(`[aspect/request] 真人画幅提交失败：${body.error?.code || response.status()}`);
  onCreated(body.data.runId); // 任何后续断言失败前登记真实任务身份。
  const request = response.request().postDataJSON();
  const proof = { runId: body.data.runId, targetKey: request.targetKey, selectedLabel,
    request: { prompt: request.prompt, modelId: request.modelId, platformId: request.platformId, size: request.size,
      expectedImageRefCount: request.expectedImageRefCount, imageRefCount: (request.imageRefs || []).length } };
  if (onSubmitted) await onSubmitted(proof);
  if (request.modelId !== pool.code || request.platformId !== 'logical-model' || request.size !== requested.size
    || !request.targetKey || ![requested.prompt, `Generate an image based on the following description:\n${requested.prompt}`].includes(request.prompt)
    || (request.imageRefs || []).length || (request.expectedImageRefCount !== undefined && request.expectedImageRefCount !== 0)) {
    throw Error('[aspect/request] 真实请求的型号、画幅、描述、零引用或画框身份不匹配');
  }
  return proof;
}

// VIS004 的合同是公布画幅；自适应模型的推荐像素不是固定像素保证。
// 白桃/JPEG 的独立1024主例不调用本函数，不能借此关闭其严格像素合同。
export function assertDefaultAspectArtifact(info, requested, dimensions) {
  const {width, height} = dimensions || {};
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw Error('[aspect/artifact] 图片必须可解码且像素为正整数');
  }
  const adaptive = info?.isAdaptive === true && info?.sizeParamFormat === 'none'
    && info?.sizeConstraint?.type === 'adaptive';
  if (width * requested.height !== height * requested.width) throw Error('[aspect/artifact] 实际画幅与所选比例不一致');
  if (!adaptive && (width !== requested.width || height !== requested.height)) {
    throw Error('[aspect/artifact] 固定尺寸模型的实际像素不符合所选尺寸');
  }
  for (const [bound, value, violates] of [
    ['minWidth', width, (a,b)=>a<b], ['minHeight', height, (a,b)=>a<b],
    ['maxWidth', width, (a,b)=>a>b], ['maxHeight', height, (a,b)=>a>b],
    ['maxPixels', width * height, (a,b)=>a>b],
  ]) {
    const limit = info?.limitations?.[bound];
    if (Number.isFinite(limit) && limit > 0 && violates(value, limit)) throw Error('[aspect/artifact] 产物超出型号已公布的尺寸边界');
  }
  const divisor = info?.limitations?.mustBeDivisibleBy;
  if (Number.isSafeInteger(divisor) && divisor > 0 && (width % divisor || height % divisor)) throw Error('[aspect/artifact] 产物不符合型号整除限制');
  return {dimensionContract:adaptive?'adaptive-aspect-only':'fixed-pixels', dimensions:{width,height}};
}
