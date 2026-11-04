// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_AVATAR_FALLBACK, resolveLegacyAvatarUrl } from '@/lib/avatar';
import { useAuthStore } from '@/stores/authStore';
import { UserAvatar } from './UserAvatar';

describe('迁移期间的真实历史头像读取', () => {
  beforeAll(() => { Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true); });
  afterAll(() => { Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); });
  afterEach(() => useAuthStore.setState({ cdnBaseUrl: '', legacyCdnBaseUrl: '' }));

  it('当前头像优先，加载失败才读取受信旧源，真实图片失败后才兜底', async () => {
    useAuthStore.setState({ cdnBaseUrl: 'https://current.example', legacyCdnBaseUrl: 'https://legacy.example' });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<UserAvatar src="https://current.example/icon/backups/head/user.jpg" />));
    const img = container.querySelector('img')!;
    expect(img.src).toBe('https://current.example/icon/backups/head/user.jpg');
    await act(async () => img.dispatchEvent(new Event('error')));
    expect(img.src).toBe('https://legacy.example/icon/backups/head/user.jpg');
    await act(async () => img.dispatchEvent(new Event('error')));
    expect(img.src).toBe(DEFAULT_AVATAR_FALLBACK);
    await act(async () => root.render(<UserAvatar src="https://current.example/icon/backups/head/new.jpg" />));
    const changed = container.querySelector('img')!;
    expect(changed.getAttribute('data-legacy-applied')).toBeNull();
    await act(async () => changed.dispatchEvent(new Event('error')));
    expect(changed.src).toBe('https://legacy.example/icon/backups/head/new.jpg');
    await act(async () => root.unmount());
  });

  it('不改写外部头像、默认头像、目录穿越或非HTTPS旧源', () => {
    useAuthStore.setState({ cdnBaseUrl: 'https://current.example', legacyCdnBaseUrl: 'https://legacy.example' });
    expect(resolveLegacyAvatarUrl('https://outside.example/icon/backups/head/user.jpg')).toBeNull();
    expect(resolveLegacyAvatarUrl('https://current.example/icon/backups/head/nohead.png')).toBeNull();
    expect(resolveLegacyAvatarUrl('https://current.example/icon/backups/head/sub/user.jpg')).toBeNull();
    useAuthStore.setState({ legacyCdnBaseUrl: 'http://legacy.example' });
    expect(resolveLegacyAvatarUrl('https://current.example/icon/backups/head/user.jpg')).toBeNull();
  });
});
