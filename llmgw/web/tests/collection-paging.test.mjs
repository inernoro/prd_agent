import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionPage } from '../src/lib/collectionPaging.ts';
import { groupModelProviders } from '../src/lib/modelProviderGroups.ts';

const names = Array.from({ length: 10000 }, (_, i) => ({ id: `model-${i}`, name: i === 9999 ? '最后一项 SUNBURST' : `模型 ${i}` }));
const text = (item) => `${item.id} ${item.name}`;
test('万条模型中的末项能被跨页搜索，大小写与首尾空格不影响匹配', () => {
  const result = collectionPage(names, ' sunburst ', text, 18, 10);
  assert.equal(result.total, 1);
  assert.equal(result.current, 1);
  assert.equal(result.items[0].id, 'model-9999');
});
test('逐页遍历包含每一项，不能截断首十条后丢掉其余模型', () => {
  const ids = new Set();
  for (let page = 1; page <= 1000; page++) for (const item of collectionPage(names, '', text, page, 10).items) ids.add(item.id);
  assert.equal(ids.size, names.length);
  assert.ok(ids.has('model-9999'));
});
test('删除后夹住失效页码，空结果可正常返回而不出现负页码', () => {
  assert.equal(collectionPage(names.slice(0, 15), '', text, 1000, 10).current, 2);
  assert.deepEqual(collectionPage([], 'missing', text, 10, 10), { items: [], total: 0, pages: 1, current: 1, start: 0 });
});
test('AppCaller数量不决定当前页条数，分页能到达最后一条权限', () => {
  const codes = Array.from({ length: 262 }, (_, i) => `app-${i}.feature::chat`);
  assert.equal(collectionPage(codes, '', x => x, 1, 10).items.length, 10);
  assert.deepEqual(collectionPage(codes, '', x => x, 27, 10).items, codes.slice(260));
});
const offering = (id, targetId, targetKind = 'model') => ({ id, targetId, targetKind, providerName: '同名上游', targetName: targetId });
test('同名Provider以真实platformId分组，多条Offering完整保留', () => {
  const routes = [offering('a', 'm1'), offering('b', 'm2'), offering('c', 'm3')];
  const groups = groupModelProviders(routes, [{ id: 'm1', platformId: 'p1' }, { id: 'm2', platformId: 'p1' }, { id: 'm3', platformId: 'p2' }], [{ id: 'p1', name: '同名' }, { id: 'p2', name: '同名' }]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].offerings.length, 2);
  assert.equal(groups[1].platformId, 'p2');
  assert.deepEqual(groups.flatMap(x => x.offerings), routes);
});
test('未解析模型与Exchange不按名字合并，也不会被丢弃', () => {
  const routes = [offering('a', 'missing1'), offering('b', 'missing2'), offering('c', 'missing1', 'exchange')];
  const groups = groupModelProviders(routes, [], []);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.flatMap(x => x.offerings), routes);
  assert.equal(groups[2].targetKind, 'exchange');
});
test('万条Offering聚合成两家供应方，但全部线路均可独立检索', () => {
  const routes = Array.from({ length: 10000 }, (_, i) => offering(`o${i}`, i % 2 ? 'm1' : 'm2'));
  const groups = groupModelProviders(routes, [{ id: 'm1', platformId: 'p1' }, { id: 'm2', platformId: 'p2' }], []);
  assert.equal(groups.length, 2);
  assert.equal(groups.reduce((n, x) => n + x.offerings.length, 0), routes.length);
  assert.equal(collectionPage(routes, 'o9999', x => x.id, 1, 10).items[0].id, 'o9999');
});
