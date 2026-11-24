// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

  it('旧源元数据晚到后，同src的占位头像恢复真实旧图，失败后不循环请求同一候选', async () => {
    const current = 'https://current.example';
    const legacy = 'https://legacy.example';
    useAuthStore.setState({ cdnBaseUrl: current, legacyCdnBaseUrl: '' });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UserAvatar src={`${current}/icon/backups/head/user.jpg`} />));
      const img = container.querySelector('img')!;
      await act(async () => img.dispatchEvent(new Event('error')));
      expect(img.src).toBe(DEFAULT_AVATAR_FALLBACK);

      // 与已有持久登录页面的异步 /authz/me 到达一致，不重新挂载或修改src。
      await act(async () => useAuthStore.getState().setCdnBaseUrl(current, legacy));
      expect(container.querySelector('img')).toBe(img);
      expect(img.src).toBe(`${legacy}/icon/backups/head/user.jpg`);
      await act(async () => img.dispatchEvent(new Event('error')));
      expect(img.src).toBe(DEFAULT_AVATAR_FALLBACK);

      const setSrc = vi.spyOn(img, 'src', 'set');
      try {
        await act(async () => useAuthStore.setState({ legacyCdnBaseUrl: `${legacy}/` }));
        expect(img.src).toBe(DEFAULT_AVATAR_FALLBACK);
        expect(setSrc).not.toHaveBeenCalled();
      } finally { setSrc.mockRestore(); }
    } finally { await act(async () => root.unmount()); }
  });

  it('已经显示当前R2头像时，旧源或无关鉴权更新不重新设置src', async () => {
    const src = 'https://current.example/icon/backups/head/user.jpg';
    useAuthStore.setState({ cdnBaseUrl: 'https://current.example', legacyCdnBaseUrl: '' });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UserAvatar src={src} />));
      const img = container.querySelector('img')!;
      await act(async () => img.dispatchEvent(new Event('load')));
      const setSrc = vi.spyOn(img, 'src', 'set');
      try {
        await act(async () => useAuthStore.setState({ legacyCdnBaseUrl: 'https://legacy.example' }));
        await act(async () => useAuthStore.setState({ legacyCdnBaseUrl: 'https://new-legacy.example', permFingerprint: 'updated' }));
        expect(container.querySelector('img')).toBe(img);
        expect(img.src).toBe(src);
        expect(setSrc).not.toHaveBeenCalled();
      } finally { setSrc.mockRestore(); }
    } finally { await act(async () => root.unmount()); }
  });

  it('已失败的旧源替换为新候选时可恢复，每个未变化候选只尝试一次', async () => {
    useAuthStore.setState({ cdnBaseUrl: 'https://current.example', legacyCdnBaseUrl: 'https://legacy.example' });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UserAvatar src="https://current.example/icon/backups/head/user.jpg" />));
      const img = container.querySelector('img')!;
      await act(async () => img.dispatchEvent(new Event('error')));
      await act(async () => img.dispatchEvent(new Event('error')));
      expect(img.src).toBe(DEFAULT_AVATAR_FALLBACK);
      await act(async () => useAuthStore.setState({ legacyCdnBaseUrl: 'https://new-legacy.example' }));
      expect(img.src).toBe('https://new-legacy.example/icon/backups/head/user.jpg');
      await act(async () => img.dispatchEvent(new Event('error')));
      expect(img.src).toBe(DEFAULT_AVATAR_FALLBACK);
    } finally { await act(async () => root.unmount()); }
  });

  it.each([
    'https://outside.example/icon/backups/head/user.jpg',
    'https://current.example/icon/backups/head/nohead.png',
  ])('旧源晚到也不接管外部或默认头像：%s', async (src) => {
    useAuthStore.setState({ cdnBaseUrl: 'https://current.example', legacyCdnBaseUrl: '' });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UserAvatar src={src} />));
      const img = container.querySelector('img')!;
      await act(async () => img.dispatchEvent(new Event('error')));
      await act(async () => useAuthStore.setState({ legacyCdnBaseUrl: 'https://legacy.example' }));
      expect(img.src).toBe(DEFAULT_AVATAR_FALLBACK);
      expect(img.getAttribute('data-legacy-applied')).toBeNull();
    } finally { await act(async () => root.unmount()); }
  });
});
