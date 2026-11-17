from pathlib import Path
import json, base64
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes, serialization
p=Path(__file__).resolve().parent
k=ec.generate_private_key(ec.SECP256R1()); ts='1794916800'
parts=[]
for name,value in [('from','Spoofed Owner <sender@example.com>'),('to','inbox@example.net'),('subject','fixture 中文'),('text','hello\r\nworld'),('envelope','{"to":["inbox@example.net"],"from":"sender@example.com"}'),('headers','Message-ID: <fixture-001@example.com>\r\nFrom: sender@example.com\r\n')]:
 parts.append(('--fixture-boundary\r\nContent-Disposition: form-data; name="'+name+'"\r\n\r\n'+value+'\r\n').encode())
parts.append(b'--fixture-boundary\r\nContent-Disposition: form-data; name="attachment1"; filename="sample.bin"\r\nContent-Type: application/octet-stream\r\n\r\n\x00\xff\x80binary\r\n--fixture-boundary--\r\n')
body=b''.join(parts)
(p/'multipart.bin').write_bytes(body)
meta={'timestamp':ts,'contentType':'multipart/form-data; boundary=fixture-boundary','signature':base64.b64encode(k.sign(ts.encode()+body,ec.ECDSA(hashes.SHA256()))).decode(),'publicKey':base64.b64encode(k.public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)).decode()}
(p/'multipart.json').write_text(json.dumps(meta,indent=2)+'\n')
