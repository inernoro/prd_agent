/**
 * Unit tests for the P4 Part 18 (Phase E audit) URL helpers in
 * src/routes/projects.ts.
 *
 * These cover BUG #1 (Device Flow token injection for private
 * repos) and BUG #9 (credential redaction before persisting
 * gitRepoUrl to state.json).
 */

import { describe, it, expect } from 'vitest';
import { _redactUrlUserInfo, _injectGithubTokenIfPossible } from '../../src/routes/projects.js';

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
