import importlib.util,json,tempfile,time,unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('r',Path(__file__).parents[1]/'prd-agent-verified-backup-retention.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Retention(unittest.TestCase):
 def test_missing_copy_and_mismatched_copy_never_delete(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'data';p.write_bytes(b'backup');files=[(p,'snap/data')]
   self.assertFalse(m.eligible(files,{},time.time()+1)[0])
   self.assertFalse(m.eligible(files,{'snap/data':{'bytes':6,'mtime':p.stat().st_mtime,'sha256':'wrong'}},time.time()+1)[0])
   receipt={'snap/data':{'bytes':6,'mtime':p.stat().st_mtime,'sha256':m.digest(p)}}
   self.assertTrue(m.eligible(files,receipt,time.time()+1)[0])
   self.assertFalse(m.eligible(files,receipt,time.time()-1)[0])

class Receipt(unittest.TestCase):
 def test_offsite_verifier_refuses_corrupt_copy(self):
  import subprocess,sys
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);mirror=root/'mirror';mirror.mkdir();f=mirror/'config';f.write_bytes(b'data')
   inventory=root/'inventory.json';inventory.write_text(json.dumps([{'path':'config','bytes':4,'mtime':f.stat().st_mtime,'sha256':'wrong'}]))
   output=root/'receipt.json'
   r=subprocess.run([sys.executable,str(Path(__file__).parents[1]/'prd-agent-verify-offsite-backups.py'),'--inventory',str(inventory),'--mirror',str(mirror),'--source-host','production','--receipt',str(output)],capture_output=True)
   self.assertNotEqual(r.returncode,0);self.assertFalse(output.exists())

if __name__=='__main__':unittest.main()
