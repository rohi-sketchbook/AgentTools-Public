const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const gatewayRoot = path.resolve(__dirname, '..');
const testRoot = path.join(gatewayRoot, 'state', `skill-improvement-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
const skillDir = path.join(testRoot, 'sample-skill');
const skillPath = path.join(skillDir, 'SKILL.md');
const stateRoot = path.join(testRoot, 'state');

fs.mkdirSync(skillDir, { recursive: true });
fs.mkdirSync(stateRoot, { recursive: true });
process.env.AGENTTOOLS_STATE_ROOT = stateRoot;

const store = require('../src/core/skillImprovementStore');
const workTasks = require('../src/core/workTaskStore');
const skillTool = require('../src/tools/skill');

async function main() {
try {
  const base = '---\nname: sample-skill\n---\n\n# Sample\n\nOld guidance.\n';
  const proposed = '---\nname: sample-skill\n---\n\n# Sample\n\nImproved guidance.\n';
  fs.writeFileSync(skillPath, base, 'utf8');

  const first = store.proposeSkillImprovement({
    skillPath,
    skillName: 'sample-skill',
    reason: 'Repeated workflow should be reusable.',
    summary: 'Refresh guidance',
    proposedBy: 'test',
    source: 'test',
    proposedContent: proposed,
  });
  assert.equal(first.deduplicated, false);
  assert.equal(first.proposal.status, 'pending');
  assert.match(first.proposal.diff, /-Old guidance\./);
  assert.match(first.proposal.diff, /\+Improved guidance\./);

  const duplicate = store.proposeSkillImprovement({
    skillPath,
    reason: 'Repeated workflow should be reusable.',
    proposedBy: 'test',
    proposedContent: proposed,
  });
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.proposal.id, first.proposal.id);
  assert.equal(store.listProposals({ mode: 'active' }).length, 1);

  const approved = store.approveProposal({ id: first.proposal.id, approvedBy: 'tester' });
  assert.equal(approved.status, 'approved');

  const applied = store.applyProposal({ id: first.proposal.id });
  assert.equal(applied.stale, false);
  assert.equal(applied.proposal.status, 'applied');
  assert.equal(fs.readFileSync(skillPath, 'utf8'), proposed);

  const secondProposed = proposed.replace('Improved guidance.', 'Newer guidance.');
  const second = store.proposeSkillImprovement({
    skillPath,
    reason: 'Second proposal for stale detection.',
    proposedBy: 'test',
    proposedContent: secondProposed,
  });
  fs.writeFileSync(skillPath, `${proposed}\nExternal edit.\n`, 'utf8');
  const stale = store.approveProposal({ id: second.proposal.id, approvedBy: 'tester' });
  assert.equal(stale.status, 'stale');
  assert.match(stale.staleReason, /changed after this proposal/i);

  const rejected = store.rejectProposal({ id: second.proposal.id, rejectedBy: 'tester', note: 'superseded' });
  assert.equal(rejected.status, 'rejected');

  fs.writeFileSync(skillPath, proposed, 'utf8');
  const thirdContent = proposed.replace('Improved guidance.', 'Confirmed guidance.');
  const third = store.proposeSkillImprovement({
    skillPath,
    reason: 'Exercise protected apply path.',
    proposedBy: 'test',
    proposedContent: thirdContent,
  });
  const thirdApproved = store.approveProposal({ id: third.proposal.id, approvedBy: 'tester' });
  assert.equal(thirdApproved.status, 'approved');
  const dryRun = await skillTool.apply({ id: third.proposal.id, userExplicitlyRequested: true });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.requiresConfirmation, true);
  assert.equal(dryRun.policyDecision?.ok, true);
  assert.ok(dryRun.confirmToken);
  const confirmed = await skillTool.apply({
    id: third.proposal.id,
    userExplicitlyRequested: true,
    confirmToken: dryRun.confirmToken,
  });
  assert.equal(confirmed.ok, true);
  assert.equal(fs.readFileSync(skillPath, 'utf8'), thirdContent);

  const bufferedSkillDir = path.join(testRoot, 'buffered-skill');
  const bufferedSkillPath = path.join(bufferedSkillDir, 'SKILL.md');
  fs.mkdirSync(bufferedSkillDir, { recursive: true });
  const bufferedBase = '---\nname: buffered-skill\n---\n\n# Buffered\n\nOld task guidance.\n';
  const bufferedProposed = bufferedBase.replace('Old task guidance.', 'Improved task guidance.');
  fs.writeFileSync(bufferedSkillPath, bufferedBase, 'utf8');

  const task = workTasks.startWorkTask({
    title: 'Buffer Skill improvement',
    request: 'Verify task completion proposal flush',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    project: 'test',
    workspaceRoot: gatewayRoot,
    phase: '実装',
    message: 'Skill改善候補を検出',
  });
  const buffered = workTasks.bufferWorkTaskSkillImprovement({
    id: task.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    skillPath: bufferedSkillPath,
    skillName: 'buffered-skill',
    reason: 'Taskで再利用可能な修正手順が確定した。',
    summary: 'Task完了時にproposal化',
    proposedContent: bufferedProposed,
  });
  assert.equal(buffered.candidate.status, 'buffered');
  assert.equal(buffered.task.work.skillImprovementCandidates.length, 1);
  assert.equal(store.listProposals({ mode: 'all' }).some((entry) => entry.sourceTaskId === task.id), false);

  const taskCompleted = workTasks.completeWorkTask({
    id: task.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    summary: 'Task完了',
  });
  assert.equal(taskCompleted.status, 'succeeded');
  assert.equal(taskCompleted.work.skillImprovementCandidates[0].status, 'proposed');
  assert.ok(taskCompleted.work.skillImprovementCandidates[0].proposalId);
  const taskProposal = store.getProposal(taskCompleted.work.skillImprovementCandidates[0].proposalId);
  assert.equal(taskProposal.sourceTaskId, task.id);
  assert.equal(taskProposal.source, 'task_completion');
  assert.equal(taskProposal.status, 'pending');
  assert.equal(fs.readFileSync(bufferedSkillPath, 'utf8'), bufferedBase, 'task completion must not apply the proposal');

  const staleSkillDir = path.join(testRoot, 'buffered-stale-skill');
  const staleSkillPath = path.join(staleSkillDir, 'SKILL.md');
  fs.mkdirSync(staleSkillDir, { recursive: true });
  const staleBase = '---\nname: buffered-stale-skill\n---\n\n# Stale\n\nBase guidance.\n';
  fs.writeFileSync(staleSkillPath, staleBase, 'utf8');
  const staleTask = workTasks.startWorkTask({
    title: 'Stale Skill improvement',
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    workspaceRoot: gatewayRoot,
  });
  workTasks.bufferWorkTaskSkillImprovement({
    id: staleTask.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    skillPath: staleSkillPath,
    reason: 'stale safety test',
    proposedContent: staleBase.replace('Base guidance.', 'Buffered guidance.'),
  });
  fs.writeFileSync(staleSkillPath, staleBase.replace('Base guidance.', 'External newer guidance.'), 'utf8');
  const staleTaskCompleted = workTasks.completeWorkTask({
    id: staleTask.id,
    actor: 'chatgpt',
    actorLabel: 'ChatGPT',
    summary: 'stale test complete',
  });
  assert.equal(staleTaskCompleted.work.skillImprovementCandidates[0].status, 'stale');
  assert.equal(staleTaskCompleted.work.skillImprovementCandidates[0].proposalId, null);
  assert.match(staleTaskCompleted.work.skillImprovementCandidates[0].error, /changed after this candidate/i);

  console.log('SKILL_IMPROVEMENT_STORE_TEST_OK');
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
