import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const script = fs.readFileSync(path.resolve(__dirname, '../../exec_cds.sh'), 'utf8');
// Execute the production shell functions, keeping docker/compose effects observable.
const start = script.indexOf('nginx_observe_runtime() {');
const end = script.indexOf('\nnginx_down() {', start);
function run(code: number, output: string, error: string, mode = '', changed = false) {
  expect(start, 'production observer exists').toBeGreaterThan(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-nginx-runtime-'));
  try {
    fs.writeFileSync(path.join(dir,'out'), output);
    fs.writeFileSync(path.join(dir,'err'), error);
    const shell = `NGINX_CONTAINER=cds_nginx
trace() { printf '%s\\n' "$*" >> "$PROBE/trace"; }
render_nginx() { return 0; }
nginx_changed() { return ${changed ? 0 : 1}; }
warn() { :; }
ok() { :; }
docker() {
  case "$1" in
    inspect) cat "$PROBE/out"; cat "$PROBE/err" >&2; return ${code};;
    *) trace "docker $*"; return 0;;
  esac
}
nginx_compose() { trace "compose $*"; }
${script.slice(start, end)}
nginx_up "${mode}"
status=$?
printf '%s|%s|%s\\n' "$status" "$NGINX_RUNTIME_STATE" "$NGINX_RUNTIME_BOUNDED"
`;
    const r = spawnSync('/bin/bash',['-c',shell], {encoding:'utf8', env:{...process.env,PROBE:dir}});
    expect(r.status, r.stderr).toBe(0);
    return {result:r.stdout.trim(), calls:fs.existsSync(path.join(dir,'trace'))?fs.readFileSync(path.join(dir,'trace'),'utf8'):''};
  } finally { fs.rmSync(dir, {recursive:true,force:true}); }
}
const cid='a'.repeat(64);
describe('Nginx runtime logging protection',()=>{
  it.each([124,130,2])('unknown exit %s never creates an ingress',code=>{
    const r=run(code,'','Error: No such object: cds_nginx\n');
    expect(r.result).toBe('1|unknown|false');expect(r.calls).toBe('');
  });
  it.each([
    ['','Error: No such object: other\n'],
    ['[]','Error: No such object: cds_nginx\n'],
    ['','Error: No such object: cds_nginx\npermission denied\n'],
  ])('ambiguous diagnostic stays unknown', (out,err)=>{
    const r=run(1,out,err);expect(r.result).toBe('1|unknown|false');expect(r.calls).toBe('');
  });
  it('exact exit1 empty stdout and exact identity permit first creation',()=>{
    const r=run(1,'','Error: No such object: cds_nginx\n');
    // Reinspection still reports absent in this fixture; no false success.
    expect(r.result).toBe('1|absent|false');expect(r.calls).toBe('compose up -d\n');
  });
  it('unbounded existing ingress is preserved',()=>{
    const r=run(0,cid+'|true|json-file|<no value>|<no value>','');
    expect(r.result).toBe('1|running|false');expect(r.calls).toBe('');
  });
  it('bounded ingress is reused without recreation',()=>{
    const r=run(0,cid+'|true|json-file|20m|2','');
    expect(r.result).toBe('0|running|true');expect(r.calls).toBe('');
  });
  it('stopped bounded ingress starts exact immutable ID',()=>{
    const r=run(0,cid+'|false|json-file|50m|3','');
    expect(r.calls).toBe('docker start '+cid+'\n');
    expect(r.result.startsWith('1|stopped|')).toBe(true);
  });
});

// Explicit certificate maintenance may reuse a proven running legacy ingress until
// cert_cmd reaches its already explicit maintenance handover. It must not start it.
it('certificate maintenance can reuse a proven running legacy ingress without recreation',()=>{
 const r=run(0,cid+'|true|json-file|<no value>|<no value>','','certificate-maintenance',true);
 expect(r.result).toBe('0|running|false');
 expect(r.calls).toBe('docker exec '+cid+' nginx -t\ndocker exec '+cid+' nginx -s reload\n');
 expect(script.slice(script.indexOf('cert_cmd() {'),script.indexOf('# ══ cluster bootstrap'))).toContain('nginx_up certificate-maintenance');
});
it('certificate maintenance cannot start a stopped unbounded ingress',()=>{
 const r=run(0,cid+'|false|json-file|<no value>|<no value>','','certificate-maintenance');
 expect(r.result).toBe('1|stopped|false');expect(r.calls).toBe('');
});
it('certificate maintenance cannot bypass unknown identity',()=>{
 const r=run(124,'','Error: No such object: cds_nginx\n','certificate-maintenance');
 expect(r.result).toBe('1|unknown|false');expect(r.calls).toBe('');
});
