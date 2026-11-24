import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isIP } from 'node:net';

const RENEW_BEFORE_MS = 7 * 24 * 60 * 60_000;

/** Rotation only affects new gateways. Already prepared passes retain their own certificate. */
export function databasePassCertificates(directory: string, host: string, now = Date.now()) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = path.join(directory, 'key.pem');
  const certPath = path.join(directory, 'cert.pem');
  const usable = (key: Buffer, cert: Buffer, at = Date.now()) => {
    try {
      const parsed = new X509Certificate(cert);
      return Date.parse(parsed.validFrom) <= at && Date.parse(parsed.validTo) > at + RENEW_BEFORE_MS
        && !!(isIP(host) ? parsed.checkIP(host) : parsed.checkHost(host))
        && parsed.checkPrivateKey(createPrivateKey(key));
    } catch { return false; }
  };
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const key = fs.readFileSync(keyPath), cert = fs.readFileSync(certPath);
    if (usable(key, cert, now)) return { key, cert };
  }
  const next = fs.mkdtempSync(path.join(directory, '.next-'));
  try {
    const key = path.join(next, 'key.pem'), cert = path.join(next, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
      '-subj', '/CN=CDS temporary database gateway', '-addext', `subjectAltName=${isIP(host) ? 'IP' : 'DNS'}:${host}`,
      '-keyout', key, '-out', cert], { stdio: 'ignore' });
    const material = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
    if (!usable(material.key, material.cert)) throw new Error('新网关证书未通过有效期、地址或密钥校验');
    fs.chmodSync(key, 0o600); fs.chmodSync(cert, 0o600);
    fs.renameSync(key, keyPath); fs.renameSync(cert, certPath);
    return material;
  } finally { fs.rmSync(next, { recursive: true, force: true }); }
}
