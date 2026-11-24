import { expect, it } from 'vitest';
import { hasBoundedDockerLogs } from '../../src/services/docker-log-policy.js';
it.each(['50m','50000k','50000000','20m'])('accepts Docker decimal max-size %s',size=>{
 expect(hasBoundedDockerLogs({Type:'json-file',Config:{'max-size':size,'max-file':'2'}})).toBe(true);
});
it.each(['51m','52428800','0','-1m','Infinity','50mb'])('rejects unbounded/over-budget size %s',size=>{
 expect(hasBoundedDockerLogs({Type:'json-file',Config:{'max-size':size,'max-file':'3'}})).toBe(false);
});
it('rejects missing/other drivers and unlimited file count',()=>{
 for(const c of [{},{Type:'local',Config:{'max-size':'50m','max-file':'3'}},{Type:'json-file',Config:{'max-size':'50m','max-file':'0'}}]) expect(hasBoundedDockerLogs(c)).toBe(false);
});
