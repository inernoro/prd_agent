/**
 * Forwarder 路由解析单测 — TDD 契约
 *
 * 对应 spec.cds-blue-green-mece-acceptance.md 维度 1.1 / 1.2 / 4.4
 * 实现位置(尚未存在):cds/src/forwarder/route-resolver.ts
 *
 * 路由解析器职责:接收 (host, path) → 返回匹配到的路由记录(包含
 * upstream port)或 null(找不到)。纯函数,不发 HTTP,不 IO。
 */
import { describe, it } from 'vitest';

describe('RouteResolver — host + path 匹配', () => {
  it.todo('[C-1.1] 精确 host 匹配优先于通配 *.miduo.org');
  it.todo('[C-1.1] *.miduo.org 通配匹配 demo.miduo.org');
  it.todo('[C-1.1] 多级子域名 a.b.miduo.org 不会被 *.miduo.org 错配');
  it.todo('[C-1.1] pathPrefix 为 /api/ 时,/api/foo 命中,/web/foo 不命中');
  it.todo('[C-1.1] pathPrefix 为空时,任何路径都命中');
  it.todo('[C-1.1] 同一 host 下多条路由按 pathPrefix 长度降序优先(更具体的先匹配)');
  it.todo('[C-1.2] 未注册 host 返回 null');
  it.todo('[C-1.2] 注册 host 但 path 不匹配任何前缀 → 返回 fallback 路由(若有)或 null');
  it.todo('[C-4.4] 伪造 Host header 走与正常请求相同的查表逻辑(查不到就 null,不 fallback 到任意 upstream)');
  it.todo('[C-4.4] 路由表为空时,任何请求都返回 null,不 panic');
  it.todo('[C-1.1] weight=0 的路由跳过(不参与匹配)');
  it.todo('[C-1.1] 多条等权重路由命中时,稳定地按 _id 排序选第一条');
});

describe('RouteResolver — 灰度权重(B\'.7 才实现,先占位)', () => {
  it.todo('[C-1.1] 同一 host+path 两条路由,weight 50/50 时,1000 次请求大致 500/500 ±50');
  it.todo('[C-1.1] cookie 携带 sticky-route id 时,后续请求始终命中同一 upstream');
});
