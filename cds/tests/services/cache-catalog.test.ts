/**
 * 依赖缓存挂载目录 SSOT（services/cache-catalog.ts）单元测试。
 *
 * 2026-06-20：固化 Java 项目缓存挂载（任务 3）。病根是原来 image→cacheMounts
 * 推断只覆盖 node/dotnet，Java（eclipse-temurin）拿不到 .m2/.gradle 挂载，
 * 每次起容器重新冷下载整棵依赖树，构建动辄 >10 分钟。本测试断言 catalog
 * 对各栈产出正确的缓存目录，且 hostPath 用 cacheBase 拼前缀、按 containerPath 去重。
 */
import { describe, it, expect } from 'vitest';
import { buildCacheMounts } from '../../src/services/cache-catalog.js';

const BASE = '/cds-cache/myproj';

describe('cache-catalog buildCacheMounts', () => {
  it('Java（eclipse-temurin）镜像挂载 Maven .m2 + Gradle .gradle 两个缓存目录', () => {
    const mounts = buildCacheMounts('eclipse-temurin:21-jdk', BASE);
    const containerPaths = mounts.map((m) => m.containerPath).sort();
    expect(containerPaths).toEqual(['/root/.gradle', '/root/.m2']);
    // hostPath 用 cacheBase 拼前缀
    const m2 = mounts.find((m) => m.containerPath === '/root/.m2');
    expect(m2?.hostPath).toBe(`${BASE}/m2`);
    const gradle = mounts.find((m) => m.containerPath === '/root/.gradle');
    expect(gradle?.hostPath).toBe(`${BASE}/gradle`);
  });

  it('其他 JDK 镜像别名（openjdk）也命中 Java 缓存', () => {
    const mounts = buildCacheMounts('openjdk:21-slim', BASE);
    const containerPaths = mounts.map((m) => m.containerPath).sort();
    expect(containerPaths).toEqual(['/root/.gradle', '/root/.m2']);
  });

  it('Node 镜像挂载 pnpm store', () => {
    const mounts = buildCacheMounts('node:22-slim', BASE);
    expect(mounts).toEqual([{ hostPath: `${BASE}/pnpm`, containerPath: '/pnpm/store' }]);
  });

  it('dotnet 镜像挂载 nuget packages', () => {
    const mounts = buildCacheMounts('mcr.microsoft.com/dotnet/sdk:8.0', BASE);
    expect(mounts).toEqual([{ hostPath: `${BASE}/nuget`, containerPath: '/root/.nuget/packages' }]);
  });

  it('Go 镜像挂载 GOPATH pkg/mod', () => {
    const mounts = buildCacheMounts('golang:1.22-alpine', BASE);
    expect(mounts).toEqual([{ hostPath: `${BASE}/gomod`, containerPath: '/go/pkg/mod' }]);
  });

  it('Rust 镜像挂载 cargo registry', () => {
    const mounts = buildCacheMounts('rust:1.77-slim', BASE);
    expect(mounts).toEqual([{ hostPath: `${BASE}/cargo`, containerPath: '/usr/local/cargo/registry' }]);
  });

  it('Python 镜像挂载 pip cache', () => {
    const mounts = buildCacheMounts('python:3.12-slim', BASE);
    expect(mounts).toEqual([{ hostPath: `${BASE}/pip`, containerPath: '/root/.cache/pip' }]);
  });

  it('未识别镜像（ubuntu）返回空数组', () => {
    expect(buildCacheMounts('ubuntu:24.04', BASE)).toEqual([]);
    expect(buildCacheMounts('', BASE)).toEqual([]);
  });

  it('按 containerPath 去重，不重复挂载同一目录', () => {
    const mounts = buildCacheMounts('maven:3.9-eclipse-temurin-21', BASE);
    const containerPaths = mounts.map((m) => m.containerPath);
    expect(new Set(containerPaths).size).toBe(containerPaths.length);
  });
});
