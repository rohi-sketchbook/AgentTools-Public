const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readState, mutateState } = require('./stateFile');
const { assertPathAllowed } = require('./paths');
const {
  MAX_SKILL_BYTES,
  sha256,
  proposeSkillImprovement,
} = require('./skillImprovementStore');

const STORE_FILE = 'skill-improvement-buffer.json';
const STORE_SCHEMA = 'agenttools-skill-improvement-buffer/v1';
const MAX_CANDIDATES = 100;
const MAX_BUFFERED_PER_TASK = 8;
const TASK_ID_PATTERN = /^task_\d{14}_[a-f0-9]{8}$/;
const CANDIDATE_ID_PATTERN = /^skillcand_\d{14}_[a-f0-9]{8}$/;
const STATUSES = new Set(['buffered', 'proposed', 'stale', 'failed']);

function nowIso() {
  return new Date().toISOString();
}

function createId() {
  return `skillcand_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;
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

function assertTaskId(value) {
  const taskId = String(value || '').trim();
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`Invalid taskId: ${taskId}`);
  return taskId;
}

function assertCandidateId(value) {
  const id = String(value || '').trim();
  if (!CANDIDATE_ID_PATTERN.test(id)) throw new Error(`Invalid skill improvement candidate id: ${id}`);
  return id;
}

function readUtf8File(fullPath, maxBytes = MAX_SKILL_BYTES) {
  const stat = fs.statSync(fullPath);
  if (!stat.isFile()) throw new Error(`Expected a file: ${fullPath}`);
  if (stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${fullPath}`);
  return fs.readFileSync(fullPath, 'utf8');
}

function assertSkillPath(inputPath) {
  const allowed = assertPathAllowed(String(inputPath || ''));
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

function normalizeStore(raw) {
  const candidates = Array.isArray(raw?.candidates) ? raw.candidates : [];
  return {
    schema: STORE_SCHEMA,
    candidates: candidates
      .filter((entry) => entry && CANDIDATE_ID_PATTERN.test(String(entry.id || '')))
      .map((entry) => ({
        ...entry,
        status: STATUSES.has(entry.status) ? entry.status : 'failed',
      })),
  };
}

function pruneCandidates(candidates) {
  const sorted = [...candidates].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  const buffered = sorted.filter((entry) => entry.status === 'buffered');
  const terminal = sorted.filter((entry) => entry.status !== 'buffered');
  return [...buffered, ...terminal].slice(0, MAX_CANDIDATES);
}

function publicCandidate(candidate) {
  if (!candidate) return null;
  return {
    id: candidate.id,
    taskId: candidate.taskId,
    status: candidate.status,
    skillName: candidate.skillName,
    skillPath: candidate.skillPath,
    reason: candidate.reason,
    summary: candidate.summary,
    source: candidate.source,
    proposedBy: candidate.proposedBy,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    proposalId: candidate.proposalId || null,
    error: candidate.error || null,
  };
}

function bufferSkillImprovementCandidate(input = {}) {
  const taskId = assertTaskId(input.taskId || input.id);
  const skillPath = assertSkillPath(input.skillPath);
  const currentContent = readUtf8File(skillPath);
  const proposedContent = readProposedContent(input);
  const baseHash = sha256(currentContent);
  const proposedHash = sha256(proposedContent);
  if (baseHash === proposedHash) throw new Error('Proposed Skill content is identical to the current file.');

  const timestamp = nowIso();
  const candidate = {
    id: createId(),
    taskId,
    status: 'buffered',
    skillName: normalizeText(input.skillName, 'skillName', { maxLength: 200 }) || path.basename(path.dirname(skillPath)),
    skillPath,
    reason: normalizeText(input.reason, 'reason', { required: true, maxLength: 4000 }),
    summary: normalizeText(input.summary, 'summary', { maxLength: 1000 }) || 'Skill改善候補',
    source: normalizeText(input.source, 'source', { maxLength: 100 }) || 'task_completion',
    proposedBy: normalizeText(input.proposedBy, 'proposedBy', { maxLength: 200 }) || 'agent',
    createdAt: timestamp,
    updatedAt: timestamp,
    baseHash,
    proposedHash,
    proposedContent,
    proposalId: null,
    error: null,
  };

  return mutateState(STORE_FILE, { schema: STORE_SCHEMA, candidates: [] }, (raw) => {
    const store = normalizeStore(raw);
    const duplicate = store.candidates.find((entry) => (
      entry.status === 'buffered'
      && entry.taskId === taskId
      && path.resolve(entry.skillPath) === path.resolve(skillPath)
      && entry.baseHash === baseHash
      && entry.proposedHash === proposedHash
    ));
    if (duplicate) {
      raw.schema = STORE_SCHEMA;
      raw.candidates = store.candidates;
      return { candidate: publicCandidate(duplicate), deduplicated: true };
    }

    const bufferedCount = store.candidates.filter((entry) => entry.taskId === taskId && entry.status === 'buffered').length;
    if (bufferedCount >= MAX_BUFFERED_PER_TASK) {
      throw new Error(`A Work Task can buffer at most ${MAX_BUFFERED_PER_TASK} Skill improvement candidates.`);
    }

    store.candidates = pruneCandidates([candidate, ...store.candidates]);
    raw.schema = STORE_SCHEMA;
    raw.candidates = store.candidates;
    return { candidate: publicCandidate(candidate), deduplicated: false };
  });
}

function listBufferedCandidates(taskId) {
  const normalizedTaskId = assertTaskId(taskId);
  const store = normalizeStore(readState(STORE_FILE, { schema: STORE_SCHEMA, candidates: [] }));
  return store.candidates.filter((entry) => entry.taskId === normalizedTaskId && entry.status === 'buffered');
}

function updateCandidate(id, patch = {}) {
  const candidateId = assertCandidateId(id);
  return mutateState(STORE_FILE, { schema: STORE_SCHEMA, candidates: [] }, (raw) => {
    const store = normalizeStore(raw);
    const index = store.candidates.findIndex((entry) => entry.id === candidateId);
    if (index < 0) return null;
    store.candidates[index] = {
      ...store.candidates[index],
      ...patch,
      updatedAt: nowIso(),
    };
    store.candidates = pruneCandidates(store.candidates);
    raw.schema = STORE_SCHEMA;
    raw.candidates = store.candidates;
    return publicCandidate(store.candidates.find((entry) => entry.id === candidateId) || null);
  });
}

function flushTaskSkillImprovementCandidates(taskId) {
  const normalizedTaskId = assertTaskId(taskId);
  const buffered = listBufferedCandidates(normalizedTaskId);
  const results = [];

  for (const candidate of buffered) {
    try {
      const skillPath = assertSkillPath(candidate.skillPath);
      const currentContent = readUtf8File(skillPath);
      if (sha256(currentContent) !== candidate.baseHash) {
        const error = 'Skill changed after this candidate was buffered; create a fresh candidate from the current Skill instead.';
        const updated = updateCandidate(candidate.id, { status: 'stale', error });
        results.push(updated);
        continue;
      }

      const result = proposeSkillImprovement({
        skillPath,
        skillName: candidate.skillName,
        reason: candidate.reason,
        summary: candidate.summary,
        source: candidate.source || 'task_completion',
        sourceTaskId: normalizedTaskId,
        proposedBy: candidate.proposedBy,
        proposedContent: candidate.proposedContent,
      });
      const updated = updateCandidate(candidate.id, {
        status: 'proposed',
        proposalId: result.proposal?.id || null,
        error: null,
      });
      results.push({ ...updated, deduplicated: result.deduplicated === true });
    } catch (error) {
      const updated = updateCandidate(candidate.id, { status: 'failed', error: error.message });
      results.push(updated || {
        id: candidate.id,
        taskId: normalizedTaskId,
        status: 'failed',
        skillName: candidate.skillName,
        summary: candidate.summary,
        proposalId: null,
        error: error.message,
      });
    }
  }

  return results;
}

module.exports = {
  STORE_FILE,
  STORE_SCHEMA,
  MAX_CANDIDATES,
  MAX_BUFFERED_PER_TASK,
  bufferSkillImprovementCandidate,
  listBufferedCandidates,
  flushTaskSkillImprovementCandidates,
};
