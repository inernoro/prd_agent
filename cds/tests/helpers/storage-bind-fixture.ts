import type {BindMountInspector} from '../../src/services/deployment-bind-mount-proof.js';
/** Explicit unit dependency: Docker/network tests with virtual paths do not assert native FS safety.
 * Never install this in production or in the native filesystem security tests. */
export const unitBindMountInspector: BindMountInspector = _plan => () => {};
