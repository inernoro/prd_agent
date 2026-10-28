import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { rewriteEphemeralListenArgs, installEphemeralLoopbackFixture } from '../helpers/ephemeral-loopback-fixture.js';
const require = createRequire(import.meta.url);
const net = require('node:net') as typeof import('node:net');
const dns = require('node:dns') as typeof import('node:dns');
const http = require('node:http') as typeof import('node:http');
const close = (s: import('node:net').Server) => new Promise<void>((r, j) => s.close(e => e ? j(e) : r()));

describe('临时 HTTP 测试监听地址', () => {
  it('只转换缺 host 的 port0，显式 host/IPv6/unix/fd/handle/非0原样保留', () => {
    const untouched: any[][] = [[1], [8080], ['/tmp/not-executed.sock'], [{path:'/tmp/not-executed.sock'}], [{fd:1}], [{handle:{}}], [{port:0,host:'::1'}], [0,'::1'], [0,'127.0.0.1'], [{port:0,host:undefined}], [{port:0,ipv6Only:true}], [{port:0,family:6}], [{port:0,reusePort:true}]];
    untouched.forEach(a => expect(rewriteEphemeralListenArgs(a)).toBeNull());
    for (const a of [[0], [0,()=>{}], [0,100,()=>{}], [0,undefined,()=>{}], [{port:0}], [{port:'0',backlog:10}]]) {
      const result = rewriteEphemeralListenArgs(a)!;
      expect(result[0]).toMatchObject({host:'127.0.0.1'});
      expect(result.slice(1)).toEqual(a.slice(1));
    }
  });

  it('默认监听同步提供IPv4地址，回调仍异步，IPv4请求只收到本server响应', async () => {
    const restore = installEphemeralLoopbackFixture();
    const lookupBefore = Object.getOwnPropertyDescriptor(dns, 'lookup');
    try {
      for (let i=0; i<30; i++) {
        const own = 'fixture-'+i;
        const s = http.createServer((_q,r) => {r.setHeader('X-Fixture-Server',own);r.end(own);});
        try {
          let callback = false;
          s.listen(0, () => {callback=true;});
          expect(callback).toBe(false);
          const a = s.address() as import('node:net').AddressInfo;
          expect(a.address).toBe('127.0.0.1');
          expect(Object.getOwnPropertyDescriptor(dns,'lookup')).toEqual(lookupBefore);
          const res = await new Promise<{status:number;body:string;identity:string|undefined}>((resolve,reject) => {
            http.get({hostname:'127.0.0.1',port:a.port,path:'/fixture',agent:false},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>resolve({status:r.statusCode!,body:b,identity:r.headers['x-fixture-server'] as string|undefined}));}).on('error',reject);
          });
          expect(res).toEqual({status:200,body:own,identity:own});
        } finally {if(s.listening)await close(s);}
      }
    } finally {restore();}
  });

  it('原listen抛错也立即恢复lookup，卸载逐值恢复prototype descriptor', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(net.Server.prototype,'listen');
    const lookup = Object.getOwnPropertyDescriptor(dns,'lookup');
    const restore = installEphemeralLoopbackFixture();
    const s = net.createServer();
    try {
      s.listen(0);
      expect(()=>s.listen(0)).toThrow();
      expect(Object.getOwnPropertyDescriptor(dns,'lookup')).toEqual(lookup);
    } finally {if(s.listening)await close(s);restore();}
    expect(Object.getOwnPropertyDescriptor(net.Server.prototype,'listen')).toEqual(descriptor);
    expect(Object.getOwnPropertyDescriptor(dns,'lookup')).toEqual(lookup);
  });
});
