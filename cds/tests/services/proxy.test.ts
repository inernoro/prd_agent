import { describe, it, expect, beforeEach } from 'vitest';
import { ProxyService } from '../../src/services/proxy.js';
import { StateService } from '../../src/services/state.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

describe('ProxyService', () => {
  let stateFile: string;
  let stateService: StateService;
  let proxy: ProxyService;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-proxy-'));
    stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile);
    stateService.load();
    proxy = new ProxyService(stateService);
  });

  function makeReq(headers: Record<string, string> = {}, url = '/'): http.IncomingMessage {
    return { headers, url } as unknown as http.IncomingMessage;
  }

  describe('resolveBranch', () => {
    it('should resolve from X-Branch header', () => {
      const req = makeReq({ 'x-branch': 'feature/new-ui' });
      expect(proxy.resolveBranch(req)).toBe('feature-new-ui');
    });

    it('should resolve from domain routing rule', () => {
      stateService.addRoutingRule({
        id: 'r1', name: 'Feature', type: 'domain',
        match: '{{feature_*}}.dev.example.com',
        branch: '$1', priority: 0, enabled: true,
      });

      const req = makeReq({ host: 'feature-auth.dev.example.com' });
      expect(proxy.resolveBranch(req)).toBe('feature-auth');
    });

    it('should fall back to default branch', () => {
      stateService.setDefaultBranch('main');
      const req = makeReq({ host: 'anything.com' });
      expect(proxy.resolveBranch(req)).toBe('main');
    });

    it('should resolve from cds_branch cookie', () => {
      const req = makeReq({ cookie: 'cds_branch=claude%2Ffix-worktree-creation-rG5DU' });
      expect(proxy.resolveBranch(req)).toBe('claude-fix-worktree-creation-rg5du');
    });

    it('should prefer X-Branch header over cookie', () => {
      const req = makeReq({
        'x-branch': 'feature/alpha',
        cookie: 'cds_branch=feature%2Fbeta',
      });
      expect(proxy.resolveBranch(req)).toBe('feature-alpha');
    });

    it('should return null when no rules match and no default', () => {
      const req = makeReq({ host: 'anything.com' });
      expect(proxy.resolveBranch(req)).toBeNull();
    });

    it('should skip disabled rules', () => {
      stateService.addRoutingRule({
        id: 'r1', name: 'Disabled', type: 'domain',
        match: '{{*}}.dev.example.com', branch: '$1',
        priority: 0, enabled: false,
      });
      const req = makeReq({ host: 'test.dev.example.com' });
      expect(proxy.resolveBranch(req)).toBeNull();
    });
  });

  describe('patternToRegex', () => {
    it('should convert simple wildcard pattern', () => {
      const regex = proxy.patternToRegex('{{feature_*}}.dev.example.com');
      expect('feature-auth.dev.example.com').toMatch(new RegExp(regex, 'i'));
      expect('somethingelse.dev.example.com').not.toMatch(new RegExp(regex, 'i'));
    });

    it('should convert pattern with multiple wildcards', () => {
      const regex = proxy.patternToRegex('{{*}}-{{*}}.test.com');
      expect('abc-def.test.com').toMatch(new RegExp(regex, 'i'));
    });

    it('should handle exact match (no wildcards)', () => {
      const regex = proxy.patternToRegex('staging.example.com');
      expect('staging.example.com').toMatch(new RegExp(regex, 'i'));
      expect('other.example.com').not.toMatch(new RegExp(regex, 'i'));
    });
  });

  describe('handleRequest — /_switch/', () => {
    function makeRes(): { res: http.ServerResponse; written: { statusCode: number; headers: Record<string, string>; body: string } } {
      const written = { statusCode: 0, headers: {} as Record<string, string>, body: '' };
      const res = {
        writeHead(code: number, headers: Record<string, string>) { written.statusCode = code; written.headers = headers; },
        end(body?: string) { written.body = body || ''; },
      } as unknown as http.ServerResponse;
      return { res, written };
    }

    it('should set cds_branch cookie and redirect on /_switch/<branch>', () => {
      const req = makeReq({}, '/_switch/claude/fix-worktree-creation-rG5DU');
      const { res, written } = makeRes();
      proxy.handleRequest(req, res);
      expect(written.statusCode).toBe(302);
      expect(written.headers['Set-Cookie']).toContain('cds_branch=');
      expect(written.headers['Location']).toBe('/');
    });

    it('should clear cookie on /_clear_branch', () => {
      const req = makeReq({}, '/_clear_branch');
      const { res, written } = makeRes();
      proxy.handleRequest(req, res);
      expect(written.statusCode).toBe(302);
      expect(written.headers['Set-Cookie']).toContain('Max-Age=0');
    });
  });

  describe('matchRule', () => {
    it('should match domain rule and extract capture group', () => {
      const result = proxy.matchRule(
        { id: 'r', name: 'r', type: 'domain', match: '{{agent_*}}.dev.com', branch: '$1', priority: 0, enabled: true },
        'agent-chat.dev.com', '/',
      );
      expect(result).toBe('agent-chat');
    });

    it('should match URL pattern rule', () => {
      const result = proxy.matchRule(
        { id: 'r', name: 'r', type: 'pattern', match: '/preview/{{*}}/', branch: '$1', priority: 0, enabled: true },
        'localhost', '/preview/feature-auth/',
      );
      expect(result).toBe('feature-auth');
    });

    it('should return null for non-matching rule', () => {
      const result = proxy.matchRule(
        { id: 'r', name: 'r', type: 'domain', match: '{{agent_*}}.dev.com', branch: '$1', priority: 0, enabled: true },
        'other.com', '/',
      );
      expect(result).toBeNull();
    });
  });
});
