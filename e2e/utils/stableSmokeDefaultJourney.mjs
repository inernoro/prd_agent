export function assertDefaultPeachRequest({ pool, selectedLabel, request }) {
  if (!pool?.isDefault || !pool.code || !pool.name || /默认池|default\s*pool|图片生成默认池/i.test(pool.name)) throw Error('后端未明确配置具体默认型号');
  if (!selectedLabel?.includes(pool.name) || /默认池|图片生成默认池/i.test(selectedLabel)) throw Error('界面默认型号与后端配置不一致');
  const prompts = ['白桃', 'Generate an image based on the following description:\n白桃'];
  if (!prompts.includes(request?.prompt) || request?.size !== '1024x1024') throw Error('真人默认主例必须为白桃1024方图');
  if (request.modelId !== pool.code || request.platformId !== 'logical-model') throw Error('界面选择与真实发送模型不一致');
  if (request.expectedImageRefCount !== 0 || (request.imageRefs?.length || 0) !== 0) throw Error('无参考主例不得静默带入引用');
  if (!request.targetKey) throw Error('真实请求缺少画布任务身份');
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

export async function submitDefaultPeachThroughUi(page,{workspaceId,pool,onCreated,beforeSubmit,onSubmitted}) {
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
  assertDefaultPeachRequest({pool,selectedLabel,request});
  return proof;
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
