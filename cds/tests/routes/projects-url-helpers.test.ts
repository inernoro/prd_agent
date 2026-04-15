/**
 * Unit tests for the P4 Part 18 (Phase E audit) URL helpers in
 * src/routes/projects.ts.
 *
 * These cover BUG #1 (Device Flow token injection for private
 * repos) and BUG #9 (credential redaction before persisting
 * gitRepoUrl to state.json).
 */

import { describe, it, expect } from 'vitest';
import {
  _redactUrlUserInfo,
  _injectGithubTokenIfPossible,
  _isGithubHttpsUrl,
  _mapGitCloneError,
} from '../../src/routes/projects.js';

describe('_redactUrlUserInfo (BUG #9)', () => {
  it('strips user:password from https URLs', () => {
    expect(_redactUrlUserInfo('https://token:x-oauth-basic@github.com/foo/bar.git'))
      .toBe('https://github.com/foo/bar.git');
  });

  it('strips only username when password is absent', () => {
    expect(_redactUrlUserInfo('https://myuser@github.com/foo/bar.git'))
      .toBe('https://github.com/foo/bar.git');
  });

  it('leaves clean URLs unchanged', () => {
    expect(_redactUrlUserInfo('https://github.com/foo/bar.git'))
      .toBe('https://github.com/foo/bar.git');
  });

  it('leaves SSH shorthand unchanged (no userinfo concept)', () => {
    expect(_redactUrlUserInfo('git@github.com:foo/bar.git'))
      .toBe('git@github.com:foo/bar.git');
  });

  it('leaves unparseable strings unchanged', () => {
    expect(_redactUrlUserInfo('not-a-url')).toBe('not-a-url');
  });

  it('handles empty string', () => {
    expect(_redactUrlUserInfo('')).toBe('');
  });

  it('redacts secrets embedded in a custom port URL', () => {
    expect(_redactUrlUserInfo('https://admin:secret@git.example.com:8443/repo.git'))
      .toBe('https://git.example.com:8443/repo.git');
  });
});

describe('_injectGithubTokenIfPossible (BUG #1)', () => {
  const TOKEN = 'gho_exampletoken1234';

  it('injects x-access-token:{token} into github.com https URL', () => {
    const result = _injectGithubTokenIfPossible('https://github.com/foo/bar.git', TOKEN);
    expect(result).toBe('https://x-access-token:gho_exampletoken1234@github.com/foo/bar.git');
  });

  it('returns the URL unchanged when token is missing', () => {
    expect(_injectGithubTokenIfPossible('https://github.com/foo/bar.git', undefined))
      .toBe('https://github.com/foo/bar.git');
    expect(_injectGithubTokenIfPossible('https://github.com/foo/bar.git', ''))
      .toBe('https://github.com/foo/bar.git');
  });

  it('leaves non-github URLs alone', () => {
    expect(_injectGithubTokenIfPossible('https://gitlab.com/foo/bar.git', TOKEN))
      .toBe('https://gitlab.com/foo/bar.git');
    expect(_injectGithubTokenIfPossible('https://bitbucket.org/foo/bar.git', TOKEN))
      .toBe('https://bitbucket.org/foo/bar.git');
  });

  it('leaves URLs with explicit userinfo alone (respects user override)', () => {
    // If the user deliberately typed credentials, don't clobber them
    const url = 'https://mytoken:x-oauth-basic@github.com/foo/bar.git';
    expect(_injectGithubTokenIfPossible(url, TOKEN)).toBe(url);
  });

  it('leaves SSH URLs alone', () => {
    expect(_injectGithubTokenIfPossible('git@github.com:foo/bar.git', TOKEN))
      .toBe('git@github.com:foo/bar.git');
  });

  it('leaves HTTP URLs (non-https) alone — GitHub doesn\'t serve over http anyway', () => {
    // Edge case: http is rejected to avoid leaking tokens over plaintext
    expect(_injectGithubTokenIfPossible('http://github.com/foo/bar.git', TOKEN))
      .toBe('http://github.com/foo/bar.git');
  });

  it('handles gists.github.com subdomains', () => {
    const result = _injectGithubTokenIfPossible('https://gist.github.com/foo/abc123.git', TOKEN);
    expect(result).toBe('https://x-access-token:gho_exampletoken1234@gist.github.com/foo/abc123.git');
  });

  it('leaves unparseable URLs alone', () => {
    expect(_injectGithubTokenIfPossible('not-a-url', TOKEN)).toBe('not-a-url');
  });
});

// UF-01: preflight + error translation helpers
describe('_isGithubHttpsUrl (UF-01 preflight)', () => {
  it('matches github.com https URLs', () => {
    expect(_isGithubHttpsUrl('https://github.com/foo/bar.git')).toBe(true);
  });

  it('matches github.com subdomains (gist, raw, api)', () => {
    expect(_isGithubHttpsUrl('https://gist.github.com/foo/abc.git')).toBe(true);
    expect(_isGithubHttpsUrl('https://raw.github.com/foo/bar')).toBe(true);
  });

  it('rejects non-github hosts', () => {
    expect(_isGithubHttpsUrl('https://gitlab.com/foo/bar.git')).toBe(false);
    expect(_isGithubHttpsUrl('https://bitbucket.org/foo/bar.git')).toBe(false);
  });

  it('rejects http (non-TLS) even on github.com', () => {
    // We don't want to claim a preflight guarantee over plaintext.
    expect(_isGithubHttpsUrl('http://github.com/foo/bar.git')).toBe(false);
  });

  it('rejects SSH shorthand', () => {
    expect(_isGithubHttpsUrl('git@github.com:foo/bar.git')).toBe(false);
  });

  it('returns false for unparseable strings', () => {
    expect(_isGithubHttpsUrl('not-a-url')).toBe(false);
    expect(_isGithubHttpsUrl('')).toBe(false);
  });
});

describe('_mapGitCloneError (UF-01 error translation)', () => {
  it('translates "could not read Username" for github with no token', () => {
    const raw = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
    const out = _mapGitCloneError(raw, true, false);
    expect(out).toContain('未登录 GitHub');
    expect(out).toContain('Device Flow');
    expect(out).toContain(raw); // original is appended for debugging
  });

  it('translates "Authentication failed" for github with token (suggests scope/token rotate)', () => {
    const raw = 'remote: Invalid username or password.\nfatal: Authentication failed for https://github.com/foo/bar.git/';
    const out = _mapGitCloneError(raw, true, true);
    expect(out).toContain('已登录 GitHub 但仍无法访问');
    expect(out).toContain('scope');
    expect(out).toContain(raw);
  });

  it('translates "Repository not found" as auth failure', () => {
    // Private repos without auth show up as "not found"
    const raw = 'remote: Repository not found.\nfatal: repository not found';
    const out = _mapGitCloneError(raw, true, false);
    expect(out).toContain('未登录 GitHub');
  });

  it('passes through unrelated errors unchanged', () => {
    // E.g. a network error shouldn't be mis-labeled as auth.
    const raw = 'fatal: unable to access: Could not resolve host: github.com';
    expect(_mapGitCloneError(raw, true, false)).toBe(raw);
  });

  it('passes through auth errors when URL is not github (no tailored hint)', () => {
    // Gitlab etc. also emit "could not read Username" but we don't
    // have a Device Flow story for them, so leave it alone.
    const raw = "fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled";
    expect(_mapGitCloneError(raw, false, false)).toBe(raw);
  });

  it('handles empty/undefined input gracefully', () => {
    expect(_mapGitCloneError('', true, false)).toBe('');
  });
});
