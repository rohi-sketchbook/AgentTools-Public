const {
  proposeSkillImprovement,
  getProposal,
  listProposals,
  approveProposal,
  rejectProposal,
  applyProposal,
} = require('../core/skillImprovementStore');
const { createConfirmation, verifyConfirmation } = require('../core/confirmations');
const { skillUsage, curateSkills } = require('../core/skillTelemetry');

function truthy(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

async function list(options = {}) {
  return {
    ok: true,
    proposals: listProposals({ mode: options.mode || 'active', limit: options.limit || 50 }),
  };
}

async function get(options = {}) {
  const id = options.id || options.proposalId;
  const proposal = getProposal(id, { includeContent: truthy(options.includeContent) });
  return proposal
    ? { ok: true, proposal }
    : { ok: false, error: `Skill improvement proposal not found: ${id}` };
}

async function usage(options = {}) {
  return skillUsage(options);
}

async function curate(options = {}) {
  return curateSkills(options);
}

async function propose(options = {}) {
  const result = proposeSkillImprovement(options);
  return { ok: true, ...result };
}

async function approve(options = {}) {
  const proposal = approveProposal({
    id: options.id || options.proposalId,
    approvedBy: options.approvedBy || 'user',
    note: options.note,
  });
  return {
    ok: proposal.status === 'approved',
    proposal,
    error: proposal.status === 'stale' ? proposal.staleReason : null,
  };
}

async function reject(options = {}) {
  const proposal = rejectProposal({
    id: options.id || options.proposalId,
    rejectedBy: options.rejectedBy || 'user',
    note: options.note,
  });
  return { ok: true, proposal };
}

async function apply(options = {}) {
  const id = options.id || options.proposalId;
  const proposal = getProposal(id);
  if (!proposal) return { ok: false, error: `Skill improvement proposal not found: ${id}` };
  if (proposal.status !== 'approved') {
    return { ok: false, error: `Only approved proposals can be applied (current: ${proposal.status}).`, proposal };
  }

  const userExplicitlyRequested = truthy(options.userExplicitlyRequested);
  const payload = {
    id: proposal.id,
    skillPath: proposal.skillPath,
    baseHash: proposal.baseHash,
    proposedHash: proposal.proposedHash,
    userExplicitlyRequested,
  };

  if (!options.confirmToken) {
    return createConfirmation({
      action: 'skill.apply',
      impact: 'write',
      summary: `Apply approved Skill improvement: ${proposal.skillName}`,
      payload,
      preview: {
        id: proposal.id,
        skillName: proposal.skillName,
        skillPath: proposal.skillPath,
        summary: proposal.summary,
        reason: proposal.reason,
        diff: proposal.diff,
      },
      userExplicitlyRequested,
    });
  }

  const confirmation = verifyConfirmation({
    action: 'skill.apply',
    token: options.confirmToken,
    payload,
    impact: 'write',
    consume: true,
    userExplicitlyRequested,
  });
  if (!confirmation.ok) {
    return { ok: false, error: confirmation.reason, confirmation };
  }

  const result = applyProposal({ id });
  if (result?.stale) {
    return { ok: false, error: result.error, proposal: result.proposal };
  }
  return { ok: true, proposal: result?.proposal || result, confirmation };
}

module.exports = {
  list,
  get,
  usage,
  curate,
  propose,
  approve,
  reject,
  apply,
};
