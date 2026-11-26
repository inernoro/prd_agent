import { Router, type Request, type Response } from 'express';
import type { AuthService } from '../services/auth-service.js';
import { AccountActionError, AccountActionsService, publicAccountAction } from '../services/account-actions.js';
import { humanPrincipalId, isHumanProjectGrantUpdatePending } from '../services/human-project-access.js';
import { credentialUsability, hasActiveGrant } from '../services/identity.js';
import type { StateService } from '../services/state.js';

const allowed = ['reset-password', 'disable-user', 'revoke-sessions'];

export function createAccountProposalsRouter(auth: AuthService, state: StateService): Router {
  const router = Router();
  const proposals = new AccountActionsService(auth, async () => {
    // This interface only permits proposal intake.
    throw new AccountActionError(403, 'human_confirmation_required', '账号操作需由系统所有者批准');
  });

  async function delegate(req: Request) {
    const context = (req as Request & { cdsPrincipal?: { principalId: string; credentialId: string } }).cdsPrincipal;
    const credential = context && state.getUserCredentials().find(item => item.id === context.credentialId);
    const principalId = credential?.principalId;
    if (!credential?.accountProposals || !credential.projectIds?.length ||
        !principalId?.startsWith('human:') || principalId !== context?.principalId ||
        isHumanProjectGrantUpdatePending(state, principalId) ||
        !credentialUsability(credential, state.getPrincipal(principalId), Date.now(), true).usable) {
      throw new AccountActionError(403, 'account_proposal_scope_denied', '此设备暂无账号提案授权，请在 CDS 中核对接入审批');
    }
    const account = await auth.findUserById(principalId.slice('human:'.length));
    const projects = credential.projectIds.filter(projectId => hasActiveGrant(state.getProjectGrants(), principalId, projectId));
    if (!account || account.status !== 'active' || account.isSystemOwner || !account.isAdministrator || !projects.length) {
      throw new AccountActionError(403, 'account_proposal_scope_denied', '原管理员或项目授权已失效，请核对接入状态');
    }
    return { account, credential, projects };
  }

  function handle(op: (req: Request, res: Response) => Promise<void>) {
    return async (req: Request, res: Response): Promise<void> => {
      res.setHeader('Cache-Control', 'private, no-store');
      try { await op(req, res); }
      catch (error) {
        if (error instanceof AccountActionError) res.status(error.status).json({ code: error.code, error: error.message });
        else res.status(503).json({ code: 'account_proposal_unavailable', error: '账号提案暂不可用，请稍后重读' });
      }
    };
  }

  router.post('/auth/account-proposals', handle(async (req, res) => {
    const { account, credential, projects } = await delegate(req);
    const { targetId, action } = req.body || {};
    if (typeof targetId !== 'string' || !allowed.includes(action)) {
      throw new AccountActionError(400, 'invalid_account_proposal', '请选择允许的提案动作和目标账号');
    }
    const principalId = humanPrincipalId(targetId);
    if (state.getPrincipal(principalId)?.status !== 'active' ||
        !projects.some(projectId => hasActiveGrant(state.getProjectGrants(), principalId, projectId))) {
      throw new AccountActionError(403, 'account_proposal_scope_denied', '目标账号不在设备当前获授权项目范围');
    }
    const request = await proposals.submit(account, req.body, credential.id);
    res.status(201).json({ request: publicAccountAction(request) });
  }));
  router.get('/auth/account-proposals/:id', handle(async (req, res) => {
    const { account, credential } = await delegate(req);
    const request = await auth.accountActions?.get(req.params.id);
    if (!request || request.proposalCredentialId !== credential.id || request.requestedByAccountId !== account.id) {
      throw new AccountActionError(404, 'account_proposal_not_found', '此凭据没有提交该提案');
    }
    res.json({ request: publicAccountAction(request) });
  }));
  return router;
}
