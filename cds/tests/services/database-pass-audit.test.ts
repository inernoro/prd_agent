import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {it,expect,vi} from 'vitest';
import {DatabasePassAudit} from '../../src/services/database-pass-audit.js';
it('coalesces denied connection floods without unbounded fsync or losing counts',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cds-audit-'));const audit=new DatabasePassAudit(dir);
  const clock=vi.spyOn(Date,'now').mockReturnValue(1_000_000);const sync=vi.spyOn(fs,'fsyncSync');
  try{
    for(let i=0;i<10000;i++)audit.write({ts:'now',passId:'p',event:'connection-denied',ip:`192.0.2.${i%255}`});
    expect(sync.mock.calls.length).toBeLessThanOrEqual(20);audit.flush();
    const records=audit.read();expect(records.length).toBeLessThanOrEqual(21);
    expect(records.reduce((n,r)=>n+(r.count||1),0)).toBe(10000);
    expect(records.at(-1)?.sampleIps.length).toBeLessThanOrEqual(16);
  }finally{clock.mockRestore();sync.mockRestore();fs.rmSync(dir,{recursive:true,force:true});}
});
it('rotates audit history within three bounded files and retains recent lifecycle records',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cds-audit-'));const audit=new DatabasePassAudit(dir);
  try{
    for(let i=0;i<400;i++)audit.write({event:'account-reclaimed',index:i,padding:'x'.repeat(10000)});
    const files=fs.readdirSync(dir);expect(files).toHaveLength(3);
    for(const f of files){expect(fs.statSync(path.join(dir,f)).size).toBeLessThanOrEqual(DatabasePassAudit.fileLimit);expect(fs.statSync(path.join(dir,f)).mode&0o777).toBe(0o600);}
    const records=audit.read();expect(records.at(-1)?.index).toBe(399);expect(records.length).toBeLessThan(400);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
it('preserves a torn tail, reports bounded damage and appends subsequent records on their own line',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cds-audit-torn-')),file=path.join(dir,'audit.jsonl');
  const prefix='{"event":"activated","passId":"one"}\n{"event":"account-rec';fs.writeFileSync(file,prefix,{mode:0o600});
  const audit=new DatabasePassAudit(dir);
  try{
    expect(audit.read()).toEqual([expect.objectContaining({event:'activated'}),expect.objectContaining({event:'audit-record-damaged',count:1})]);
    expect(fs.readFileSync(file,'utf8')).toBe(prefix);
    audit.write({event:'account-reclaimed',passId:'one'});
    expect(fs.readFileSync(file,'utf8').startsWith(prefix+'\n')).toBe(true);
    expect(audit.read()).toEqual([expect.objectContaining({event:'activated'}),expect.objectContaining({event:'account-reclaimed'}),expect.objectContaining({event:'audit-record-damaged',count:1})]);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
