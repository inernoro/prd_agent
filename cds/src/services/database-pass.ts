import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isIP } from 'node:net';
import net from 'node:net';
import { sealToken, unsealToken, isSealedSecret, isSealingEnabled, type SealedSecret } from '../infra/secret-seal.js';
import { isPreviewInstance } from './preview-instance.js';
import { resourceTcpAccessConfig } from './resource-tcp-access.js';
import { changeDatabasePassAccount, type DatabasePassTarget } from './database-pass-accounts.js';
import { openDatabasePassGateway } from './database-pass-gateway.js';

export interface DatabasePass {
  id: string; projectId: string; branchId: string; resourceId: string; owner: string;
  username: string; database: string; runtime: DatabasePassTarget['runtime']; targetPort: number;
  allowlist: string[]; ttlMinutes: number; status: 'preparing'|'prepared'|'active'|'revoked'|'expired'|'cleanup-failed';
  createdAt: string; expiresAt: string; activatedAt?: string; port?: number;
  secret: SealedSecret; reason?: string;
}

/** Only the authenticated peer, or explicitly trusted local reverse proxy, can supply the default IP. */
export function databasePassClientIp(req: { socket: { remoteAddress?: string }; headers: Record<string,unknown> }): string {
  const peer=(req.socket.remoteAddress || '').replace(/^::ffff:/,'');
  const trusted=peer==='127.0.0.1' || peer==='::1';
  const real=String(req.headers['x-real-ip']||'').replace(/^::ffff:/,'');
  const forwarded=trusted ? (isIP(real)===4&&!real.startsWith('127.')?real:String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim()) : '';
  const ip=forwarded || peer;
  return isIP(ip)===4 ? ip : '';
}

export class DatabasePassService {
  private passes: DatabasePass[]=[];
  private gateways=new Map<string,{close:()=>void}>();
  private operations=new Map<string,Promise<unknown>>();
  private vaultError=false;
  private ready: Promise<void>;
  private readonly file: string;
  constructor(private directory:string, private target:(pass:Pick<DatabasePass,'projectId'|'branchId'|'resourceId'>)=>Promise<DatabasePassTarget>) {
    this.file=path.join(directory,'passes.json');
    if(fs.existsSync(this.file)){
      try{const stored=JSON.parse(fs.readFileSync(this.file,'utf8'));if(!Array.isArray(stored))throw new Error('invalid vault');this.passes=stored;}
      catch{this.vaultError=true;} // Preserve damaged evidence and disable issuance without taking down the control panel.
    }
    // A control-plane restart never silently reopens a previously granted network path.
    this.ready=this.recover();
    if(process.env.NODE_ENV!=='test'){const sweep=setInterval(()=>{void this.ready.then(()=>this.sweep()).catch(()=>{});},5000);sweep.unref();}
  }
  capability() {
    const tcp=resourceTcpAccessConfig();
    const enabled=process.env.CDS_DATABASE_PASS_ENABLED==='1' && tcp.enabled && !isPreviewInstance() && isSealingEnabled() && !this.vaultError;
    return {enabled,host:tcp.host,defaultTtlMinutes:30,mode:'direct' as const,reason:this.vaultError?'通行证记录无法读取，请管理员检查存储；签发已停止。':enabled?'':'本实例尚未启用数据库通行证或凭据加密。'};
  }
  private async withPassLock<T>(id:string,operation:()=>Promise<T>):Promise<T>{
    const previous=this.operations.get(id)||Promise.resolve();
    const pending=previous.catch(()=>{}).then(operation);this.operations.set(id,pending);
    try{return await pending;}finally{if(this.operations.get(id)===pending)this.operations.delete(id);}
  }
  private persist() {
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
    const temporary=this.file+'.tmp';
    const fd=fs.openSync(temporary,'w',0o600);
    try {fs.writeFileSync(fd,JSON.stringify(this.passes));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temporary,this.file);
    const dir=fs.openSync(this.directory,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  }
  private audit(pass:DatabasePass,event:string,details:Record<string,unknown>={}) {
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
    const fd=fs.openSync(path.join(this.directory,'audit.jsonl'),'a',0o600);
    try {fs.writeSync(fd,JSON.stringify({ts:new Date().toISOString(),passId:pass.id,projectId:pass.projectId,branchId:pass.branchId,resourceId:pass.resourceId,owner:pass.owner,username:pass.username,database:pass.database,event,...details})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }
  private async recover(){for(const pass of this.passes)if(!['revoked','expired'].includes(pass.status))await this.revokeInternal(pass,'控制面重启，原通行证不自动续期');}
  private async sweep(){for(const pass of this.passes)if((!['revoked','expired'].includes(pass.status)&&Date.parse(pass.expiresAt)<=Date.now())||pass.status==='cleanup-failed')await this.revokeInternal(pass,'通行证到期');}
  private safe(pass:DatabasePass){const {secret,...publicPass}=pass;return {...publicPass,host:this.capability().host,permission:'read-only',review:'既有资源权限检查通过'};}
  async list(scope:Pick<DatabasePass,'projectId'|'branchId'|'resourceId'>,owner:string){await this.ready;await this.sweep();return this.passes.filter(p=>p.owner===owner&&p.projectId===scope.projectId&&p.branchId===scope.branchId&&p.resourceId===scope.resourceId).map(p=>this.safe(p));}
  private find(id:string,owner:string,scope:Pick<DatabasePass,'projectId'|'branchId'|'resourceId'>){const pass=this.passes.find(p=>p.id===id&&p.owner===owner&&p.projectId===scope.projectId&&p.branchId===scope.branchId&&p.resourceId===scope.resourceId);if(!pass)throw new Error('通行证不存在或不属于当前用户和资源');return pass;}
  async prepare(scope:Pick<DatabasePass,'projectId'|'branchId'|'resourceId'>,owner:string,allowlist:string[],ttlMinutes=30){
    await this.ready;
    if(!this.capability().enabled)throw new Error(this.capability().reason);
    if(!allowlist.length||allowlist.length>20||!Number.isInteger(ttlMinutes)||ttlMinutes<1||ttlMinutes>30)throw new Error('通行证需要明确IP白名单，有效期为1–30分钟');
    for(const rule of allowlist){const [ip,bits,...rest]=rule.split('/');if(isIP(ip)!==4||rest.length||!/^\d+$/.test(bits||'')||Number(bits)<1||Number(bits)>32)throw new Error('白名单须为IPv4/CIDR，不允许向所有IP放行');}
    await this.sweep();
    if(this.passes.filter(p=>!['expired','revoked'].includes(p.status)).length>=50)throw new Error('活动通行证已达上限，请先撤销旧证');
    const target=await this.target(scope),id=randomBytes(10).toString('hex'),password=randomBytes(24).toString('base64url');
    const secret=sealToken(password);if(!isSealedSecret(secret))throw new Error('凭据加密尚未就绪');
    const pass:DatabasePass={...scope,owner,id,username:'cdsp_'+id,database:target.database,runtime:target.runtime,targetPort:target.port,allowlist:[...allowlist],ttlMinutes,status:'preparing',secret,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30*60_000).toISOString()};
    this.passes.push(pass);this.persist();
    return this.withPassLock(id,async()=>{
    try {
      this.audit(pass,'review-approved',{permission:'read-only',allowlist,ttlMinutes});
      await changeDatabasePassAccount(target,{username:pass.username,password},true);
      // Choose the address before copying; activation reuses this exact port or fails closed.
      const reservation=net.createServer();
      await new Promise<void>((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,resourceTcpAccessConfig().bindIp,resolve);});
      pass.port=(reservation.address() as net.AddressInfo).port;
      await new Promise<void>(resolve=>reservation.close(()=>resolve()));
      pass.status='prepared';this.persist();this.audit(pass,'account-prepared');return this.safe(pass);
    } catch {await this.reclaim(pass,'签发失败');throw new Error('签发未完成，入口未放行。请检查数据库账号管理权限、TLS和审计存储后重试。');}
    });
  }
  private certificates(){
    const directory=path.join(this.directory,'tls');fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const key=path.join(directory,'key.pem'),cert=path.join(directory,'cert.pem');
    if(!fs.existsSync(key)||!fs.existsSync(cert)){
      const host=this.capability().host;
      execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','365','-subj','/CN=CDS temporary database gateway','-addext','subjectAltName=IP:'+host,'-keyout',key,'-out',cert],{stdio:'ignore'});
      fs.chmodSync(key,0o600);
    }
    return {key:fs.readFileSync(key),cert:fs.readFileSync(cert)};
  }
  private async boundTarget(pass:DatabasePass){const target=await this.target(pass);if(target.port!==pass.targetPort||target.database!==pass.database||target.runtime!==pass.runtime)throw new Error('数据库资源身份发生变化，原通行证不可继续使用；入口关闭后需核对原库账号回收');return target;}
  async credentials(id:string,owner:string,scope:Pick<DatabasePass,'projectId'|'branchId'|'resourceId'>){
    await this.ready;await this.sweep();const pass=this.find(id,owner,scope);
    if(!['prepared','active'].includes(pass.status))throw new Error('通行证已失效，不能复制凭据');
    const target=await this.boundTarget(pass),ca=pass.runtime==='mysql'?target.mysqlCa:this.certificates().cert.toString();
    if(!ca)throw new Error('TLS证书尚未就绪');
    this.audit(pass,'credentials-copied');
    return {username:pass.username,password:unsealToken(pass.secret),database:pass.database,host:this.capability().host,port:pass.port||null,tlsRequired:true,tlsCa:ca,authSource:pass.runtime==='mongodb'?pass.database:undefined,expiresAt:pass.status==='active'?pass.expiresAt:null};
  }
  async activate(id:string,owner:string,scope:Pick<DatabasePass,'projectId'|'branchId'|'resourceId'>){
    await this.ready;const pass=this.find(id,owner,scope);return this.withPassLock(id,async()=>{
      if(pass.status==='active')return this.safe(pass);
      if(pass.status!=='prepared'||Date.parse(pass.expiresAt)<=Date.now())throw new Error('通行证已失效，请重新申请');
      if(!this.capability().enabled)throw new Error('实例直连配置已关闭');
      const target=await this.boundTarget(pass),tcp=resourceTcpAccessConfig(),certs=this.certificates();
      this.audit(pass,'activation-approved',{allowlist:pass.allowlist,ttlMinutes:pass.ttlMinutes});
      const gateway=await openDatabasePassGateway({target,username:pass.username,bindIp:tcp.bindIp,port:pass.port!,allowlist:pass.allowlist,...certs,audit:(event,details)=>this.audit(pass,event,details)});
      this.gateways.set(id,gateway);pass.port=gateway.port;pass.activatedAt=new Date().toISOString();pass.expiresAt=new Date(Date.now()+pass.ttlMinutes*60_000).toISOString();pass.status='active';
      try{this.persist();this.audit(pass,'activated',{port:pass.port,expiresAt:pass.expiresAt});}
      catch(error){await this.reclaim(pass,'审计或持久化失败');throw error;}
      const timer=setTimeout(()=>{void this.revokeInternal(pass,'通行证到期').catch(()=>{});},Math.max(0,Date.parse(pass.expiresAt)-Date.now()));timer.unref();
      return this.safe(pass);
    });
  }
  private revokeInternal(pass:DatabasePass,reason:string){return this.withPassLock(pass.id,()=>this.reclaim(pass,reason));}
  private async reclaim(pass:DatabasePass,reason:string){
    const gateway=this.gateways.get(pass.id);gateway?.close();this.gateways.delete(pass.id);
    if(['revoked','expired'].includes(pass.status))return;
    pass.status='cleanup-failed';pass.reason=reason;
    // Storage failures must never prevent network closure or best-effort credential revocation.
    try{this.persist();}catch{/* durable preparation record remains available for recovery */}
    try{
      await changeDatabasePassAccount(await this.boundTarget(pass),{username:pass.username,password:''},false);
      pass.status=Date.parse(pass.expiresAt)<=Date.now()?'expired':'revoked';
      this.persist();this.audit(pass,'account-reclaimed',{reason,status:pass.status});
    }catch{try{this.audit(pass,'account-cleanup-failed',{reason});}catch{/* already closed */}}
  }
  async revoke(id:string,owner:string,scope:Pick<DatabasePass,'projectId'|'branchId'|'resourceId'>){await this.ready;const pass=this.find(id,owner,scope);await this.revokeInternal(pass,'用户撤销');return this.safe(pass);}
  async events(scope:Pick<DatabasePass,'projectId'|'branchId'|'resourceId'>,owner:string){await this.ready;const file=path.join(this.directory,'audit.jsonl');if(!fs.existsSync(file))return [];return fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(e=>e.owner===owner&&e.projectId===scope.projectId&&e.branchId===scope.branchId&&e.resourceId===scope.resourceId).slice(-200).reverse();}
}
