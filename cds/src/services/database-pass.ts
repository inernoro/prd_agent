import fs from 'node:fs';
import { DatabasePassAudit } from './database-pass-audit.js';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { sealToken, unsealToken, isSealedSecret, isSealingEnabled, type SealedSecret } from '../infra/secret-seal.js';
import { isPreviewInstance } from './preview-instance.js';
import { resourceTcpAccessConfig } from './resource-tcp-access.js';
import { changeDatabasePassAccount, type DatabasePassTarget } from './database-pass-accounts.js';
import { openDatabasePassGateway } from './database-pass-gateway.js';
import { databasePassCertificates } from './database-pass-certificates.js';

export interface DatabasePass {
  id: string; projectId: string; branchId: string; resourceId: string; owner: string;
  username: string; database: string; runtime: DatabasePassTarget['runtime']; targetPort: number;
  allowlist: string[]; ttlMinutes: number; status: 'preparing'|'prepared'|'active'|'revoked'|'expired'|'cleanup-failed';
  createdAt: string; expiresAt: string; activatedAt?: string; port?: number;
  secret: SealedSecret; cleanupTarget?:SealedSecret; reason?: string; tlsCa?: string;
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
  private gateways=new Map<string,{port:number;activate:()=>void;close:()=>void}>();
  private operations=new Map<string,Promise<unknown>>();
  private vaultError=false;
  private issuanceReservations=0;
  private ready: Promise<void>;
  private readonly file: string;
  private readonly auditLog: DatabasePassAudit;
  constructor(private directory:string, private target:(pass:Pick<DatabasePass,'projectId'|'branchId'|'resourceId'>)=>Promise<DatabasePassTarget>) {
    this.file=path.join(directory,'passes.json');this.auditLog=new DatabasePassAudit(directory);
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
    this.auditLog.write({ts:new Date().toISOString(),passId:pass.id,projectId:pass.projectId,branchId:pass.branchId,resourceId:pass.resourceId,owner:pass.owner,username:pass.username,database:pass.database,event,...details});
  }
  private async recover(){for(const pass of this.passes)if(!['revoked','expired'].includes(pass.status))await this.revokeInternal(pass,'控制面重启，原通行证不自动续期');}
  private async sweep(){this.auditLog.flush();for(const pass of this.passes)if((!['revoked','expired'].includes(pass.status)&&Date.parse(pass.expiresAt)<=Date.now())||pass.status==='cleanup-failed')await this.revokeInternal(pass,'通行证到期');}
  private safe(pass:DatabasePass){const {secret,cleanupTarget,...publicPass}=pass;return {...publicPass,host:this.capability().host,permission:'read-only',review:'既有资源权限检查通过'};}
  async list(scope:Pick<DatabasePass,'projectId'|'branchId'|'resourceId'>,owner:string){await this.ready;await this.sweep();return this.passes.filter(p=>p.owner===owner&&p.projectId===scope.projectId&&p.branchId===scope.branchId&&p.resourceId===scope.resourceId).map(p=>this.safe(p));}
  private find(id:string,owner:string,scope:Pick<DatabasePass,'projectId'|'branchId'|'resourceId'>){const pass=this.passes.find(p=>p.id===id&&p.owner===owner&&p.projectId===scope.projectId&&p.branchId===scope.branchId&&p.resourceId===scope.resourceId);if(!pass)throw new Error('通行证不存在或不属于当前用户和资源');return pass;}
  async prepare(scope:Pick<DatabasePass,'projectId'|'branchId'|'resourceId'>,owner:string,allowlist:string[],ttlMinutes=30){
    await this.ready;
    if(!this.capability().enabled)throw new Error(this.capability().reason);
    if(!allowlist.length||allowlist.length>20||!Number.isInteger(ttlMinutes)||ttlMinutes<1||ttlMinutes>30)throw new Error('通行证需要明确IP白名单，有效期为1–30分钟');
    for(const rule of allowlist){const [ip,bits,...rest]=rule.split('/');if(isIP(ip)!==4||rest.length||!/^\d+$/.test(bits||'')||Number(bits)<1||Number(bits)>32)throw new Error('白名单须为IPv4/CIDR，不允许向所有IP放行');}
    await this.sweep();
    if(this.passes.filter(p=>!['expired','revoked'].includes(p.status)).length+this.issuanceReservations>=50)throw new Error('通行证申请与活动数量已达上限，请等待申请完成或先撤销旧证');
    // Reserve synchronously before asynchronous discovery; concurrent callers share the cap.
    this.issuanceReservations++;let target:DatabasePassTarget;
    try{target=await this.target(scope);}finally{this.issuanceReservations--;}
    const id=randomBytes(10).toString('hex'),password=randomBytes(24).toString('base64url');
    const secret=sealToken(password),cleanupTarget=sealToken(JSON.stringify(target));if(!isSealedSecret(secret)||!isSealedSecret(cleanupTarget))throw new Error('凭据加密尚未就绪');
    const pass:DatabasePass={...scope,owner,id,username:'cdsp_'+id,database:target.database,runtime:target.runtime,targetPort:target.port,allowlist:[...allowlist],ttlMinutes,status:'preparing',secret,cleanupTarget,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30*60_000).toISOString()};
    this.passes.push(pass);this.persist();
    return this.withPassLock(id,async()=>{
    try {
      this.audit(pass,'review-approved',{permission:'read-only',allowlist,ttlMinutes});
      await changeDatabasePassAccount(target,{username:pass.username,password},true);
      // Keep the actual listener owned until activation; inactive gateways never proxy to the database.
      const certs=this.certificates();
      const gateway=await openDatabasePassGateway({target,username:pass.username,bindIp:resourceTcpAccessConfig().bindIp,port:0,allowlist:pass.allowlist,...certs,startInactive:true,audit:(event,details)=>this.audit(pass,event,details)});
      this.gateways.set(id,gateway);pass.port=gateway.port;
      pass.tlsCa=certs.cert.toString();
      pass.status='prepared';this.persist();this.audit(pass,'account-prepared');return this.safe(pass);
    } catch {await this.reclaim(pass,'签发失败');throw new Error('签发未完成，入口未放行。请检查数据库账号管理权限、TLS和审计存储后重试。');}
    });
  }
  private certificates(){return databasePassCertificates(path.join(this.directory,'tls'),this.capability().host);}
  private async boundTarget(pass:DatabasePass){const target=await this.target(pass);if(target.port!==pass.targetPort||target.database!==pass.database||target.runtime!==pass.runtime)throw new Error('数据库资源身份发生变化，原通行证不可继续使用；入口关闭后需核对原库账号回收');return target;}
  async credentials(id:string,owner:string,scope:Pick<DatabasePass,'projectId'|'branchId'|'resourceId'>){
    await this.ready;await this.sweep();const pass=this.find(id,owner,scope);
    if(!['prepared','active'].includes(pass.status))throw new Error('通行证已失效，不能复制凭据');
    await this.boundTarget(pass);const ca=pass.tlsCa;
    if(!ca)throw new Error('TLS证书尚未就绪');
    this.audit(pass,'credentials-copied');
    return {username:pass.username,password:unsealToken(pass.secret),database:pass.database,host:this.capability().host,port:pass.port||null,tlsRequired:true,tlsCa:ca,authSource:pass.runtime==='mongodb'?pass.database:undefined,expiresAt:pass.status==='active'?pass.expiresAt:null};
  }
  async activate(id:string,owner:string,scope:Pick<DatabasePass,'projectId'|'branchId'|'resourceId'>){
    await this.ready;const pass=this.find(id,owner,scope);return this.withPassLock(id,async()=>{
      if(pass.status==='active')return this.safe(pass);
      if(pass.status!=='prepared'||Date.parse(pass.expiresAt)<=Date.now())throw new Error('通行证已失效，请重新申请');
      if(!this.capability().enabled)throw new Error('实例直连配置已关闭');
      await this.boundTarget(pass);
      const gateway=this.gateways.get(id);
      if(!gateway)throw new Error('预留入口已失效，请撤销后重新申请');
      this.audit(pass,'activation-approved',{allowlist:pass.allowlist,ttlMinutes:pass.ttlMinutes});
      const activatedAt=Date.now();
      pass.port=gateway.port;pass.activatedAt=new Date(activatedAt).toISOString();pass.expiresAt=new Date(activatedAt+pass.ttlMinutes*60_000).toISOString();pass.status='active';
      try{this.persist();this.audit(pass,'activated',{port:pass.port,expiresAt:pass.expiresAt});gateway.activate();}
      catch(error){await this.reclaim(pass,'审计或持久化失败');throw error;}
      const timer=setTimeout(()=>{void this.revokeInternal(pass,'通行证到期').catch(()=>{});},Math.max(0,Date.parse(pass.expiresAt)-Date.now()));timer.unref();
      return this.safe(pass);
    });
  }
  private async reclaimTargets(pass:DatabasePass){
    const targets:DatabasePassTarget[]=[];let failed=false;
    // Current scoped credentials may have rotated. A port change must not prevent cleanup.
    try{const current=await this.target(pass);if(current.runtime===pass.runtime&&current.database===pass.database)targets.push(current);}catch{/* original snapshot remains usable after branch deletion */}
    if(pass.cleanupTarget){
      try{
        const original=JSON.parse(unsealToken(pass.cleanupTarget)) as DatabasePassTarget;
        if(original.runtime!==pass.runtime||original.database!==pass.database||original.port!==pass.targetPort||!original.adminUser||typeof original.adminPassword!=='string')throw new Error('原目标回收记录不匹配');
        targets.push(original);
      }catch{failed=true;} // Still revoke the known current endpoint; do not discard damaged original evidence.
    }
    if(!targets.length)throw new Error('缺少可验证的账号回收目标');
    const endpoints=new Map<string,DatabasePassTarget[]>();
    for(const target of targets){const key=`${target.runtime}:${target.port}:${target.database}`;endpoints.set(key,[...(endpoints.get(key)||[]),target]);}
    for(const alternatives of endpoints.values()){
      let reclaimed=false;
      for(const target of alternatives){try{await changeDatabasePassAccount(target,{username:pass.username,password:''},false);reclaimed=true;break;}catch{/* try the other known credential for this same endpoint */}}
      if(!reclaimed)failed=true;
    }
    // Never claim all accounts gone when an old endpoint is unreachable; retry its encrypted snapshot.
    if(failed)throw new Error('部分原目标尚未确认回收');
  }
  private revokeInternal(pass:DatabasePass,reason:string){return this.withPassLock(pass.id,()=>this.reclaim(pass,reason));}
  private async reclaim(pass:DatabasePass,reason:string){
    const gateway=this.gateways.get(pass.id);gateway?.close();this.gateways.delete(pass.id);
    if(['revoked','expired'].includes(pass.status))return;
    pass.status='cleanup-failed';pass.reason=reason;
    // Storage failures must never prevent network closure or best-effort credential revocation.
    try{this.persist();}catch{/* durable preparation record remains available for recovery */}
    try{
      await this.reclaimTargets(pass);
      pass.status=Date.parse(pass.expiresAt)<=Date.now()?'expired':'revoked';
      this.persist();this.audit(pass,'account-reclaimed',{reason,status:pass.status});
    }catch{try{this.audit(pass,'account-cleanup-failed',{reason});}catch{/* already closed */}}
  }
  async revoke(id:string,owner:string,scope:Pick<DatabasePass,'projectId'|'branchId'|'resourceId'>){await this.ready;const pass=this.find(id,owner,scope);await this.revokeInternal(pass,'用户撤销');return this.safe(pass);}
  async events(scope:Pick<DatabasePass,'projectId'|'branchId'|'resourceId'>,owner:string){await this.ready;this.auditLog.flush();return this.auditLog.read().filter(e=>e.auditWarning===true||(e.owner===owner&&e.projectId===scope.projectId&&e.branchId===scope.branchId&&e.resourceId===scope.resourceId)).slice(-200).reverse();}
}
