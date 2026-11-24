/**
 * 「先把钥匙交出去，再做别的」的顺序守卫。
 *
 * 这块地方已经栽过两次，形态不同、后果一样 —— 用户手里多一把自己看不到、也找不回来的钥匙：
 *  1. 父页面刷新把整页换成 loader，弹窗连带卸载，明文随 state 一起没了；
 *  2. 签发成功后先 await 授权自检再切步骤，而自检那条请求没有超时 ——
 *     它挂住时用户既看不到已经生效的钥匙，也关不掉弹窗（关闭在签发期间被锁着）。
 *
 * 两次都不会让任何测试变红：接口 200、钥匙确实建出来了、页面照常渲染。
 * 所以这里钉住源码里的**先后顺序**：明文与步骤切换必须排在自检之前。
 *
 * 断言的是顺序这个行为，不是某段实现的字面存在 —— 自检怎么写、超时多少都可以改，
 * 但它不能重新爬到「交出钥匙」的前面去。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(DIR, 'ConnectAgentDialog.tsx'), 'utf8');

/** 只取 createKey 那一段，免得断言被文件别处的同名调用满足（取错了那个值）。 */
function createKeyBody(): string {
  const begin = source.indexOf('const createKey = useCallback');
  expect(begin).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('const configSnippet', begin);
  expect(end).toBeGreaterThan(begin);
  return source.slice(begin, end);
}

describe('接入向导：签发之后的动作顺序', () => {
  it('明文与步骤切换排在授权自检之前', () => {
    const body = createKeyBody();
    const reveal = body.indexOf('setPlaintext(res.data.apiKey)');
    const toConnect = body.indexOf("setStep('connect')");
    const selfCheck = body.indexOf('runSelfCheck(');

    expect(reveal).toBeGreaterThanOrEqual(0);
    expect(toConnect).toBeGreaterThan(reveal);
    expect(selfCheck).toBeGreaterThan(toConnect);
  });

  it('自检有等待上限，不许无限期挂着', () => {
    // 没有上限时，自检挂住就是一个永远转下去的状态；用户看不出它已经不会有结果了
    expect(source).toContain('SelfCheckTimeoutMs');
    expect(source).toMatch(/withTimeout\(\s*getMcpVisibleTools\(/);
  });

  it('父页面刷新不许把整页换成 loader（第一种事故形态）', () => {
    const page = fs.readFileSync(path.join(DIR, 'McpConsolePage.tsx'), 'utf8');
    const load = page.slice(
      page.indexOf('const load = useCallback'),
      page.indexOf('const refresh = useCallback'),
    );
    expect(load.length).toBeGreaterThan(0);
    expect(load).not.toContain('setLoading(true)');
  });
});
