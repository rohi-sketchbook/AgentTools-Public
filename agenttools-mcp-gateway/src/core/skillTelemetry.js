const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { workspaceState } = require('./devspaceManager');
const { listProposals } = require('./skillImprovementStore');

const DEFAULT_STALE_DAYS = 90;
const MAX_SCAN_FILES = 500;

function readDevSpaceSkillUsage(limit = 500) {
  const state = workspaceState();
  if (!state.databaseExists || state.error || !fs.existsSync(state.databasePath)) {
    return { ok: false, usage: [], databasePath: state.databasePath, error: state.error || 'DevSpace database is unavailable.' };
  }
  let db;
  try {
    db = new DatabaseSync(state.databasePath, { readOnly: true });
    const table = db.prepare("select 1 from sqlite_master where type='table' and name='skill_usage'").get();
    if (!table) return { ok: true, usage: [], databasePath: state.databasePath, schemaAvailable: false };
    const bounded = Math.max(1, Math.min(Number(limit) || 500, 1000));
    const rows = db.prepare(`
      select skill_path as skillPath, skill_name as skillName, view_count as viewCount, use_count as useCount,
             first_seen_at as firstSeenAt, last_viewed_at as lastViewedAt, last_used_at as lastUsedAt,
             last_workspace_root as lastWorkspaceRoot
      from skill_usage
      order by coalesce(last_used_at, last_viewed_at, first_seen_at) desc
      limit ?
    `).all(bounded).map((row) => ({
      ...row,
      viewCount: Number(row.viewCount || 0),
      useCount: Number(row.useCount || 0),
    }));
    return { ok: true, usage: rows, databasePath: state.databasePath, schemaAvailable: true };
  } catch (error) {
    return { ok: false, usage: [], databasePath: state.databasePath, error: error.message };
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
}

function normalizePath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function discoverSkillFiles() {
  const roots = [
    path.join(os.homedir(), '.agents', 'skills'),
    path.join(os.homedir(), '.codex', 'skills'),
    path.join(os.homedir(), '.devspace', 'skills'),
  ];
  const files = [];
  for (const root of roots) walkSkills(root, files, 0);
  return files.slice(0, MAX_SCAN_FILES);
}

function walkSkills(directory, output, depth) {
  if (depth > 3 || output.length >= MAX_SCAN_FILES || !fs.existsSync(directory)) return;
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (output.length >= MAX_SCAN_FILES) return;
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walkSkills(fullPath, output, depth + 1);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
      output.push(readSkillIdentity(fullPath));
    }
  }
}

function readSkillIdentity(filePath) {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf8').slice(0, 8192); } catch { /* keep fallback */ }
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const nameMatch = frontmatter?.[1]?.match(/^name:\s*["']?([^\r\n"']+)/m);
  const descriptionMatch = frontmatter?.[1]?.match(/^description:\s*["']?([^\r\n"']+)/m);
  return {
    skillPath: path.resolve(filePath),
    skillName: nameMatch?.[1]?.trim() || path.basename(path.dirname(filePath)),
    description: descriptionMatch?.[1]?.trim() || null,
    root: path.dirname(path.dirname(filePath)),
  };
}

function skillUsage(options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 200) || 200, 1000));
  const telemetry = readDevSpaceSkillUsage(limit);
  return {
    ok: telemetry.ok,
    databasePath: telemetry.databasePath,
    schemaAvailable: telemetry.schemaAvailable !== false,
    usage: telemetry.usage,
    error: telemetry.error || null,
  };
}

function curateSkills(options = {}) {
  const staleDays = Math.max(1, Math.min(Number(options.staleDays || options.days || DEFAULT_STALE_DAYS) || DEFAULT_STALE_DAYS, 3650));
  const telemetry = readDevSpaceSkillUsage(1000);
  const skills = discoverSkillFiles();
  const usageByPath = new Map(telemetry.usage.map((entry) => [normalizePath(entry.skillPath), entry]));
  const proposals = listProposals({ mode: 'active', limit: 100 });
  const proposalByPath = new Map(proposals.map((entry) => [normalizePath(entry.skillPath), entry]));
  const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;

  const stale = telemetry.usage.filter((entry) => {
    const time = Date.parse(entry.lastUsedAt || entry.lastViewedAt || entry.firstSeenAt || '');
    return Number.isFinite(time) && time < cutoff;
  }).map((entry) => ({
    ...entry,
    recommendation: 'review_for_archive_or_merge',
    proposal: proposalByPath.get(normalizePath(entry.skillPath)) || null,
  })).slice(0, 100);

  const unused = skills.filter((skill) => !usageByPath.has(normalizePath(skill.skillPath))).map((skill) => ({
    ...skill,
    recommendation: 'review_if_still_needed',
    proposal: proposalByPath.get(normalizePath(skill.skillPath)) || null,
  })).slice(0, 100);

  const grouped = new Map();
  for (const skill of skills) {
    const key = skill.skillName.toLowerCase();
    const group = grouped.get(key) || [];
    group.push(skill);
    grouped.set(key, group);
  }
  const collisions = [...grouped.entries()].filter(([, group]) => group.length > 1).map(([skillName, group]) => ({
    skillName,
    paths: group.map((entry) => entry.skillPath),
    recommendation: 'review_for_single_source_of_truth',
  })).slice(0, 100);

  const highUse = telemetry.usage.filter((entry) => entry.useCount >= 10).slice(0, 50).map((entry) => ({
    ...entry,
    recommendation: 'protect_and_keep_current',
    proposal: proposalByPath.get(normalizePath(entry.skillPath)) || null,
  }));

  return {
    ok: telemetry.ok,
    reviewOnly: true,
    staleDays,
    telemetryAvailable: telemetry.schemaAvailable !== false,
    databasePath: telemetry.databasePath,
    candidates: { stale, unused, collisions, highUse },
    activeProposals: proposals,
    note: 'Curator never edits, deletes, archives, or merges Skills automatically. Use skill.propose -> skill.approve -> skill.apply for reviewed changes.',
    error: telemetry.error || null,
  };
}

module.exports = {
  readDevSpaceSkillUsage,
  discoverSkillFiles,
  skillUsage,
  curateSkills,
};
