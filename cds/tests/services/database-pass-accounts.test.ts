import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({connect:vi.fn(),query:vi.fn(),end:vi.fn()}));
vi.mock('mysql2/promise',()=>({default:{createConnection:mocks.connect}}));
import { changeDatabasePassAccount } from '../../src/services/database-pass-accounts.js';
beforeEach(()=>{vi.stubEnv('CDS_PREVIEW_INSTANCE','0');mocks.query.mockReset().mockResolvedValue([[]]);mocks.end.mockReset().mockResolvedValue(undefined);mocks.connect.mockReset().mockResolvedValue({query:mocks.query,end:mocks.end});});
afterEach(()=>vi.unstubAllEnvs());
it('verifies the configured MySQL CA without requiring its server certificate to name loopback',async()=>{
  await changeDatabasePassAccount({runtime:'mysql',port:3306,database:'qa',adminUser:'root',adminPassword:'private',mysqlCa:'configured CA'}, {username:'cdsp_0123456789abcdef0123',password:'temporary'},true);
  expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({host:'127.0.0.1',ssl:{ca:'configured CA',rejectUnauthorized:true,verifyIdentity:false}}));
});
it('fails closed on CA verification failure before issuing or granting an account',async()=>{
  mocks.connect.mockRejectedValue(new Error('certificate verify failed'));
  await expect(changeDatabasePassAccount({runtime:'mysql',port:3306,database:'qa',adminUser:'root',adminPassword:'private',mysqlCa:'wrong CA'}, {username:'cdsp_0123456789abcdef0123',password:'temporary'},true)).rejects.toThrow('certificate verify failed');
  expect(mocks.query).not.toHaveBeenCalled();
});
