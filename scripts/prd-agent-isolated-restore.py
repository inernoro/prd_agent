#!/usr/bin/env python3
"""Restore a completed off-host backup to a fresh loopback-only local Mongo process."""
import argparse,hashlib,json,os,re,resource,signal,socket,subprocess,time
from pathlib import Path

def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(4*1024*1024),b''):h.update(b)
 return h.hexdigest()

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--backup',required=True);p.add_argument('--work',required=True);a=p.parse_args()
 # launchd defaults to only 256 descriptors; a real schema opens many index files.
 soft,hard=resource.getrlimit(resource.RLIMIT_NOFILE)
 if soft!=resource.RLIM_INFINITY and soft<65536:
  target=65536 if hard==resource.RLIM_INFINITY else min(hard,65536)
  if target<8192:raise RuntimeError('Isolated Mongo restore requires at least 8192 file descriptors')
  resource.setrlimit(resource.RLIMIT_NOFILE,(target,hard))
 backup=Path(a.backup).resolve(strict=True);manifest=json.loads((backup/'manifest.json').read_text())
 schemas=json.loads((backup/'indexes.json').read_text()) if (backup/'indexes.json').exists() else None
 if not schemas:raise RuntimeError('Source index snapshot is required')
 if schemas and manifest.get('indexSnapshotSha256')!=digest(backup/'indexes.json'):raise RuntimeError('Index snapshot checksum mismatch')
 if manifest['status']!='completed' or manifest['exclusions']:raise RuntimeError('Complete non-excluded backup required')
 if set(manifest.get('scope',[]))!={'prdagent','llm_gateway','admin'} or len(manifest['archives'])!=3 or {x['database'] for x in manifest['archives']}!=set(manifest['scope']):raise RuntimeError('All three unique database archives are required')
 work=Path(a.work).resolve()
 if work.exists():raise RuntimeError('Restore work directory must be new')
 work.mkdir(parents=True,mode=0o700);work.chmod(0o700);data=work/'data';data.mkdir(mode=0o700)
 for row in manifest['archives']:
  path=backup/row['file']
  if path.parent!=backup or digest(path)!=row['sha256']:raise RuntimeError('Archive checksum mismatch')
 sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
 if port==27017:raise RuntimeError('Refusing default MongoDB port')
 log=(work/'process.log').open('wb')
 mongo=subprocess.Popen(['mongod','--dbpath',str(data),'--bind_ip','127.0.0.1','--port',str(port),'--nounixsocket','--wiredTigerCacheSizeGB','0.5','--setParameter','ttlMonitorEnabled=false'],stdout=log,stderr=log)
 result={'sourceBackup':str(backup),'productionContacted':False,'bind':'127.0.0.1','port':port,'pid':mongo.pid,'restored':[],'status':'running'}
 def query(js):
  return subprocess.check_output(['mongosh','--quiet','--host','127.0.0.1','--port',str(port),'--eval',js],text=True,timeout=120).strip()
 try:
  deadline=time.monotonic()+60
  while time.monotonic()<deadline:
   if mongo.poll() is not None:raise RuntimeError('Isolated Mongo exited during startup')
   try:
    with socket.create_connection(('127.0.0.1',port),timeout=1):break
   except OSError:time.sleep(0.5)
  if query('print(db.adminCommand({ping:1}).ok)')!='1':raise RuntimeError('Restore target not ready')
  for row in manifest['archives']:
   name=row['database'];output=work/(name+'.restore.log')
   with output.open('wb') as stream:
    subprocess.run(['mongorestore','--host','127.0.0.1','--port',str(port),'--gzip','--archive='+str(backup/row['file']),'--numParallelCollections=1','--numInsertionWorkersPerCollection=1','--objcheck','--stopOnError'],stdout=stream,stderr=stream,check=True,timeout=6*3600)
   expected={m.group(1):int(m.group(2)) for m in re.finditer(r'done dumping '+re.escape(name)+r'\.(\S+) \((\d+) documents?\)',(backup/(name+'.dump.log')).read_text())}
   actual=json.loads(query('const d=db.getSiblingDB('+json.dumps(name)+');print(EJSON.stringify(d.getCollectionInfos().filter(c=>c.type==="collection").map(c=>({name:c.name,count:d.getCollection(c.name).countDocuments({}),indexes:d.getCollection(c.name).getIndexes()}))))'))
   mismatches=[{'collection':x['name'],'dump':expected[x['name']],'restored':x['count']} for x in actual if x['name'] in expected and expected[x['name']]!=x['count']]
   missing=[n for n in expected if n not in {x['name'] for x in actual} and (not n.startswith('system.') or expected[n]>0)]
   if mismatches or missing:raise RuntimeError('Restored document counts differ from dump stream')
   if not expected:raise RuntimeError('No dump counts; refusing unverifiable success')
   index_mismatches=[]
   def normalize(value):
    if isinstance(value,dict):
     if len(value)==1 and next(iter(value)) in ('$numberInt','$numberLong'):return int(next(iter(value.values())))
     if len(value)==1 and next(iter(value))=='$numberDouble':return float(next(iter(value.values())))
     return {k:normalize(v) for k,v in value.items()}
    if isinstance(value,list):return [normalize(v) for v in value]
    return value
   def normalize_index(index):
    return {k:([(field,normalize(order)) for field,order in v.items()] if k=='key' else normalize(v)) for k,v in index.items() if k not in ('v','ns','background')}
   if schemas:
    by_name={x['name']:x for x in actual}
    for collection in schemas.get(name,[]):
     if collection['name'] not in expected or collection['name'].startswith('system.'):continue
     restored=by_name.get(collection['name'],{})
     source_indexes={i['name']:normalize_index(i) for i in collection['indexes']}
     target_indexes={i['name']:normalize_index(i) for i in restored.get('indexes',[])}
     if source_indexes!=target_indexes:index_mismatches.append(collection['name'])
    if index_mismatches:raise RuntimeError('Restored index definitions differ from source snapshot')
   result['restored'].append({'database':name,'collections':actual,'dumpCollections':len(expected),'countMismatches':mismatches,'missing':missing,'indexSnapshotCompared':schemas is not None,'indexMismatches':index_mismatches})
   (work/'result.json').write_text(json.dumps(result,indent=2)+'\n')
  result['representativeReads']=json.loads(query('const out={};for(const [name,collections] of Object.entries({prdagent:["users","workflows","documents"],llm_gateway:["llmgw_logical_models","llmgw_route_rules"]})){const d=db.getSiblingDB(name);for(const c of collections){const row=d.getCollection(c).findOne({});out[name+"."+c]={readable:true,hasRecord:row!==null};}}print(JSON.stringify(out))'))
  result['status']='passed'
 except Exception as e:result['status']='failed';result['errorType']=type(e).__name__;raise
 finally:
  mongo.terminate()
  try:mongo.wait(timeout=60)
  except subprocess.TimeoutExpired:mongo.kill();mongo.wait()
  log.close();result['isolatedProcessStopped']=True
  path=work/'result.json';path.write_text(json.dumps(result,indent=2)+'\n');path.chmod(0o600)
 print('Actual isolated restore and document counts: PASS')
if __name__=='__main__':main()
