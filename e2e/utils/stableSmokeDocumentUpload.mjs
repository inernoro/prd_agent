function contract(condition, message) {
  if (!condition) throw Error(`[test/document-upload] ${message}`);
}

export async function findDocumentUploadCard(page, { fileName, phase, timeout = 5_000 }) {
  contract(typeof fileName === 'string' && fileName.startsWith('stsmk-') && !/[\r\n]/.test(fileName), '必须绑定本轮完整文件名');
  contract(['uploading', 'parsing'].includes(phase), '未知阶段不得由百分比猜测');
  const title = page.getByText(`${phase === 'uploading' ? '正在上传' : '正在解析'} ${fileName}`, { exact: true });
  await title.waitFor({ state: 'visible', timeout });
  contract(await title.count() === 1, '本轮完整文件名的阶段标题必须唯一');
  const modern = page.getByTestId('document-upload-progress');
  contract(await modern.count() <= 1, '同一文件不能匹配多张进度卡');
  // 1678旧卡没有testid；两版真实源码都是标题→标题行→卡，不能退到全页面。
  const card = await modern.count() === 1 ? modern : title.locator('..').locator('..');
  await card.waitFor({ state: 'visible', timeout });
  contract(await card.count() === 1, '本轮真实进度卡必须唯一可见');
  await readDocumentUploadView(card, { fileName, phase });
  return card;
}

export async function readDocumentUploadView(card, { fileName, phase }) {
  const title = `${phase === 'uploading' ? '正在上传' : '正在解析'} ${fileName}`;
  contract(await card.getByText(title, { exact: true }).count() === 1, '阶段必须属于同一完整文件名，不能借其他模块文案');
  const text = await card.innerText();
  if (phase === 'parsing') {
    const match = text.match(/解析中\s*·\s*已等待 (\d+) 秒/);
    contract(Boolean(match), '解析阶段必须明确展示解析中及等待秒数，99%不等于解析');
    return { phase, parsingSeconds: Number(match[1]) };
  }
  const match = text.replace(title, '').trim().match(/(?:^|\s)(\d{1,3})%(?:$|\s)/);
  contract(Boolean(match) && Number(match[1]) <= 100, '真实上传阶段必须显示合法百分比');
  return { phase, percent: Number(match[1]) };
}

export async function observeDocumentUploadPhases({ observe, releaseResponse, onFailure }) {
  let failure = null;
  let evidenceFailure = null;
  try {
    await observe();
  } catch (error) {
    failure = { message: String(error?.message || error), stack: String(error?.stack || '') };
    if (onFailure) {
      try { await onFailure(failure); }
      catch (evidenceError) { evidenceFailure = String(evidenceError?.message || evidenceError); }
    }
  } finally {
    // 释放的是既有测试控速回调，不伪造网络结果；失败也必须让原任务走到真实终态。
    await releaseResponse();
  }
  return { status: failure ? 'fail' : 'pass', failure, evidenceFailure, controlledWait: '测试仅扣住XHR.onload回调，不代表自然网络或服务端卡死' };
}

export async function releaseDocumentUploadResponse(page) {
  await page.evaluate(() => {
    const release = window.__stableSmokeResumeDocumentUpload;
    if (typeof release !== 'function') throw Error('[test/document-upload] 原测试控速释放函数缺失');
    release();
  });
}
