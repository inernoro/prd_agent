import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databasePassCertificates } from '../../src/services/database-pass-certificates.js';

describe('gateway certificate lifetime and continuity',()=>{
  let dir:string;
  beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'cds-pass-cert-'));});
  afterEach(()=>fs.rmSync(dir,{recursive:true,force:true}));
  it('reuses a healthy certificate and private key without rotating client trust',()=>{
    const first=databasePassCertificates(dir,'127.0.0.1');
    expect(databasePassCertificates(dir,'127.0.0.1')).toEqual(first);
    expect(fs.statSync(path.join(dir,'key.pem')).mode&0o777).toBe(0o600);
  });
  it('renews before expiry, preserving old certificate buffers for existing passes',()=>{
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=old',
      '-addext','subjectAltName=IP:127.0.0.1','-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem')],{stdio:'ignore'});
    const old=fs.readFileSync(path.join(dir,'cert.pem'));
    const renewed=databasePassCertificates(dir,'127.0.0.1');
    expect(renewed.cert.equals(old)).toBe(false);
    expect(Date.parse(new X509Certificate(renewed.cert).validTo)-Date.now()).toBeGreaterThan(300*86400_000);
    expect(new X509Certificate(old).subject).toContain('CN=old');
    expect(fs.readdirSync(dir).sort()).toEqual(['cert.pem','key.pem']);
  });
  it('rotates an already expired certificate rather than reusing existing files',()=>{
    databasePassCertificates(dir,'127.0.0.1');
    const key=path.join(dir,'key.pem'),csr=path.join(dir,'request.pem');
    execFileSync('openssl',['req','-new','-key',key,'-subj','/CN=expired','-out',csr],{stdio:'ignore'});
    fs.writeFileSync(path.join(dir,'index'),'');fs.writeFileSync(path.join(dir,'serial'),'01\n');
    const config=path.join(dir,'ca.conf');
    fs.writeFileSync(config,`[ca]\ndefault_ca=issuer\n[issuer]\ndatabase=${dir}/index\nserial=${dir}/serial\nnew_certs_dir=${dir}\ncertificate=${dir}/cert.pem\nprivate_key=${key}\ndefault_md=sha256\npolicy=names\n[names]\ncommonName=supplied\n[server]\nsubjectAltName=IP:127.0.0.1\n`);
    const expired=path.join(dir,'expired.pem');
    execFileSync('openssl',['ca','-batch','-notext','-config',config,'-in',csr,'-startdate','20200101000000Z','-enddate','20200102000000Z','-extensions','server','-out',expired],{stdio:'ignore'});
    fs.copyFileSync(expired,path.join(dir,'cert.pem'));
    expect(Date.parse(new X509Certificate(fs.readFileSync(path.join(dir,'cert.pem'))).validTo)).toBeLessThan(Date.now());
    expect(Date.parse(new X509Certificate(databasePassCertificates(dir,'127.0.0.1').cert).validTo)).toBeGreaterThan(Date.now()+300*86400_000);
  });
  it('replaces a mismatched private key or certificate for the wrong host',()=>{
    const first=databasePassCertificates(dir,'127.0.0.1');
    const second=databasePassCertificates(dir,'127.0.0.2');
    expect(second.cert.equals(first.cert)).toBe(false);
    expect(new X509Certificate(second.cert).checkIP('127.0.0.2')).toBe('127.0.0.2');
    fs.writeFileSync(path.join(dir,'key.pem'),first.key);
    expect(databasePassCertificates(dir,'127.0.0.2').cert.equals(second.cert)).toBe(false);
  });
  it('replaces damaged material instead of serving an invalid certificate',()=>{
    fs.writeFileSync(path.join(dir,'cert.pem'),'broken');fs.writeFileSync(path.join(dir,'key.pem'),'broken');
    expect(new X509Certificate(databasePassCertificates(dir,'127.0.0.1').cert).checkIP('127.0.0.1')).toBeTruthy();
  });
});
