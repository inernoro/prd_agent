import { describe, expect, it } from 'vitest';
import { buildCacheMounts, retireGeneratedCatalogCaches, mergeRetiredCatalogCaches } from '../../src/services/cache-catalog.js';
const base='/cds-cache/myproj';
describe('compiler cache isolation compatibility',()=>{
  it('all known compiler catalogs create zero host binds',()=>{
    for(const image of ['node:22','dotnet:8','eclipse-temurin:21','golang:1','rust:1','python:3']) expect(buildCacheMounts(image,base)).toEqual([]);
  });
  it('retires exact generated declarations only, preserving original and unknown mappings',()=>{
    const old={hostPath:base+'/pnpm',containerPath:'/root/.local/share/pnpm/store'};
    const user={hostPath:'/my/data',containerPath:'/data'};
    const explicit={kind:'bind' as const,hostPath:base+'/pnpm',containerPath:'/pnpm/store'};
    const ro={hostPath:base+'/pnpm',containerPath:'/pnpm/store',readOnly:true};
    const input=[old,user,explicit,ro];const before=JSON.stringify(input);
    const result=retireGeneratedCatalogCaches('node:22',base,input);
    expect(result.retired).toEqual([old]);expect(result.kept).toEqual([user,explicit,ro]);
    expect(JSON.stringify(input)).toBe(before);
    expect(mergeRetiredCatalogCaches([old],result.retired)).toEqual([old]);
    expect(retireGeneratedCatalogCaches('node:22',base,result.kept).retired).toEqual([]);
  });
  it('does not guess unknown image, foreign base, named volume or explicit readonly ownership',()=>{
    const old={hostPath:base+'/m2',containerPath:'/root/.m2'};
    expect(retireGeneratedCatalogCaches('sha256:'+'a'.repeat(64),base,[old]).retired).toEqual([]);
    expect(retireGeneratedCatalogCaches('maven:3',base+'-other',[old]).retired).toEqual([]);
  });
});
