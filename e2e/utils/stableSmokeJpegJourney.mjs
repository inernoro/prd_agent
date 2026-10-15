import { createHash } from 'node:crypto';

export const jpegReferencePrompt = '保留 @img1 的蓝色主色，生成纯白背景上的一只蓝色陶瓷杯，不要文字';

export function assertDefaultJpegPrimary({ pool, logicalModelPublicId, primaryProtocol }) {
  if (!pool?.isDefault || !pool.code || !pool.name || /默认池|default\s*pool/i.test(pool.name)) {
    throw Error('[configuration/jpeg-default] 后端没有明确的具体默认模型，不能选首个可用型号代替');
  }
  if (logicalModelPublicId !== pool.code || !['openai', 'openai-compatible'].includes(primaryProtocol)) {
    throw Error('[configuration/jpeg-default] 当前具体默认不支持本例要求的JPEG编辑主路，不切换型号或协议凑通过');
  }
}

export function assertJpegUploadRequest({ jpegBytes, request, asset }) {
  const bytes = Buffer.from(jpegBytes);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw Error('[test/jpeg-fixture] 夹具必须是真实JPEG字节');
  if (!/^data:image\/jpeg;base64,/.test(request?.data || '')) throw Error('[jpeg/upload] 页面上传声明不是image/jpeg');
  const sent = Buffer.from(request.data.split(',')[1], 'base64');
  if (!bytes.equals(sent)) throw Error('[jpeg/upload] 页面上传改变或丢失了原始JPEG字节');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (asset?.sha256 !== sha256 || !asset.url) throw Error('[jpeg/upload] 上传资产身份与原始JPEG哈希不一致');
  return { sha256, bytes: bytes.length, mime: 'image/jpeg', extension: '.jpg' };
}

export function assertDefaultJpegRequest({ pool, selectedLabel, request, referenceSha256 }) {
  if (!pool?.isDefault || !selectedLabel?.includes(pool.name) || /默认池|default\s*pool/i.test(selectedLabel)) throw Error('[jpeg/default] 页面具体默认与后端不一致');
  if (request?.modelId !== pool.code || request?.platformId !== 'logical-model') throw Error('[jpeg/default] 真实提交静默切换默认型号');
  if (request.size !== '1024x1024' || !request.targetKey) throw Error('[jpeg/request] 必须保持1024方图及真实画框身份');
  if (request.imageRefs?.length !== 1 || request.imageRefs[0]?.assetSha256 !== referenceSha256) throw Error('[jpeg/reference] 必须结构化发送同一JPEG参考图且数量恰为1');
  if (!request.imageRefs[0].url || request.imageRefs[0].refId !== 1) throw Error('[jpeg/reference] 真实请求缺少参考图URL或稳定引用身份');
  if (!request.prompt?.includes(jpegReferencePrompt)) throw Error('[jpeg/request] 真实请求未保留页面输入的参考图描述');
  if (request.expectedImageRefCount !== 1) {
    const error = Error('[jpeg/reference] 页面必须显式声明参考图数量为1');
    error.code = 'IMAGE_REFERENCE_DECLARATION';
    throw error;
  }
}

export async function submitDefaultJpegThroughUi(page, { workspaceId, pool, jpegBytes, onCreated, onUploaded, onSubmitted, onMissingReferenceDeclaration }) {
  if (new URL(page.url()).pathname !== `/visual-agent/${workspaceId}`) throw Error('[test/jpeg-navigation] 必须先从首页真实新建本轮项目');
  const model = page.getByRole('button', { name: '模型偏好', exact: true });
  await model.filter({ hasText: pool.name }).waitFor({ state: 'visible', timeout: 30_000 });
  const selectedLabel = (await model.innerText()).trim();
  if (!selectedLabel.includes(pool.name) || /默认池|default\s*pool/i.test(selectedLabel)) throw Error('[jpeg/default] 页面未保持后端具体默认，不付费提交');
  const uploadButton = page.getByRole('button', { name: '上传图片', exact: true }).and(page.locator(':visible'));
  await uploadButton.waitFor({ state: 'visible', timeout: 30_000 });
  if (await uploadButton.count() !== 1) throw Error('[test/jpeg-upload] 页面上传入口必须唯一可见');
  const fileName = 'stsmk-jpeg-reference.jpg';
  const [upload] = await Promise.all([
    page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/visual-agent/image-master/workspaces/${workspaceId}/assets`, { timeout: 60_000 }),
    (async () => {
      const choice = page.waitForEvent('filechooser');
      await uploadButton.click();
      await (await choice).setFiles({ name: fileName, mimeType: 'image/jpeg', buffer: jpegBytes });
    })(),
  ]);
  const uploaded = await upload.json();
  if (!upload.ok() || !uploaded.success || !uploaded.data?.asset) throw Error(`[jpeg/upload] 真人上传失败：${uploaded.error?.code || upload.status()}`);
  const reference = assertJpegUploadRequest({ jpegBytes, request: upload.request().postDataJSON(), asset: uploaded.data.asset });
  if (onUploaded) await onUploaded(reference);
  const image = page.locator(`[data-testid="canvas-image"][alt="${fileName}"]`);
  await image.waitFor({ state: 'visible', timeout: 30_000 });
  if (await image.count() !== 1) throw Error('[test/jpeg-reference] 本轮参考图必须唯一');
  await image.evaluate(async element => { await element.decode(); });
  const publication = page.getByRole('button', { name: '投稿已开启（点击关闭）', exact: true });
  if (await publication.count()) await publication.click();
  const input = page.locator('[contenteditable="true"]:visible,textarea:visible');
  if (await input.count() !== 1) throw Error('[test/jpeg-input] 描述输入锚点必须唯一');
  await input.fill(jpegReferencePrompt);
  const sizeLabel = await page.getByRole('button', { name: '尺寸比例', exact: true }).innerText();
  if (!/1K[\s\S]*1:1/.test(sizeLabel)) throw Error('[configuration/jpeg-size] 当前默认不是1024方图，不猜尺寸或换型号');
  const [response] = await Promise.all([
    page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/visual-agent/image-master/workspaces/${workspaceId}/image-gen/runs`, { timeout: 60_000 }),
    page.getByRole('button', { name: '发送', exact: true }).click(),
  ]);
  const body = await response.json();
  if (!response.ok() || !body.success || !body.data?.runId) throw Error(`[jpeg/request] 真人生成提交失败：${body.error?.code || response.status()}`);
  onCreated(body.data.runId); // 先登记清理身份，后做强断言。
  const request = response.request().postDataJSON();
  const proof = { runId: body.data.runId, targetKey: request.targetKey, selectedLabel, reference, request: { modelId: request.modelId, platformId: request.platformId, size: request.size, expectedImageRefCount: request.expectedImageRefCount, imageRefs: request.imageRefs } };
  if (onSubmitted) await onSubmitted(proof);
  try {
    assertDefaultJpegRequest({ pool, selectedLabel, request, referenceSha256: reference.sha256 });
  } catch (error) {
    // 只观察已提交且其余合同全对的缺声明任务；原case仍须记红，不补写真实请求。
    if (error.code !== 'IMAGE_REFERENCE_DECLARATION' || request.expectedImageRefCount !== undefined
      || typeof onMissingReferenceDeclaration !== 'function') throw error;
    await onMissingReferenceDeclaration(proof);
  }
  return proof;
}
