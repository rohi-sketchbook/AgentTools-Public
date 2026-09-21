const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { listTasks } = require('./taskStore');
const { statePath } = require('./stateFile');
const { workspaceState } = require('./devspaceManager');
const { sanitizeLogText } = require('./redaction');

const INDEX_SCHEMA = 'agenttools-history-index/v1';
const DB_PATH = path.join(path.dirname(statePath('tasks.json')), 'history-search.sqlite');
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function ensureDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    pragma journal_mode = WAL;
    pragma synchronous = NORMAL;
    create table if not exists history_documents (
      record_id text primary key,
      kind text not null,
      title text not null,
      body text not null,
      project text,
      workspace_root text,
      updated_at text not null,
      source_ref text,
      content_hash text not null,
      schema text not null
    );
    create index if not exists history_documents_kind_idx on history_documents(kind, updated_at desc);
    create virtual table if not exists history_unicode_fts using fts5(
      record_id unindexed,
      title,
      body,
      project,
      workspace_root,
      tokenize='unicode61'
    );
    create virtual table if not exists history_trigram_fts using fts5(
      record_id unindexed,
      title,
      body,
      project,
      workspace_root,
      tokenize='trigram'
    );
  `);
  return db;
}

function semanticTaskDocument(task) {
  const work = task.work || {};
  const bodyParts = [
    task.summary,
    work.request,
    work.phase,
    work.currentWork,
    work.stateReason,
    ...(work.workLog || []).flatMap((entry) => [entry.phase, entry.message]),
    ...(work.changedFiles || []),
    ...(work.tests || []),
    work.goal?.desiredOutcome,
    ...(work.goal?.completionCriteria || []),
    ...(work.goal?.verificationSteps || []),
    ...(task.events || []).map((entry) => entry.message),
  ].filter(Boolean);
  return normalizeDocument({
    recordId: `task:${task.id}`,
    kind: 'work_task',
    title: task.title || task.id,
    body: bodyParts.join('\n'),
    project: work.project || null,
    workspaceRoot: work.workspaceRoot || null,
    updatedAt: task.updatedAt || task.createdAt || new Date(0).toISOString(),
    sourceRef: task.id,
  });
}

function semanticSubagentDocument(row) {
  const bodyParts = [
    row.profile_name,
    row.provider,
    row.model,
    row.thinking,
    row.status,
    row.latest_response,
    row.history_content,
    row.error,
  ].filter(Boolean);
  return normalizeDocument({
    recordId: `subagent:${row.id}`,
    kind: 'subagent',
    title: `${row.profile_name || row.provider || 'subagent'} ${row.id}`,
    body: bodyParts.join('\n'),
    project: null,
    workspaceRoot: row.workspace_root || null,
    updatedAt: row.updated_at || row.created_at || new Date(0).toISOString(),
    sourceRef: row.id,
  });
}

function normalizeDocument(input) {
  const title = sanitizeLogText(input.title || '', 2000) || '';
  const body = sanitizeLogText(input.body || '', 32000) || '';
  const project = sanitizeLogText(input.project || '', 1000) || null;
  const workspaceRoot = sanitizeLogText(input.workspaceRoot || '', 4000) || null;
  const contentHash = sha256(JSON.stringify({ title, body, project, workspaceRoot, updatedAt: input.updatedAt }));
  return {
    recordId: String(input.recordId),
    kind: String(input.kind),
    title,
    body,
    project,
    workspaceRoot,
    updatedAt: String(input.updatedAt),
    sourceRef: input.sourceRef ? String(input.sourceRef) : null,
    contentHash,
  };
}

function readDevSpaceSubagents() {
  const state = workspaceState();
  if (!state.databaseExists || state.error || !fs.existsSync(state.databasePath)) {
    return { rows: [], available: false, databasePath: state.databasePath, error: state.error || null };
  }
  let db;
  try {
    db = new DatabaseSync(state.databasePath, { readOnly: true });
    const table = db.prepare("select 1 from sqlite_master where type='table' and name='local_agent_sessions'").get();
    if (!table) return { rows: [], available: true, databasePath: state.databasePath, error: null };
    const rows = db.prepare(`
      select id, workspace_root, profile_name, provider, model, thinking, status,
             latest_response, error, created_at, updated_at
      from local_agent_sessions
      order by updated_at desc
      limit 1000
    `).all();
    const eventTable = db.prepare("select 1 from sqlite_master where type='table' and name='local_agent_events'").get();
    if (eventTable) {
      const byAgent = new Map();
      const events = db.prepare(`
        select agent_id as agentId, content
        from local_agent_events
        where content is not null and content <> ''
        order by created_at desc, id desc
        limit 5000
      `).all();
      for (const event of events) {
        const list = byAgent.get(event.agentId) || [];
        if (list.length < 50) list.push(event.content);
        byAgent.set(event.agentId, list);
      }
      for (const row of rows) row.history_content = (byAgent.get(row.id) || []).join('\n');
    }
    return { rows, available: true, databasePath: state.databasePath, error: null };
  } catch (error) {
    return { rows: [], available: false, databasePath: state.databasePath, error: error.message };
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
}

function upsertDocument(db, doc) {
  const existing = db.prepare('select content_hash as contentHash from history_documents where record_id = ?').get(doc.recordId);
  if (existing?.contentHash === doc.contentHash) return false;

  db.prepare(`
    insert into history_documents (
      record_id, kind, title, body, project, workspace_root, updated_at, source_ref, content_hash, schema
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(record_id) do update set
      kind=excluded.kind, title=excluded.title, body=excluded.body, project=excluded.project,
      workspace_root=excluded.workspace_root, updated_at=excluded.updated_at,
      source_ref=excluded.source_ref, content_hash=excluded.content_hash, schema=excluded.schema
  `).run(
    doc.recordId, doc.kind, doc.title, doc.body, doc.project, doc.workspaceRoot,
    doc.updatedAt, doc.sourceRef, doc.contentHash, INDEX_SCHEMA,
  );
  for (const table of ['history_unicode_fts', 'history_trigram_fts']) {
    db.prepare(`delete from ${table} where record_id = ?`).run(doc.recordId);
    db.prepare(`insert into ${table} (record_id, title, body, project, workspace_root) values (?, ?, ?, ?, ?)`).run(
      doc.recordId, doc.title, doc.body, doc.project || '', doc.workspaceRoot || '',
    );
  }
  return true;
}

function pruneKind(db, kind, recordIds) {
  const expected = new Set(recordIds);
  const rows = db.prepare('select record_id as recordId from history_documents where kind = ?').all(kind);
  let removed = 0;
  for (const row of rows) {
    if (expected.has(row.recordId)) continue;
    db.prepare('delete from history_documents where record_id = ?').run(row.recordId);
    db.prepare('delete from history_unicode_fts where record_id = ?').run(row.recordId);
    db.prepare('delete from history_trigram_fts where record_id = ?').run(row.recordId);
    removed += 1;
  }
  return removed;
}

function syncHistoryIndex() {
  const documents = listTasks({ limit: 200, type: 'work' }).map(semanticTaskDocument);
  const devspace = readDevSpaceSubagents();
  documents.push(...devspace.rows.map(semanticSubagentDocument));

  const db = ensureDb();
  let updated = 0;
  let removed = 0;
  try {
    db.exec('begin immediate');
    for (const doc of documents) if (upsertDocument(db, doc)) updated += 1;
    removed += pruneKind(db, 'work_task', documents.filter((doc) => doc.kind === 'work_task').map((doc) => doc.recordId));
    if (devspace.available) {
      removed += pruneKind(db, 'subagent', documents.filter((doc) => doc.kind === 'subagent').map((doc) => doc.recordId));
    }
    db.exec('commit');
    const count = Number(db.prepare('select count(*) as count from history_documents').get()?.count || 0);
    return {
      ok: true,
      databasePath: DB_PATH,
      documents: count,
      updated,
      removed,
      devspace: {
        available: devspace.available,
        databasePath: devspace.databasePath,
        error: devspace.error,
        indexed: devspace.rows.length,
      },
    };
  } catch (error) {
    try { db.exec('rollback'); } catch { /* ignore */ }
    throw error;
  } finally {
    db.close();
  }
}

function ftsLiteral(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function codePointLength(value) {
  return [...String(value)].length;
}

function normalizeKinds(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  const aliases = { task: 'work_task', work: 'work_task', agent: 'subagent' };
  const result = values.flatMap((entry) => String(entry).split(',')).map((entry) => entry.trim().toLowerCase()).filter(Boolean)
    .map((entry) => aliases[entry] || entry);
  const allowed = new Set(['work_task', 'subagent']);
  for (const kind of result) if (!allowed.has(kind)) throw new Error(`Unknown history kind: ${kind}`);
  return [...new Set(result)];
}

function searchHistory(input = {}) {
  const query = String(input.query || input.q || '').trim();
  if (!query) throw new Error('query is required.');
  const limit = Math.max(1, Math.min(Number(input.limit || DEFAULT_LIMIT) || DEFAULT_LIMIT, MAX_LIMIT));
  const kinds = normalizeKinds(input.kind || input.kinds);
  const workspaceRoot = input.workspaceRoot ? String(input.workspaceRoot).trim() : null;
  const sync = input.sync !== false && String(input.sync || 'true').toLowerCase() !== 'false';
  const syncResult = sync ? syncHistoryIndex() : null;

  const db = ensureDb();
  try {
    const candidates = new Map();
    const addRows = (rows, source) => {
      for (const row of rows) {
        const key = row.recordId;
        const existing = candidates.get(key);
        const rank = Number.isFinite(Number(row.rank)) ? Number(row.rank) : 1000;
        if (!existing || rank < existing.rank) candidates.set(key, { ...row, rank, source });
      }
    };

    const literal = ftsLiteral(query);
    const tables = codePointLength(query) >= 3
      ? ['history_trigram_fts', 'history_unicode_fts']
      : ['history_unicode_fts'];
    for (const table of tables) {
      try {
        addRows(db.prepare(`
          select f.record_id as recordId, bm25(${table}) as rank
          from ${table} f
          where ${table} match ?
          limit ?
        `).all(literal, Math.min(limit * 5, 500)), table);
      } catch { /* fallback below covers tokenizer edge cases */ }
    }

    if (candidates.size < limit) {
      const like = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      addRows(db.prepare(`
        select record_id as recordId, 500.0 as rank
        from history_documents
        where title like ? escape '\\' or body like ? escape '\\'
        order by updated_at desc
        limit ?
      `).all(like, like, Math.min(limit * 5, 500)), 'like');
    }

    const results = [];
    const getDoc = db.prepare(`
      select record_id as recordId, kind, title, body, project, workspace_root as workspaceRoot,
             updated_at as updatedAt, source_ref as sourceRef
      from history_documents where record_id = ?
    `);
    for (const candidate of [...candidates.values()].sort((a, b) => a.rank - b.rank)) {
      const doc = getDoc.get(candidate.recordId);
      if (!doc) continue;
      if (kinds.length > 0 && !kinds.includes(doc.kind)) continue;
      if (workspaceRoot && path.resolve(doc.workspaceRoot || '') !== path.resolve(workspaceRoot)) continue;
      results.push({
        kind: doc.kind,
        id: doc.sourceRef,
        title: doc.title,
        project: doc.project,
        workspaceRoot: doc.workspaceRoot,
        updatedAt: doc.updatedAt,
        snippet: makeSnippet(doc.body, query),
        score: candidate.rank,
        match: candidate.source,
      });
      if (results.length >= limit) break;
    }
    return { ok: true, query, kinds, results, sync: syncResult };
  } finally {
    db.close();
  }
}

function makeSnippet(body, query, radius = 180) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  const lower = text.toLocaleLowerCase();
  const needle = String(query).toLocaleLowerCase();
  const index = lower.indexOf(needle);
  if (index < 0) return sanitizeLogText(text, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + needle.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function historyStatus() {
  if (!fs.existsSync(DB_PATH)) return { ok: true, databasePath: DB_PATH, exists: false, documents: 0 };
  const db = ensureDb();
  try {
    const documents = Number(db.prepare('select count(*) as count from history_documents').get()?.count || 0);
    const counts = Object.fromEntries(db.prepare('select kind, count(*) as count from history_documents group by kind').all()
      .map((row) => [row.kind, Number(row.count)]));
    return { ok: true, databasePath: DB_PATH, exists: true, documents, counts };
  } finally {
    db.close();
  }
}

module.exports = {
  DB_PATH,
  syncHistoryIndex,
  searchHistory,
  historyStatus,
  semanticTaskDocument,
  semanticSubagentDocument,
};
