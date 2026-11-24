import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureKey, keyShape } from '../../.claude/skills/design-replication/scripts/fixtures.mjs';

/**
 * 设计样例数据（录制-回放）的两个判据函数。
 *
 * 它们出错的方式都是**静默**的：键不稳定 → 回放永远不命中 → 页面悄悄用真数据；
 * 形状比对太松 → fixture 过期了也说一致 → 页面渲染成空而报告说「文案缺失」。
 * 两种都不会抛异常，只会让一份报告变得没有意义，所以必须有测试盯着。
 */

test('查询参数顺序不同不该算两个请求', () => {
  const a = fixtureKey('GET', 'https://x.example/api/web-pages?page=1&pageSize=24');
  const b = fixtureKey('GET', 'https://x.example/api/web-pages?pageSize=24&page=1');
  assert.equal(a, b);
});

test('会改变返回内容的参数必须进键，否则两屏共用一份数据', () => {
  const p1 = fixtureKey('GET', 'https://x.example/api/web-pages?page=1');
  const p2 = fixtureKey('GET', 'https://x.example/api/web-pages?page=2');
  assert.notEqual(p1, p2);
});

test('时间戳类参数不进键，否则每次录的键都不一样、回放永远不命中', () => {
  const a = fixtureKey('GET', 'https://x.example/api/web-pages?_=1724577600000');
  const b = fixtureKey('GET', 'https://x.example/api/web-pages?_=1724577700000');
  assert.equal(a, b);
  assert.equal(a, fixtureKey('GET', 'https://x.example/api/web-pages'));
});

test('方法进键：同一路径的 GET 与 POST 不是同一个响应', () => {
  assert.notEqual(
    fixtureKey('GET', 'https://x.example/api/web-pages/share'),
    fixtureKey('POST', 'https://x.example/api/web-pages/share'),
  );
});

test('域名不进键：同一份 fixture 要能喂给隧道地址与真实域名', () => {
  assert.equal(
    fixtureKey('GET', 'https://real.example.com/api/web-pages'),
    fixtureKey('GET', 'http://127.0.0.1:7801/api/web-pages'),
  );
});

test('超长 URL 截断后仍然互不相同（截成同一个名字会让两个端点共用一份数据）', () => {
  const long = (n) => `https://x.example/api/thing?${Array.from({ length: 40 }, (_, i) => `k${i}=v${i}${n}`).join('&')}`;
  const a = fixtureKey('GET', long('a'));
  const b = fixtureKey('GET', long('b'));
  assert.ok(a.length <= 160, `键太长：${a.length}`);
  assert.notEqual(a, b);
});

test('键只含文件名安全字符', () => {
  const k = fixtureKey('GET', 'https://x.example/api/web-pages/shares/view/中文 token?q=a b/c');
  assert.match(k, /^[A-Za-z0-9._=&~-]+$/, `键里有不安全字符：${k}`);
});

test('形状比对认得出「字段改名」——这正是 fixture 过期的样子', () => {
  const before = keyShape({ success: true, data: { items: [{ id: '1', title: 'a' }] } });
  const after = keyShape({ success: true, data: { list: [{ id: '1', title: 'a' }] } });
  const gone = [...before].filter((k) => !after.has(k));
  assert.ok(gone.length > 0, '字段改名必须被认出来');
});

test('形状比对认得出「多包一层」', () => {
  const flat = keyShape({ items: [{ id: '1' }] });
  const wrapped = keyShape({ data: { items: [{ id: '1' }] } });
  assert.ok([...flat].filter((k) => !wrapped.has(k)).length > 0);
});

test('形状比对不看值：同形状不同内容算一致（fixture 的值就是要手改成设计稿那套）', () => {
  const a = keyShape({ data: { items: [{ id: '1', title: '真实站点', size: 11 }] } });
  const b = keyShape({ data: { items: [{ id: '9', title: '多租户架构设计', size: 4200 }] } });
  assert.deepEqual([...a].sort(), [...b].sort());
});

test('形状比对区分类型：数字变字符串会让前端的格式化炸掉，必须算漂移', () => {
  const a = keyShape({ size: 11 });
  const b = keyShape({ size: '11' });
  assert.notDeepEqual([...a], [...b]);
});

test('空数组不会伪造出元素形状（否则 fixture 空列表会被判成缺一堆键）', () => {
  const empty = keyShape({ items: [] });
  assert.deepEqual([...empty], ['items[]']);
});
