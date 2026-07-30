import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AVATAR_FALLBACK, normalizePublicAssetBaseUrl, resolveAvatarUrl } from './avatar';
import { useAuthStore } from '@/stores/authStore';

describe('avatar URL validation', () => {
  afterEach(() => useAuthStore.setState({ cdnBaseUrl: '' }));

  it.each(['请填写实际值', 'relative/path', 'javascript:alert(1)'])(
    'rejects invalid public asset base %s',
    (value) => expect(normalizePublicAssetBaseUrl(value)).toBe(''),
  );

  it('uses the inline fallback when persisted configuration still contains a placeholder', () => {
    useAuthStore.setState({ cdnBaseUrl: '请填写实际值' });

    expect(resolveAvatarUrl({
      avatarFileName: 'inernoro.gif',
      avatarUrl: '请填写实际值/icon/backups/head/inernoro.gif',
    })).toBe(DEFAULT_AVATAR_FALLBACK);
  });

  it('preserves valid https avatar URLs', () => {
    expect(resolveAvatarUrl({ avatarUrl: 'https://cdn.example.com/avatar.gif' }))
      .toBe('https://cdn.example.com/avatar.gif');
  });
});
