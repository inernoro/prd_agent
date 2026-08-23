import { beforeEach, describe, expect, it } from 'vitest';

// 本仓库前端没有 jsdom，globalThis 上没有 sessionStorage。给一个最小实现，
// 测的是分键逻辑本身，不需要真浏览器。
class MemoryStorage {
  private map = new Map<string, string>();
  getItem = (k: string) => (this.map.has(k) ? this.map.get(k)! : null);
  setItem = (k: string, v: string) => void this.map.set(k, String(v));
  removeItem = (k: string) => void this.map.delete(k);
  clear = () => this.map.clear();
}
Object.defineProperty(globalThis, 'sessionStorage', {
  value: new MemoryStorage(),
  configurable: true,
});

const { stashPendingAuthorization } = await import('../DataSyncCallbackPage');

/**
 * 两个标签页各发起一次同步，不许互相踩。
 *
 * 原来是一个固定键：第二次 prepare 覆盖第一次那条，之后无论谁先回来都失败——
 * 先回来的读到另一次的 state，判「对不上」并顺手把这唯一一条删掉，另一个回来时
 * 连记录都没了。两次都白跑，而错误文案说「与本机发起的授权对不上」，看着像被攻击。
 */
describe('待回跳的授权按 state 分开存', () => {
  beforeEach(() => sessionStorage.clear());

  it('两次授权各自独立，互不覆盖', () => {
    stashPendingAuthorization('state-a', { state: 'state-a', sourceOrigin: 'https://a.example.com' });
    stashPendingAuthorization('state-b', { state: 'state-b', sourceOrigin: 'https://b.example.com' });

    expect(JSON.parse(sessionStorage.getItem('data-sync:pending:state-a') || 'null'))
      .toMatchObject({ sourceOrigin: 'https://a.example.com' });
    expect(JSON.parse(sessionStorage.getItem('data-sync:pending:state-b') || 'null'))
      .toMatchObject({ sourceOrigin: 'https://b.example.com' });
  });

  it('不再往那个会被互相覆盖的固定键上写', () => {
    stashPendingAuthorization('state-a', { state: 'state-a', sourceOrigin: 'https://a.example.com' });
    expect(sessionStorage.getItem('data-sync:pending')).toBeNull();
  });
});
