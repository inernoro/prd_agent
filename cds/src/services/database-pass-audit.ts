import fs from 'node:fs';
import path from 'node:path';

/** Durable lifecycle records; bounded, aggregated noise from unauthenticated peers. */
export class DatabasePassAudit {
  private tokens=20;
  private refreshed=Date.now();
  private pending=new Map<string,Record<string,any>>();
  static readonly fileLimit=1024*1024;
  constructor(private directory:string){}
  write(record:Record<string,any>){
    const now=Date.now();this.tokens=Math.min(20,this.tokens+(now-this.refreshed)/1000);this.refreshed=now;
    if(['connection-denied','authentication-denied'].includes(record.event)){
      if(this.tokens<1){
        const previous=this.pending.get(record.passId);
        if(previous){previous.count++;previous.lastAt=record.ts;if(previous.sampleIps.length<16&&!previous.sampleIps.includes(record.ip))previous.sampleIps.push(record.ip);}
        else if(this.pending.size<50)this.pending.set(record.passId,{...record,event:'connection-denials-summarized',count:1,firstAt:record.ts,lastAt:record.ts,sampleIps:[record.ip]});
        return;
      }
      this.tokens--;
    }
    this.flush();this.append(record);
  }
  flush(){for(const [id,record] of this.pending){this.append(record);this.pending.delete(id);}}
  private append(record:Record<string,any>){
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
    const file=path.join(this.directory,'audit.jsonl'),line=JSON.stringify(record)+'\n';
    if(Buffer.byteLength(line)>16384)throw new Error('Audit record is too large');
    if(fs.existsSync(file)&&fs.statSync(file).size+Buffer.byteLength(line)+1>DatabasePassAudit.fileLimit){
      fs.rmSync(file+'.2',{force:true});if(fs.existsSync(file+'.1'))fs.renameSync(file+'.1',file+'.2');fs.renameSync(file,file+'.1');
    }
    const fd=fs.openSync(file,'a+',0o600);
    try{
      // Preserve a torn tail verbatim, but delimit it so subsequent records remain readable.
      const size=fs.fstatSync(fd).size,last=Buffer.alloc(1);
      if(size){fs.readSync(fd,last,0,1,size-1);if(last[0]!==10)fs.writeSync(fd,'\n');}
      fs.writeSync(fd,line);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }
  read():Record<string,any>[]{
    return ['audit.jsonl.2','audit.jsonl.1','audit.jsonl'].flatMap(name=>{
      const file=path.join(this.directory,name);if(!fs.existsSync(file))return [];
      const records:Record<string,any>[]=[],lines=fs.readFileSync(file,'utf8').split('\n');let damaged=0;
      for(const line of lines){
        if(!line.trim())continue;
        try{const record=JSON.parse(line);if(!record||typeof record!=='object'||Array.isArray(record))throw new Error('Invalid audit record');records.push(record);}
        catch{damaged++;}
      }
      if(damaged)records.push({event:'audit-record-damaged',passId:'',ts:fs.statSync(file).mtime.toISOString(),count:damaged,auditWarning:true,reason:`${name} 有 ${damaged} 条不完整或损坏记录，原始证据已保留。`});
      return records;
    });
  }
}
