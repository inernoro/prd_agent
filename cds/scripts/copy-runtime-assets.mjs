import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const cdsRoot = fileURLToPath(new URL('../',import.meta.url));
export const runtimeAssets = ['services/preview-demo-snapshot.json','shared/notification-templates.json','services/release-source-preparation.py','services/remote-release-reclaim.py','services/disk-resource-native.py','services/backup-retention-native.py'];
export async function copyRuntimeAssets(outDir=path.join(cdsRoot,'dist')){
 for(const relative of runtimeAssets){const destination=path.join(outDir,relative);await mkdir(path.dirname(destination),{recursive:true});await copyFile(path.join(cdsRoot,'src',relative),destination);}
}
if(process.argv[1]===fileURLToPath(import.meta.url))await copyRuntimeAssets();
