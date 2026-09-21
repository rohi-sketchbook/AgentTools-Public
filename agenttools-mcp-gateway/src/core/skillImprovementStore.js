const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readState, mutateState } = require('./stateFile');
const { assertPathAllowed } = require('./paths');

const STORE_FILE = 'skill-improvements.json';
const STORE_SCHEMA = 'agenttools-skill-improvements/v1';
const ID_PATTERN = /^skillimp_\d{14}_[a-f0-9]{8}$/;
const STATUSES = new Set(['pending', 'approved', 'rejected', 'applied', 'stale']);
const ACTIVE_STATUSES = new Set(['pending', 'approved', 'stale']);
const MAX_PROPOSALS = 50;
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_DIFF_CHARS = 16 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function createId() {
  return `skillimp_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;
}

function assertId(value) {
  const id = String(value || '').trim();
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid skill improvement id: ${id}`);
  return id;
}

function normalizeText(value, field, { required = false, maxLength = 4000 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} is required.`);
    return null;
  }
  const text = String(value).trim();
  if (!text && required) throw new Error(`${field} is required.`);
  if (text.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters.`);
  return text || null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function readUtf8File(fullPath, maxBytes = MAX_SKILL_BYTES) {
  const stat = fs.statSync(fullPath);
  if (!stat.isFile()) throw new Error(`Expected a file: ${fullPath}`);
  if (stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${fullPath}`);
  return fs.readFileSync(fullPath, 'utf8');
}

function assertSkillPath(inputPath) {
  const allowed = assertPathAllowed(inputPath);
  const fullPath = allowed.canonicalPath;
  if (path.basename(fullPath).toLowerCase() !== 'skill.md') {
    throw new Error('Skill improvement targets must be SKILL.md files.');
  }
  if (!fs.existsSync(fullPath)) throw new Error(`Skill file not found: ${fullPath}`);
  readUtf8File(fullPath);
  return fullPath;
}

function readProposedContent(input = {}) {
  if (input.proposedContent !== undefined && input.proposedContent !== null) {
    const content = String(input.proposedContent);
    if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) {
      throw new Error(`proposedContent exceeds ${MAX_SKILL_BYTES} bytes.`);
    }
    return content;
  }

  if (input.proposedContentFile) {
    const allowed = assertPathAllowed(String(input.proposedContentFile));
    return readUtf8File(allowed.canonicalPath);
  }

  throw new Error('proposedContent or proposedContentFile is required.');
}

function splitLines(value) {
  return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function buildCompactDiff(currentContent, proposedContent, label = 'SKILL.md', contextLines = 3) {
  const before = splitLines(currentContent);
  const after = splitLines(proposedContent);

  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;

  if (prefix === before.length && prefix === after.length) return '';

  const contextStart = Math.max(0, prefix - contextLines);
  const beforeChangeEnd = Math.max(prefix, before.length - suffix);
  const afterChangeEnd = Math.max(prefix, after.length - suffix);
  const suffixContextEndBefore = Math.min(before.length, beforeChangeEnd + contextLines);
  const suffixContextEndAfter = Math.min(after.length, afterChangeEnd + contextLines);
  const visibleSuffix = Math.min(
    suffixContextEndBefore - beforeChangeEnd,
    suffixContextEndAfter - afterChangeEnd,
  );

  const oldStart = contextStart + 1;
  const oldCount = (prefix - contextStart) + (beforeChangeEnd - prefix) + visibleSuffix;
  const newStart = contextStart + 1;
  const newCount = (prefix - contextStart) + (afterChangeEnd - prefix) + visibleSuffix;
  const output = [
    `--- current/${label}`,
    `+++ proposed/${label}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
  ];

  for (let i = contextStart; i < prefix; i += 1) output.push(` ${before[i]}`);
  for (let i = prefix; i < beforeChangeEnd; i += 1) output.push(`-${before[i]}`);
  for (let i = prefix; i < afterChangeEnd; i += 1) output.push(`+${after[i]}`);
  for (let i = 0; i < visibleSuffix; i += 1) output.push(` ${before[beforeChangeEnd + i]}`);

  const diff = output.join('\n');
  return diff.length <= MAX_DIFF_CHARS
    ? diff
    : `${diff.slice(0, MAX_DIFF_CHARS)}\n... [diff truncated]`;
}

function normalizeStore(store) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) return { schema: STORE_SCHEMA, proposals: [] };
  store.schema = STORE_SCHEMA;
  if (!Array.isArray(store.proposals)) store.proposals = [];
  return store;
}

function loadStore() {
  return normalizeStore(readState(STORE_FILE, { schema: STORE_SCHEMA, proposals: [] }));
}

function publicProposal(proposal, { includeContent = false } = {}) {
  if (!proposal) return null;
  const view = {
    id: proposal.id,
    status: proposal.status,
    skillName: proposal.skillName,
    skillPath: proposal.skillPath,
    reason: proposal.reason,
    summary: proposal.summary,
    source: proposal.source,
    sourceTaskId: proposal.sourceTaskId || null,
    proposedBy: proposal.proposedBy,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    baseHash: proposal.baseHash,
    proposedHash: proposal.proposedHash,
    diff: proposal.diff,
    review: proposal.review || null,
    appliedAt: proposal.appliedAt || null,
    staleReason: proposal.staleReason || null,
  };
  if (includeContent) view.proposedContent = proposal.proposedContent;
  return view;
}

function pruneProposals(proposals) {
  const sorted = [...proposals].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const active = sorted.filter((entry) => ACTIVE_STATUSES.has(entry.status));
  const terminal = sorted.filter((entry) => !ACTIVE_STATUSES.has(entry.status));
  return [...active, ...terminal].slice(0, MAX_PROPOSALS);
}

function proposeSkillImprovement(input = {}) {
  const skillPath = assertSkillPath(input.skillPath);
  const currentContent = readUtf8File(skillPath);
  const proposedContent = readProposedContent(input);
  const baseHash = sha256(currentContent);
  const proposedHash = sha256(proposedContent);
  if (baseHash === proposedHash) throw new Error('Proposed Skill content is identical to the current file.');

  const timestamp = nowIso();
  const proposal = {
    id: createId(),
    status: 'pending',
    skillName: normalizeText(input.skillName, 'skillName', { maxLength: 200 }) || path.basename(path.dirname(skillPath)),
    skillPath,
    reason: normalizeText(input.reason, 'reason', { required: true, maxLength: 4000 }),
    summary: normalizeText(input.summary, 'summary', { maxLength: 1000 }) || 'Skill改善候補',
    source: normalizeText(input.source, 'source', { maxLength: 100 }) || 'agent',
    sourceTaskId: normalizeText(input.sourceTaskId, 'sourceTaskId', { maxLength: 200 }),
    proposedBy: normalizeText(input.proposedBy, 'proposedBy', { maxLength: 200 }) || 'agent',
    createdAt: timestamp,
    updatedAt: timestamp,
    baseHash,
    proposedHash,
    proposedContent,
    diff: buildCompactDiff(currentContent, proposedContent, path.basename(path.dirname(skillPath)) || 'SKILL.md'),
    review: null,
    appliedAt: null,
    staleReason: null,
  };

  return mutateState(STORE_FILE, { schema: STORE_SCHEMA, proposals: [] }, (rawStore) => {
    const store = normalizeStore(rawStore);
    const duplicate = store.proposals.find((entry) => (
      entry.status === 'pending'
      && path.resolve(entry.skillPath) === path.resolve(skillPath)
      && entry.baseHash === baseHash
      && entry.proposedHash === proposedHash
    ));
    if (duplicate) return { proposal: publicProposal(duplicate), deduplicated: true };

    store.proposals = pruneProposals([proposal, ...store.proposals]);
    return { proposal: publicProposal(proposal), deduplicated: false };
  });
}

function getProposal(id, { includeContent = false } = {}) {
  const proposalId = assertId(id);
  const store = loadStore();
  return publicProposal(store.proposals.find((entry) => entry.id === proposalId) || null, { includeContent });
}

function listProposals({ mode = 'active', limit = 50 } = {}) {
  const store = loadStore();
  const normalizedMode = String(mode || 'active').trim().toLowerCase();
  const max = Math.max(1, Math.min(Number(limit) || 50, 100));
  let proposals = store.proposals;
  if (normalizedMode === 'active') proposals = proposals.filter((entry) => ACTIVE_STATUSES.has(entry.status));
  else if (normalizedMode !== 'all' && normalizedMode !== 'recent') {
    if (!STATUSES.has(normalizedMode)) throw new Error(`Unknown skill improvement mode: ${normalizedMode}`);
    proposals = proposals.filter((entry) => entry.status === normalizedMode);
  }
  return proposals.slice(0, max).map((entry) => publicProposal(entry));
}

function mutateProposal(id, mutator) {
  const proposalId = assertId(id);
  return mutateState(STORE_FILE, { schema: STORE_SCHEMA, proposals: [] }, (rawStore) => {
    const store = normalizeStore(rawStore);
    const index = store.proposals.findIndex((entry) => entry.id === proposalId);
    if (index < 0) throw new Error(`Skill improvement proposal not found: ${proposalId}`);
    const proposal = store.proposals[index];
    const result = mutator(proposal);
    proposal.updatedAt = nowIso();
    store.proposals[index] = proposal;
    store.proposals = pruneProposals(store.proposals);
    return result === undefined ? publicProposal(proposal) : result;
  });
}

function verifyCurrentBase(proposal) {
  const skillPath = assertSkillPath(proposal.skillPath);
  const currentContent = readUtf8File(skillPath);
  const currentHash = sha256(currentContent);
  if (currentHash !== proposal.baseHash) {
    return {
      ok: false,
      currentHash,
      reason: 'Skill changed after this proposal was created. Review a fresh proposal instead of applying the stale diff.',
    };
  }
  return { ok: true, currentHash, currentContent };
}

function approveProposal(input = {}) {
  return mutateProposal(input.id, (proposal) => {
    if (proposal.status !== 'pending') throw new Error(`Only pending proposals can be approved (current: ${proposal.status}).`);
    const base = verifyCurrentBase(proposal);
    if (!base.ok) {
      proposal.status = 'stale';
      proposal.staleReason = base.reason;
      proposal.review = {
        decision: 'stale',
        by: normalizeText(input.approvedBy, 'approvedBy', { maxLength: 200 }) || 'user',
        at: nowIso(),
        note: base.reason,
      };
      return publicProposal(proposal);
    }

    proposal.status = 'approved';
    proposal.staleReason = null;
    proposal.review = {
      decision: 'approved',
      by: normalizeText(input.approvedBy, 'approvedBy', { maxLength: 200 }) || 'user',
      at: nowIso(),
      note: normalizeText(input.note, 'note', { maxLength: 2000 }),
    };
    return publicProposal(proposal);
  });
}

function rejectProposal(input = {}) {
  return mutateProposal(input.id, (proposal) => {
    if (!['pending', 'approved', 'stale'].includes(proposal.status)) {
      throw new Error(`Proposal cannot be rejected from status ${proposal.status}.`);
    }
    proposal.status = 'rejected';
    proposal.review = {
      decision: 'rejected',
      by: normalizeText(input.rejectedBy, 'rejectedBy', { maxLength: 200 }) || 'user',
      at: nowIso(),
      note: normalizeText(input.note, 'note', { maxLength: 2000 }),
    };
    return publicProposal(proposal);
  });
}

function applyProposal(input = {}) {
  return mutateProposal(input.id, (proposal) => {
    if (proposal.status !== 'approved') throw new Error(`Only approved proposals can be applied (current: ${proposal.status}).`);
    const base = verifyCurrentBase(proposal);
    if (!base.ok) {
      proposal.status = 'stale';
      proposal.staleReason = base.reason;
      return { stale: true, error: base.reason, proposal: publicProposal(proposal) };
    }

    if (sha256(proposal.proposedContent) !== proposal.proposedHash) {
      throw new Error('Stored proposed content hash mismatch; refusing to apply.');
    }

    fs.writeFileSync(proposal.skillPath, proposal.proposedContent, 'utf8');
    const appliedContent = readUtf8File(proposal.skillPath);
    const appliedHash = sha256(appliedContent);
    if (appliedHash !== proposal.proposedHash) {
      fs.writeFileSync(proposal.skillPath, base.currentContent, 'utf8');
      throw new Error('Skill write verification failed; original content was restored.');
    }

    proposal.status = 'applied';
    proposal.appliedAt = nowIso();
    proposal.staleReason = null;
    return { stale: false, proposal: publicProposal(proposal) };
  });
}

module.exports = {
  STORE_FILE,
  STORE_SCHEMA,
  STATUSES,
  ACTIVE_STATUSES,
  MAX_SKILL_BYTES,
  MAX_DIFF_CHARS,
  sha256,
  buildCompactDiff,
  proposeSkillImprovement,
  getProposal,
  listProposals,
  approveProposal,
  rejectProposal,
  applyProposal,
};
