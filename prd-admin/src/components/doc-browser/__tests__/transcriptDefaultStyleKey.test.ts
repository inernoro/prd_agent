/**
 * 默认整理方式的 key 不许在前后端各自漂移。
 *
 * 「生成智能摘要」这颗按钮发起的是后端注册表里的默认那一种；前端手里只有一个字符串常量，
 * 后端改了名字这边不会有任何编译错误——按钮照样能点，只是永远选不中那一种（形状 3）。
 * 所以直接读 C# 源码里的 `DefaultKey` 比对。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { DEFAULT_ORGANIZE_STYLE_KEY } from '@/services/real/documentStore';

describe('默认整理方式 key', () => {
  it('与后端 TranscribeStyleRegistry.DefaultKey 一致', () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../prd-api/src/PrdAgent.Core/Models/TranscribeStyleRegistry.cs'),
      'utf-8',
    );
    const match = source.match(/DefaultKey\s*=\s*"([^"]+)"/);
    expect(match, '后端没读到 DefaultKey 的字面量，可能改了写法').not.toBeNull();
    expect(DEFAULT_ORGANIZE_STYLE_KEY).toBe(match![1]);
  });
});
