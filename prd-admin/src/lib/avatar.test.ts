import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_AVATAR_FALLBACK,
  LOCAL_NOHEAD_AVATAR,
  isRemoteNoHeadAvatarUrl,
  normalizePublicAssetBaseUrl,
  resolveAvatarUrl,
  resolveNoHeadAvatarUrl,
} from './avatar';
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

describe('默认头像不依赖外部网络（2026-09-14 首页头像备用资源加载失败）', () => {
  afterEach(() => useAuthStore.setState({ cdnBaseUrl: '' }));

  it('服务端下发的对象存储 nohead.png 被换成同源轻量版', () => {
    expect(isRemoteNoHeadAvatarUrl('https://cfi.miduo.org/icon/backups/head/nohead.png')).toBe(true);
    expect(isRemoteNoHeadAvatarUrl('https://cfi.miduo.org/icon/backups/head/NOHEAD.PNG?v=2')).toBe(true);
    expect(isRemoteNoHeadAvatarUrl('https://cfi.miduo.org/icon/backups/head/inernoro.gif')).toBe(false);
    expect(resolveAvatarUrl({ avatarUrl: 'https://cfi.miduo.org/icon/backups/head/nohead.png' })).toBe(LOCAL_NOHEAD_AVATAR);
  });

  it('未设头像的人类用户直接用同源默认头像，不再拼对象存储地址', () => {
    useAuthStore.setState({ cdnBaseUrl: 'https://cfi.miduo.org' });
    expect(resolveAvatarUrl({ username: 'someone', userType: 'Human' })).toBe(LOCAL_NOHEAD_AVATAR);
    expect(resolveAvatarUrl({ avatarFileName: 'nohead.png' })).toBe(LOCAL_NOHEAD_AVATAR);
    expect(resolveNoHeadAvatarUrl()).toBe(LOCAL_NOHEAD_AVATAR);
    // 用户自己上传的头像仍然走对象存储
    expect(resolveAvatarUrl({ avatarFileName: 'inernoro.gif' })).toBe('https://cfi.miduo.org/icon/backups/head/inernoro.gif');
  });

  it('同源默认头像真的随前端打包，且足够小', () => {
    const asset = resolve(__dirname, '../../public/avatars/nohead.webp');
    const bytes = readFileSync(asset);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
    // 原图 3 MB；打包版必须是几 KB 级别，否则又回到「每屏跨域拉一张大图」。
    expect(statSync(asset).size).toBeLessThan(16 * 1024);
    expect(LOCAL_NOHEAD_AVATAR.endsWith('/avatars/nohead.webp')).toBe(true);
  });
});
