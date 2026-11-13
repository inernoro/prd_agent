// Manual isolated experiment: real MySQL files, no native container bind to the
// source snapshot, and the same source retention code as the current build.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {reclaimDeploymentSources} from '../dist/services/deployment-source-retention.js';
import {defaultOrphanWorktreeFs} from '../dist/services/janitor.js';
const [base, source]=process.argv.slice(2);
const file=path.join(source,'.cds-data/mysql/ibdata1');
const digest=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const before=await digest(file);
const input={base,projectIds:['mysql-proof'],branches:()=>[],files:defaultOrphanWorktreeFs,nowMs:Date.now()+3*3600000};
const first=await reclaimDeploymentSources(input);
assert.equal(first.removed.length,0);assert.equal(first.held[source],'persistent-data');
await fs.rename(path.join(source,'.cds-data'),path.join(source,'unclassified-database'));
const second=await reclaimDeploymentSources({...input,nowMs:Date.now()+3*3600000});
assert.equal(second.removed.length,0);assert.equal(second.held[source],'modified-or-unknown-files');
assert.equal(await digest(path.join(source,'unclassified-database/mysql/ibdata1')),before);
console.log(JSON.stringify({nativeDatabaseBytesPreserved:true,unmountedSourceHeld:true,renamedUnknownDataHeld:true,holds:[first.held[source],second.held[source]],removed:0}));
