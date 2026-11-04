import {describe,it,expect} from 'vitest';
import {buildCacheMounts,catalogFreshCacheRequests} from '../../src/services/cache-catalog.js';
describe('catalog compiler cache isolation',()=>{
 it.each(['eclipse-temurin:21-jdk','openjdk:21-slim','node:22-slim','mcr.microsoft.com/dotnet/sdk:8.0','golang:1.22-alpine','rust:1.77-slim','python:3.12-slim','ubuntu:24.04',''])('does not manufacture a host bind for %s',image=>{expect(buildCacheMounts(image,'/private/cache')).toEqual([])});
 it.each([
  ['eclipse-temurin:21-jdk',['/root/.m2','/root/.gradle']],['openjdk:21-slim',['/root/.m2','/root/.gradle']],['node:22-slim',['/pnpm/store']],['mcr.microsoft.com/dotnet/sdk:8.0',['/root/.nuget/packages']],['golang:1.22-alpine',['/go/pkg/mod']],['rust:1.77-slim',['/usr/local/cargo/registry']],['python:3.12-slim',['/root/.cache/pip']],['ubuntu:24.04',[]],['',[]],
 ])('exports explicit fresh cache requests for %s', (image,targets)=>{
  const requests=catalogFreshCacheRequests(image as string);expect(requests.map(x=>x.containerPath)).toEqual(targets);expect(requests.every(x=>x.purpose==='cache'&&!('hostPath'in x))).toBe(true);
 });
 it('deduplicates aliases before explicit allocation',()=>{const requests=catalogFreshCacheRequests('maven:3.9-eclipse-temurin-21');expect(requests).toHaveLength(2);expect(new Set(requests.map(x=>x.containerPath)).size).toBe(2)});
});
