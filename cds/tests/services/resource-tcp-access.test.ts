import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { RESOURCE_TCP_PROXY_SCRIPT, resourceTcpAccessConfig } from '../../src/services/resource-tcp-access.js';
import net from 'node:net';

describe('实例临时 TCP 与代理自身的到期控制', () => {
  it('默认关闭；必须显式选择独立 TCP host 和网卡，HTTP 域名不作兜底', () => {
    expect(resourceTcpAccessConfig({}).enabled).toBe(false);
    const env = { CDS_RESOURCE_TCP_ENABLED: '1', CDS_RESOURCE_TCP_HOST: '192.0.2.20', CDS_RESOURCE_TCP_BIND_IP: '192.0.2.20' };
    expect(resourceTcpAccessConfig(env).enabled).toBe(true);
    for (const host of ['', 'mycds.net', '0.0.0.0', '127.0.0.1']) expect(resourceTcpAccessConfig({ ...env, CDS_RESOURCE_TCP_HOST: host }).enabled).toBe(false);
  });

  it('到期关闭监听并销毁已建立的双方连接；不依赖控制面轮询', () => {
    let clock = 1000;
    let accept: (socket: any) => void = () => {};
    let expire: () => void = () => {};
    let listening = false;
    const upstream = new EventEmitter() as any;
    upstream.pipe = () => {};
    upstream.destroy = () => { upstream.destroyed = true; upstream.emit('close'); };
    const server = { listen: () => { listening = true; }, close: () => { listening = false; } };
    vm.runInNewContext(RESOURCE_TCP_PROXY_SCRIPT, {
      require: () => ({ BlockList: net.BlockList, createServer: (fn: typeof accept) => { accept = fn; return server; }, connect: () => upstream }),
      Date: { now: () => clock, parse: Date.parse },
      process: { env: { EXPIRES_AT: new Date(5000).toISOString(), ALLOWLIST: '192.0.2.10/32', TARGET_HOST: 'database', TARGET_PORT: '3306' }, on: () => {}, exit: () => {} },
      setTimeout: (fn: () => void) => { expire = fn; }, setInterval: () => {},
    });
    const client = new EventEmitter() as any;
    client.remoteAddress = '192.0.2.10'; client.pipe = () => {};
    client.destroy = () => { if (!client.destroyed) { client.destroyed = true; client.emit('close'); } };
    // Avoid recursive close delivery from the test upstream stub.
    upstream.destroy = () => { upstream.destroyed = true; };
    expect(listening).toBe(true); accept(client);
    const blocked = { remoteAddress: '192.0.2.11', destroy: () => { blocked.destroyed = true; }, destroyed: false };
    accept(blocked); expect(blocked.destroyed).toBe(true);
    clock = 5000; expire();
    expect(listening).toBe(false); expect(client.destroyed).toBe(true); expect(upstream.destroyed).toBe(true);
  });

  it('过期后容器重启也不开监听；期限缺失直接失败', () => {
    let listened = false;
    const context = { require: () => ({ BlockList: net.BlockList, createServer: () => ({ listen: () => { listened = true; }, close: () => {} }) }), process: { env: { EXPIRES_AT: new Date(0).toISOString(), ALLOWLIST: '192.0.2.10/32' }, on: () => {} }, setInterval: () => {} };
    vm.runInNewContext(RESOURCE_TCP_PROXY_SCRIPT, context);
    expect(listened).toBe(false);
    expect(() => vm.runInNewContext(RESOURCE_TCP_PROXY_SCRIPT, { ...context, process: { env: {}, on: () => {} } })).toThrow('EXPIRES_AT');
  });
});
