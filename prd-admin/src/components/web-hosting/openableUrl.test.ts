import { describe, expect, it } from 'vitest';
import { toOpenableUrl } from './siteFormat';

/**
 * 站点地址有两种形状，取决于这套部署用的对象存储：R2/COS 回绝对地址，本地磁盘回
 * `/local-assets/...` 相对路径。上传完成那一屏写着「可打开的地址」、旁边还有复制按钮，
 * 所以两种形状都必须给出真的能打开的串。
 *
 * 一律拼 origin → 绝对地址被拼成 `https://admin.xxxhttps://storage.xxx/...`，打不开；
 * 一律不拼 → 本地磁盘那档给出的相对路径离开本站就打不开。
 */
describe('把站点地址变成贴到别处也能打开的地址', () => {
  const origin = 'https://admin.example';

  it('已经是绝对地址的原样返回，不许再拼一层 origin', () => {
    const abs = 'https://storage.example/sites/abc/index.html?v=1';
    expect(toOpenableUrl(abs, origin)).toBe(abs);
    expect(toOpenableUrl('http://storage.example/x', origin)).toBe('http://storage.example/x');
  });

  it('协议相对地址也算绝对，不许拼', () => {
    expect(toOpenableUrl('//storage.example/x', origin)).toBe('//storage.example/x');
  });

  it('本地磁盘那档的相对路径要补上 origin', () => {
    expect(toOpenableUrl('/local-assets/sites/abc/index.html', origin))
      .toBe('https://admin.example/local-assets/sites/abc/index.html');
  });

  it('没有前导斜杠的相对路径也补齐，不许拼出 originpath', () => {
    expect(toOpenableUrl('local-assets/x', origin)).toBe('https://admin.example/local-assets/x');
  });

  it('空值返回空串，不返回一个只有 origin 的假地址', () => {
    // 返回 origin 的话，界面上会显示一个指向后台首页的「站点地址」，比空着更误导
    expect(toOpenableUrl('', origin)).toBe('');
    expect(toOpenableUrl(null, origin)).toBe('');
    expect(toOpenableUrl(undefined, origin)).toBe('');
  });
});
