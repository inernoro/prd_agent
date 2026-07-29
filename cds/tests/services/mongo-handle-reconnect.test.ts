/**
 * 状态库 handle 连接失败后必须能重连（Codex PR #1275 P1）。
 *
 * 事故本体的修复是「启动期退避重试」，但重试落在同一个 handle 实例上。原实现
 * 先 `this.client = new MongoClient(...)` 再 `await this.client.connect()`——
 * 连接失败时 client 已经挂在实例上、db/collections 全空，下一次 connect() 被
 * `if (this.client) return` 直接短路，之后任何取集合都抛「not connected」。
 * 于是重试机制形同虚设：mongo 恢复了也连不上，仍旧 boot 失败。
 *
 * 这里用 mock 的 mongodb 驱动把「第一次连失败、第二次连成功」跑一遍，钉住两点：
 *  1. 失败时关掉半开连接（不泄漏 socket）且实例状态回到「未连接」；
 *  2. 后续 connect() 会真的再建一次连接，成功后集合可用。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const connectMock = vi.fn();
const closeMock = vi.fn();
const collectionMock = vi.fn(() => ({ name: 'stub-collection' }));
const dbMock = vi.fn(() => ({ collection: collectionMock }));
const constructed: unknown[] = [];

vi.mock('mongodb', () => ({
  MongoClient: class {
    constructor(uri: string) {
      constructed.push(uri);
    }
    connect = connectMock;
    close = closeMock;
    db = dbMock;
  },
}));

const { RealMongoSplitHandle } = await import('../../src/infra/state-store/mongo-split-handle.js');
const { RealMongoHandle } = await import('../../src/infra/state-store/mongo-handle.js');

beforeEach(() => {
  connectMock.mockReset();
  closeMock.mockReset();
  closeMock.mockResolvedValue(undefined);
  constructed.length = 0;
});

describe('RealMongoSplitHandle.connect 失败复位', () => {
  it('连接失败会关闭半开连接并抛出，实例保持未连接', async () => {
    connectMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const h = new RealMongoSplitHandle({ uri: 'mongodb://127.0.0.1:27018' });

    await expect(h.connect()).rejects.toThrow('ECONNREFUSED');
    expect(closeMock).toHaveBeenCalledTimes(1);
    // 未连接：取集合必须抛，而不是返回一个空壳
    expect(() => h.globalCollection()).toThrow(/not connected/i);
  });

  it('失败后再 connect 会真的重连一次（重试不再被短路）', async () => {
    connectMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const h = new RealMongoSplitHandle({ uri: 'mongodb://127.0.0.1:27018' });
    await expect(h.connect()).rejects.toThrow();

    connectMock.mockResolvedValueOnce(undefined);
    await h.connect();

    // 两次都真的 new 了 client、真的调了 connect()
    expect(constructed).toHaveLength(2);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(() => h.globalCollection()).not.toThrow();
  });
});

describe('RealMongoHandle.connect 失败复位', () => {
  it('同样的复位语义（两个 handle 是同一个坑）', async () => {
    connectMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const h = new RealMongoHandle({ uri: 'mongodb://127.0.0.1:27018' });
    await expect(h.connect()).rejects.toThrow('ECONNREFUSED');
    expect(closeMock).toHaveBeenCalledTimes(1);

    connectMock.mockResolvedValueOnce(undefined);
    await h.connect();
    expect(constructed).toHaveLength(2);
    expect(connectMock).toHaveBeenCalledTimes(2);
  });
});
