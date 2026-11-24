/** Native engines may log a credential separately from its URI. Mask before any container log is emitted. */
const secrets=new Set();
export function captureNativeSecrets(value,key=''){
 if(typeof value==='string'){
  if(/password|token|secret|authorization/i.test(key)&&value)secrets.add(value);
  try{const u=new URL(value);if(u.password){secrets.add(u.password);secrets.add(decodeURIComponent(u.password));}}catch{}
 }else if(Array.isArray(value)){for(const v of value)captureNativeSecrets(v,key);}
 else if(value&&typeof value==='object')for(const [k,v]of Object.entries(value))captureNativeSecrets(v,k);
 if(secrets.size>10000)throw new Error('Native credential mask budget exceeded');
}
export function redactNative(text){for(const secret of [...secrets].sort((a,b)=>b.length-a.length))text=text.split(secret).join('[REDACTED]');return text;}
export function forwardNativeLog(input,output){
 let pending='',discard=false;
 input.setEncoding('utf8');input.on('data',chunk=>{
  for(const piece of chunk.match(/[^\n]*\n|[^\n]+$/g)||[]){
   const ends=piece.endsWith('\n');if(!discard){pending+=piece;if(pending.length>65536){pending='';discard=true;}else if(ends){output.write(redactNative(pending));pending='';}}
   if(discard&&ends){output.write('[native log line exceeded private display budget]\n');discard=false;}
  }
 });input.once('end',()=>{if(pending&&!discard)output.write(redactNative(pending));});
}
