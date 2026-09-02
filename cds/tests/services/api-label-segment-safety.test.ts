/**
 * api-label-segment-safety.test.ts — PR #522 Codex review fix 回归。
 *
 * F9 加的 `GET /branches/:id` label pattern 之前是 `^GET \/branches\/(.+)$`,
 * `(.+)` 贪婪匹配跨 `/`,会吞 `/api/branches/<id>/logs` 等子路径,
 * 把 "查看操作日志" / "查看 Git 提交历史" 都标成 "查看分支详情",
 * Activity Monitor 失去可观测性。
 *
 * 改成 `^GET \/branches\/[^/]+$` 后,regex 本身 segment-safe,
 * 不依赖 patterns 数组顺序,即使后人加新 sub-route 在它之后也不会被吞。
 *
 * 本 test 锁住:
 *   1. 单段 id → "查看分支详情"
 *   2. 子路径(各种已知 sub-route)→ 各自 label,不被截胡
 *   3. 跨段 id 含 `/` → 不命中 detail label
 */

import { describe, it, expect } from 'vitest';
import { resolveApiLabel } from '../../src/server.js';

describe('resolveApiLabel — GET /branches/:id segment safety (PR #522 Codex fix)', () => {
  it('单段 branch id → 查看分支详情', () => {
    expect(resolveApiLabel('GET', '/branches/twenty-demo-main')).toBe('查看分支详情');
    expect(resolveApiLabel('GET', '/branches/abc123')).toBe('查看分支详情');
    expect(resolveApiLabel('GET', '/branches/prd-agent-main')).toBe('查看分支详情');
  });

  /**
   * 2026-09-02（Codex P2，核对属实）：新增 `/metrics/series` 端点时漏了 label。
   * 已有的 `/metrics` pattern 用 `$` 收尾，接不住 `/metrics/series`，于是
   * Activity Monitor 上只显示一串裸 URL，启动时 auditApiLabels 也会打 warning
   * （cds/CLAUDE.md §0.1 要求每条 /api/* 都有中文 label）。
   */
  it('GET /branches/:id/metrics 与 /metrics/series 各有各的 label，互不截胡', () => {
    expect(resolveApiLabel('GET', '/branches/abc/metrics')).toBe('查看分支指标');
    expect(resolveApiLabel('GET', '/branches/abc/metrics/series')).toBe('查看指标历史');
  });

  it('GET /branches/:id/logs → 查看操作日志(不被详情吞)', () => {
    expect(resolveApiLabel('GET', '/branches/twenty-demo-main/logs')).toBe('查看操作日志');
    expect(resolveApiLabel('GET', '/branches/abc/logs')).toBe('查看操作日志');
  });

  it('GET /branches/:id/git-log → 查看 Git 提交历史', () => {
    expect(resolveApiLabel('GET', '/branches/twenty-demo-main/git-log')).toBe('查看 Git 提交历史');
  });

  it('GET /branches/:id/profile-overrides → 获取构建覆写', () => {
    expect(resolveApiLabel('GET', '/branches/abc/profile-overrides')).toBe('获取构建覆写');
  });

  it('GET /branches/:id/subdomain-aliases → 列出分支域名别名', () => {
    expect(resolveApiLabel('GET', '/branches/abc/subdomain-aliases')).toBe('列出分支域名别名');
  });

  it('GET /branches/:id/container-logs-stream/:profileId → 流式查看容器日志', () => {
    expect(resolveApiLabel('GET', '/branches/abc/container-logs-stream/api')).toBe('流式查看容器日志');
  });

  it('GET /branches/stream → 订阅分支状态流(不被详情误命中)', () => {
    expect(resolveApiLabel('GET', '/branches/stream')).toBe('订阅分支状态流');
  });

  /*
   * 同一类坑的第二次：只往 staticMap 加 `PUT /projects/:id/agent-profile`。
   * auditApiLabels 拿 express 路由原样比对，`:id` 字面量能命中，启动零 warning；
   * 而真实请求带的是具体 id，一路落到 `^PUT /projects/(.+)$` 被吞成「更新项目」。
   * 也就是说：那道启动自检对这类缺陷永远不会红。所以判据必须用**真实路径**断言。
   */
  it('GET/PUT /projects/:id/agent-profile 用真实 id 也要拿到自己的 label', () => {
    expect(resolveApiLabel('GET', '/projects/prd-agent/agent-profile')).toBe('获取项目 Agent 角色');
    expect(resolveApiLabel('PUT', '/projects/prd-agent/agent-profile')).toBe('更新项目 Agent 角色');
    expect(resolveApiLabel('GET', '/projects/demo-a/agent-profile')).toBe('获取项目 Agent 角色');
    expect(resolveApiLabel('PUT', '/projects/demo-a/agent-profile')).toBe('更新项目 Agent 角色');
    // 不能反过来把项目本身的读写也吞掉
    expect(resolveApiLabel('GET', '/projects/demo-a')).toBe('查询项目');
    expect(resolveApiLabel('PUT', '/projects/demo-a')).toBe('更新项目');
  });

  it('regex 本身不允许跨 / 段 — 模拟 id 含 / 的脏路径', () => {
    // 即使 patterns 数组顺序错位,这种路径也不应被 detail pattern 吞
    // (理论上 router 会把 /branches/foo/bar 路由到 sub-route,但 label 解析
    // 是基于裸路径字符串的,所以严格 [^/]+ 是正确防御)
    const label = resolveApiLabel('GET', '/branches/foo/unknown-sub');
    // 不应该是"查看分支详情"
    expect(label).not.toBe('查看分支详情');
  });
});
