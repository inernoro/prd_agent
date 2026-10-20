import {expect,it} from 'vitest';
import {normalizeRestrictedIpv4Allowlist as normalize} from '../../src/services/restricted-ipv4-allowlist.js';
it.each([
 ['0.0.0.0/1','128.0.0.0/1'],
 ['0.0.0.0/2','64.0.0.0/2','128.0.0.0/2','192.0.0.0/2'],
 ['1.2.3.4/1','255.255.255.255/1'],
 ['0.0.0.0/1','0.0.0.0/2','128.0.0.0/1','128.0.0.0/2'],
])('rejects a complete IPv4 union: %s',(...rules)=>{expect(()=>normalize(rules)).toThrow(/覆盖全部/);});
it('canonicalizes host bits and duplicate networks without expanding a gapped allowlist',()=>{
 expect(normalize(['192.168.1.123/24','192.168.1.1/24','10.0.0.1/32'])).toEqual(['192.168.1.0/24','10.0.0.1/32']);
 expect(normalize(['0.0.0.0/1','128.0.0.0/2'])).toEqual(['0.0.0.0/1','128.0.0.0/2']);
 expect(normalize([])).toEqual([]);
});
