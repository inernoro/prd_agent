import { describe, it, expect } from 'vitest';
import { dtsEnvironmentSecrets, dtsManagedServices, dtsConnectionEnvironment, dtsProjectEnvironment } from '../../src/services/dts-connections.js';
import type { StateService } from '../../src/services/state.js';
import type { DtsConnection } from '../../src/shared/dts.js';
const secretUri = 'mongodb://fixture:private-password@127.0.0.1:27017';
const state = { getCustomEnv: () => ({ CUSTOM_URI: secretUri, CDS_MONGO_URL: 'mongodb://unrelated' }),
  getCdsEnvVars: () => ({ CDS_MONGO_URL: secretUri }), getInfraServicesForProject: () => [
    { id:'mongo',projectId:'p',name:'正式数据',dockerImage:'mongo:8.0',containerName:'p-mongo',status:'running' },
    { id:'foreign',projectId:'other',name:'另一个项目',dockerImage:'mongo:8.0',containerName:'other-mongo',status:'running' },
    { id:'web',projectId:'p',name:'应用',dockerImage:'node:20',containerName:'p-web',status:'running' },
  ] } as unknown as StateService;
const connection = { projectId:'p',kind:'mongo',infraId:'mongo',uriEnv:'CDS_MONGO_URL' } as DtsConnection;
describe('DTS uses existing project service connections', () => {
  it('masks decoded URI passwords when native diagnostics separate the credential', () => {
    expect(dtsEnvironmentSecrets({SQL:'mysql://app:private%40password@host/db'})).toContain('private@password');
  });
  it('discovers only project data services and returns references without credentials', () => {
    const resources = dtsManagedServices(state,'p'); expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ id:'mongo',kind:'mongo',uriEnv:'CDS_MONGO_URL',ready:true });
    expect(JSON.stringify(resources)).not.toContain('private-password'); expect(JSON.stringify(resources)).not.toContain('mongodb://');
  });
  it('preserves custom external references while including existing derived service values', () => {
    expect(dtsProjectEnvironment(state,'p').CUSTOM_URI).toBe(secretUri);
  });
  it('pins a managed reference to the platform-derived endpoint despite a custom override', () => {
    expect(dtsConnectionEnvironment(state,connection).CDS_MONGO_URL).toBe(secretUri);
  });
  it('refuses foreign, mismatched-type or redirected managed bindings', () => {
    expect(() => dtsConnectionEnvironment(state,{ ...connection,infraId:'foreign' })).toThrow('发生变化');
    expect(() => dtsConnectionEnvironment(state,{ ...connection,kind:'mysql' })).toThrow('发生变化');
    expect(() => dtsConnectionEnvironment(state,{ ...connection,uriEnv:'CUSTOM_URI' })).toThrow('发生变化');
  });
});
