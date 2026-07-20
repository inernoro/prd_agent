/**
 * actor-resolver 测试 — 2026-05-07 用户反馈"项目活动日志看不出 user 还是
 * 自动部署"。新增 X-CDS-Trigger header 优先级。
 */
import { describe, it, expect } from 'vitest';
import { resolveActorFromRequest } from '../../src/services/actor-resolver.js';

describe('resolveActorFromRequest', () => {
  it('X-CDS-Trigger: webhook → system:webhook', () => {
    expect(resolveActorFromRequest({ headers: { 'x-cds-trigger': 'webhook' } })).toBe('system:webhook');
  });

  it('X-CDS-Trigger: slash-command → system:slash-command', () => {
    expect(resolveActorFromRequest({ headers: { 'x-cds-trigger': 'slash-command' } })).toBe('system:slash-command');
  });

  it('X-CDS-Trigger 大小写不敏感(规范化为 lowercase)', () => {
    expect(resolveActorFromRequest({ headers: { 'x-cds-trigger': 'WEBHOOK' } })).toBe('system:webhook');
  });

  it('X-CDS-Trigger 优先于 X-AI-Access-Key(内部自调时不该被识别为 AI)', () => {
    const r = resolveActorFromRequest({
      headers: { 'x-cds-trigger': 'webhook', 'x-ai-access-key': 'sk-test' },
    });
    expect(r).toBe('system:webhook');
  });

  it('X-AI-Impersonate → ai:<name>', () => {
    expect(resolveActorFromRequest({ headers: { 'x-ai-impersonate': 'alice' } })).toBe('ai:alice');
  });

  it('X-AI-Access-Key → ai', () => {
    expect(resolveActorFromRequest({ headers: { 'x-ai-access-key': 'sk-anon' } })).toBe('ai');
  });

  it('X-CDS-AI-Token → ai(legacy)', () => {
    expect(resolveActorFromRequest({ headers: { 'x-cds-ai-token': 'sk-legacy' } })).toBe('ai');
  });

  it('无任何标识 header → user', () => {
    expect(resolveActorFromRequest({ headers: {} })).toBe('user');
  });

  it('完全无 headers 字段 → user(防御性)', () => {
    expect(resolveActorFromRequest({})).toBe('user');
    expect(resolveActorFromRequest(null)).toBe('user');
    expect(resolveActorFromRequest(undefined)).toBe('user');
  });

  it('header 数组格式(罕见但 Express 允许)正确取首元素', () => {
    expect(resolveActorFromRequest({ headers: { 'x-cds-trigger': ['webhook'] } })).toBe('system:webhook');
    expect(resolveActorFromRequest({ headers: { 'x-ai-impersonate': ['bob'] } })).toBe('ai:bob');
  });

  it('解析 actor 时同时建立声明身份和 operation 响应头', () => {
    const responseHeaders = new Map<string, string>();
    const req = {
      headers: {
        'x-ai-access-key': 'secret',
        'x-cds-agent-session-id': 'cdscli_session_actor',
        'x-codex-thread-id': 'thread-actor',
      },
      cdsRequestId: 'req_actor',
      res: { setHeader: (name: string, value: string) => responseHeaders.set(name, value) },
    };

    expect(resolveActorFromRequest(req)).toBe('ai');
    expect(req).toMatchObject({
      cdsRequestId: 'req_actor',
      cdsOperationId: expect.stringMatching(/^op_/),
      cdsAgentIdentity: {
        identityVersion: 1,
        confidence: 'declared',
        agentSessionId: 'cdscli_session_actor',
        threadId: 'thread-actor',
      },
    });
    expect(responseHeaders.get('X-CDS-Operation-Id')).toBe(req.cdsOperationId);
  });
});
