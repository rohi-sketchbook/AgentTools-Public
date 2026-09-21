import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SQLITE_SEPARATOR = "\u001f";

export interface CodexSessionIndexEntry {
  id: string;
  threadName: string;
  updatedAt: string;
}

export interface CodexSessionMeta {
  id: string;
  cwd: string;
}

export interface DiscoveredCodexSession extends CodexSessionIndexEntry {
  cwdHint: string | null;
  contextPreview?: CodexSessionContextMessage[];
  realtimeEvents?: CodexSessionRealtimeEvent[];
}

export interface DiscoverCodexSessionsOptions {
  activeOnly?: boolean;
  includeArchived?: boolean;
  includeSubAgents?: boolean;
  includeExecSessions?: boolean;
  includeSessionIds?: string[];
  onlySessionIds?: string[];
  includeContextPreview?: boolean;
  includeRealtimeEvents?: boolean;
  contextMessageLimit?: number;
  contextMessageMaxChars?: number;
  realtimeEventLimit?: number;
}

export interface CodexSessionContextMessage {
  role: "user" | "assistant";
  text: string;
}

export interface CodexSessionRealtimeEvent {
  key: string;
  kind: "user" | "assistant" | "status";
  text: string;
}

interface CodexThreadState {
  archived: boolean;
  source: string | null;
  isSubAgent: boolean;
}

interface SessionDetailsResult {
  cwdHint: string | null;
  contextPreview?: CodexSessionContextMessage[];
  realtimeEvents?: CodexSessionRealtimeEvent[];
}

interface CachedSessionDetails extends SessionDetailsResult {
  size: number;
  mtimeMs: number;
  optionsKey: string;
  pendingFragment: string;
}

const SESSION_HEAD_BYTES = 64 * 1024;
const SESSION_TAIL_INITIAL_BYTES = 512 * 1024;
const SESSION_TAIL_MAX_BYTES = 8 * 1024 * 1024;
const SESSION_INCREMENTAL_MAX_BYTES = 2 * 1024 * 1024;
const sessionDetailsCache = new Map<string, CachedSessionDetails>();
const sessionFilePathCache = new Map<string, string>();
const missingSessionFileCache = new Map<string, number>();
const MISSING_SESSION_FILE_RESCAN_MS = 30_000;

export function parseSessionIndexLine(line: string): CodexSessionIndexEntry {
  const parsed = JSON.parse(line) as { id?: string; thread_name?: string; updated_at?: string };

  if (!parsed.id || !parsed.thread_name || !parsed.updated_at) {
    throw new Error("Invalid Codex session index line");
  }

  return {
    id: parsed.id,
    threadName: parsed.thread_name,
    updatedAt: parsed.updated_at,
  };
}

export function parseSessionMetaLine(line: string): CodexSessionMeta | null {
  let parsed: {
    type?: string;
    payload?: { id?: string; cwd?: string };
  };

  try {
    parsed = JSON.parse(line) as {
      type?: string;
      payload?: { id?: string; cwd?: string };
    };
  } catch {
    return null;
  }

  if (parsed.type !== "session_meta" || !parsed.payload?.id || !parsed.payload.cwd) {
    return null;
  }

  return {
    id: parsed.payload.id,
    cwd: parsed.payload.cwd,
  };
}

export async function getCodexSessionChangeToken(codexHome: string, sessionIds: string[]): Promise<string> {
  const uniqueSessionIds = [...new Set(sessionIds.filter(Boolean))].sort();
  if (uniqueSessionIds.length === 0) {
    return "";
  }

  const sessionFilesById = await buildSessionFileIndexForIds(
    path.join(codexHome, "sessions"),
    new Set(uniqueSessionIds),
  );
  const parts: string[] = [];

  for (const sessionId of uniqueSessionIds) {
    const sessionFile = sessionFilesById.get(sessionId);
    if (!sessionFile) {
      parts.push(`${sessionId}:missing`);
      continue;
    }

    const stat = await statIfExists(sessionFile);
    parts.push(stat ? `${sessionId}:${stat.size}:${stat.mtimeMs}` : `${sessionId}:missing`);
  }

  return parts.join("|");
}

export async function discoverCodexSessions(
  codexHome: string,
  options: DiscoverCodexSessionsOptions = {},
): Promise<DiscoveredCodexSession[]> {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  const indexText = await readTextIfExists(indexPath);
  const onlySessionIds = [...new Set((options.onlySessionIds ?? []).filter(Boolean))];

  if (onlySessionIds.length > 0) {
    return discoverOnlyCodexSessions(codexHome, indexText, onlySessionIds, options);
  }

  if (indexText === null && (!options.includeSessionIds || options.includeSessionIds.length === 0)) {
    return [];
  }

  const [sessionFilesById, archivedSessionIds, threadStates] = await Promise.all([
    buildSessionFileIndex(path.join(codexHome, "sessions")),
    buildArchivedSessionIds(path.join(codexHome, "archived_sessions")),
    readCodexThreadStates(codexHome),
  ]);
  const entries: CodexSessionIndexEntry[] = [];

  for (const line of (indexText ?? "").split("\n").filter(Boolean)) {
    try {
      entries.push(parseSessionIndexLine(line));
    } catch {
      continue;
    }
  }

  entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const visibleEntries = entries.filter((entry) =>
    shouldIncludeSession(entry.id, {
      archivedSessionIds,
      threadState: threadStates.get(entry.id) ?? null,
      threadStateAvailable: threadStates.size > 0,
      options,
    }),
  );
  const visibleIds = new Set(visibleEntries.map((entry) => entry.id));
  const explicitEntries: CodexSessionIndexEntry[] = [];

  for (const sessionId of options.includeSessionIds ?? []) {
    if (visibleIds.has(sessionId) || archivedSessionIds.has(sessionId)) {
      continue;
    }

    const sessionFile = sessionFilesById.get(sessionId);

    if (!sessionFile) {
      continue;
    }

    explicitEntries.push(await fallbackSessionIndexEntry(sessionFile, sessionId));
    visibleIds.add(sessionId);
  }

  return Promise.all(
    [...visibleEntries, ...explicitEntries].map(async (entry) => {
      const details = await findSessionDetails(sessionFilesById, entry.id, options);
      return {
        ...entry,
        cwdHint: details.cwdHint,
        ...(details.contextPreview ? { contextPreview: details.contextPreview } : {}),
        ...(details.realtimeEvents ? { realtimeEvents: details.realtimeEvents } : {}),
      };
    }),
  );
}

async function discoverOnlyCodexSessions(
  codexHome: string,
  indexText: string | null,
  onlySessionIds: string[],
  options: DiscoverCodexSessionsOptions,
): Promise<DiscoveredCodexSession[]> {
  const requestedIds = new Set(onlySessionIds);
  const sessionFilesById = await buildSessionFileIndexForIds(path.join(codexHome, "sessions"), requestedIds);
  const entriesById = new Map<string, CodexSessionIndexEntry>();

  for (const line of (indexText ?? "").split("\n").filter(Boolean)) {
    try {
      const entry = parseSessionIndexLine(line);
      if (requestedIds.has(entry.id) && sessionFilesById.has(entry.id)) {
        entriesById.set(entry.id, entry);
      }
    } catch {
      continue;
    }
  }

  for (const sessionId of onlySessionIds) {
    if (entriesById.has(sessionId)) {
      continue;
    }

    const sessionFile = sessionFilesById.get(sessionId);
    if (sessionFile) {
      entriesById.set(sessionId, await fallbackSessionIndexEntry(sessionFile, sessionId));
    }
  }

  const entries = [...entriesById.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return Promise.all(
    entries.map(async (entry) => {
      const details = await findSessionDetails(sessionFilesById, entry.id, options);
      return {
        ...entry,
        cwdHint: details.cwdHint,
        ...(details.contextPreview ? { contextPreview: details.contextPreview } : {}),
        ...(details.realtimeEvents ? { realtimeEvents: details.realtimeEvents } : {}),
      };
    }),
  );
}

async function fallbackSessionIndexEntry(sessionFile: string, sessionId: string): Promise<CodexSessionIndexEntry> {
  const text = (await readTextIfExists(sessionFile)) ?? "";
  const timestamps = text
    .split("\n")
    .map((line) => parseLineTimestamp(line))
    .filter((timestamp): timestamp is string => timestamp !== null);
  const contextPreview = parseSessionContextPreview(text, {
    messageLimit: 1,
    messageMaxChars: 80,
  });
  const firstMessage = contextPreview[0]?.text.split("\n")[0]?.trim();

  return {
    id: sessionId,
    threadName: firstMessage || `Codex session ${sessionId.slice(0, 8)}`,
    updatedAt: timestamps.at(-1) ?? new Date(0).toISOString(),
  };
}

function parseLineTimestamp(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as { timestamp?: unknown };
    return typeof parsed.timestamp === "string" && parsed.timestamp.length > 0 ? parsed.timestamp : null;
  } catch {
    return null;
  }
}

function shouldIncludeSession(
  sessionId: string,
  input: {
    archivedSessionIds: Set<string>;
    threadState: CodexThreadState | null;
    threadStateAvailable: boolean;
    options: DiscoverCodexSessionsOptions;
  },
): boolean {
  if (input.options.activeOnly) {
    if (input.archivedSessionIds.has(sessionId) || !input.threadState) {
      return false;
    }

    return isActiveThreadState(input.threadState);
  }

  if (!input.options.includeArchived && input.archivedSessionIds.has(sessionId)) {
    return false;
  }

  if (!input.threadState) {
    if (input.threadStateAvailable) {
      return false;
    }

    return true;
  }

  if (!input.options.includeArchived && input.threadState.archived) {
    return false;
  }

  if (!input.options.includeSubAgents && input.threadState.isSubAgent) {
    return false;
  }

  if (!input.options.includeExecSessions && isNonInteractiveThreadSource(input.threadState.source)) {
    return false;
  }

  return true;
}

function isActiveThreadState(threadState: CodexThreadState): boolean {
  return (
    !threadState.archived &&
    !threadState.isSubAgent &&
    !isNonInteractiveThreadSource(threadState.source)
  );
}

function isNonInteractiveThreadSource(source: string | null): boolean {
  return source === "exec" || source === "cli";
}

async function findSessionDetails(
  sessionFilesById: Map<string, string>,
  sessionId: string,
  options: DiscoverCodexSessionsOptions,
): Promise<SessionDetailsResult> {
  const sessionFile = sessionFilesById.get(sessionId);

  if (!sessionFile) {
    return { cwdHint: null };
  }

  const stat = await statIfExists(sessionFile);
  if (!stat) {
    sessionDetailsCache.delete(sessionFile);
    return { cwdHint: null };
  }

  const optionsKey = sessionDetailsOptionsKey(options);
  const cached = sessionDetailsCache.get(sessionFile);

  if (cached && cached.optionsKey === optionsKey) {
    if (cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached;
    }

    const appendedBytes = stat.size - cached.size;
    if (appendedBytes > 0 && appendedBytes <= SESSION_INCREMENTAL_MAX_BYTES) {
      const appendedText = await readTextRange(sessionFile, cached.size, appendedBytes);
      const combined = `${cached.pendingFragment}${appendedText}`;
      const lines = combined.split("\n");
      const pendingFragment = combined.endsWith("\n") ? "" : (lines.pop() ?? "");
      const contextPreview = [...(cached.contextPreview ?? [])];
      const realtimeEvents = [...(cached.realtimeEvents ?? [])];
      const contextLimit = Math.max(1, options.contextMessageLimit ?? 6);
      const eventLimit = Math.max(1, options.realtimeEventLimit ?? 30);
      const messageMaxChars = options.contextMessageMaxChars ?? 1_000;

      for (const line of lines.filter(Boolean)) {
        if (options.includeContextPreview) {
          const message = parseContextMessageLine(line, messageMaxChars);
          if (message) {
            contextPreview.push(message);
          }
        }

        if (options.includeRealtimeEvents) {
          const event = parseRealtimeEventLine(line, messageMaxChars);
          if (event) {
            realtimeEvents.push(event);
          }
        }
      }

      const next: CachedSessionDetails = {
        cwdHint: cached.cwdHint,
        ...(options.includeContextPreview ? { contextPreview: contextPreview.slice(-contextLimit) } : {}),
        ...(options.includeRealtimeEvents ? { realtimeEvents: realtimeEvents.slice(-eventLimit) } : {}),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        optionsKey,
        pendingFragment,
      };
      sessionDetailsCache.set(sessionFile, next);
      return next;
    }
  }

  const headText = await readTextRange(sessionFile, 0, Math.min(stat.size, SESSION_HEAD_BYTES));
  let cwdHint: string | null = null;

  for (const line of headText.split("\n").filter(Boolean)) {
    const meta = parseSessionMetaLine(line);
    if (meta?.id === sessionId) {
      cwdHint = meta.cwd;
      break;
    }
  }

  const detailWindow = await readSessionDetailWindow(sessionFile, stat.size, options);
  const next: CachedSessionDetails = {
    cwdHint,
    ...detailWindow,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    optionsKey,
    pendingFragment: detailWindow.pendingFragment,
  };
  sessionDetailsCache.set(sessionFile, next);
  return next;
}

function sessionDetailsOptionsKey(options: DiscoverCodexSessionsOptions): string {
  return [
    options.includeContextPreview ? 1 : 0,
    options.includeRealtimeEvents ? 1 : 0,
    options.contextMessageLimit ?? 6,
    options.contextMessageMaxChars ?? 1_000,
    options.realtimeEventLimit ?? 30,
  ].join(":");
}

async function readSessionDetailWindow(
  sessionFile: string,
  fileSize: number,
  options: DiscoverCodexSessionsOptions,
): Promise<{
  contextPreview?: CodexSessionContextMessage[];
  realtimeEvents?: CodexSessionRealtimeEvent[];
  pendingFragment: string;
}> {
  const contextLimit = Math.max(1, options.contextMessageLimit ?? 6);
  const eventLimit = Math.max(1, options.realtimeEventLimit ?? 30);
  const messageMaxChars = options.contextMessageMaxChars ?? 1_000;
  let windowBytes = Math.min(fileSize, SESSION_TAIL_INITIAL_BYTES);

  while (true) {
    const start = Math.max(0, fileSize - windowBytes);
    let text = await readTextRange(sessionFile, start, windowBytes);

    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }

    const lines = text.split("\n");
    const pendingFragment = text.endsWith("\n") ? "" : (lines.pop() ?? "");
    const completeText = lines.join("\n");
    const contextPreview = options.includeContextPreview
      ? parseSessionContextPreview(completeText, { messageLimit: contextLimit, messageMaxChars })
      : undefined;
    const realtimeEvents = options.includeRealtimeEvents
      ? parseSessionRealtimeEvents(completeText, { eventLimit, messageMaxChars })
      : undefined;
    const enoughContext = !options.includeContextPreview || (contextPreview?.length ?? 0) >= contextLimit;
    const enoughEvents = !options.includeRealtimeEvents || (realtimeEvents?.length ?? 0) >= eventLimit;
    const maxWindow = Math.min(fileSize, SESSION_TAIL_MAX_BYTES);

    if (start === 0 || (enoughContext && enoughEvents) || windowBytes >= maxWindow) {
      return {
        ...(contextPreview ? { contextPreview } : {}),
        ...(realtimeEvents ? { realtimeEvents } : {}),
        pendingFragment,
      };
    }

    windowBytes = Math.min(maxWindow, windowBytes * 2);
  }
}

async function readTextRange(filePath: string, position: number, length: number): Promise<string> {
  if (length <= 0) {
    return "";
  }

  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function statIfExists(filePath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (isEnoent(error)) {
      return null;
    }
    throw error;
  }
}

async function buildSessionFileIndexForIds(root: string, sessionIds: Set<string>): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const remaining = new Set(sessionIds);
  const now = Date.now();

  for (const sessionId of sessionIds) {
    const cacheKey = `${root}\0${sessionId}`;
    const cachedPath = sessionFilePathCache.get(cacheKey);
    if (cachedPath) {
      if (await statIfExists(cachedPath)) {
        result.set(sessionId, cachedPath);
        remaining.delete(sessionId);
        missingSessionFileCache.delete(cacheKey);
        continue;
      }

      sessionFilePathCache.delete(cacheKey);
    }

    const retryAfter = missingSessionFileCache.get(cacheKey) ?? 0;
    if (retryAfter > now) {
      remaining.delete(sessionId);
    } else if (retryAfter > 0) {
      missingSessionFileCache.delete(cacheKey);
    }
  }

  if (remaining.size === 0) {
    return result;
  }

  const directories = [root];
  while (directories.length > 0 && remaining.size > 0) {
    const directory = directories.pop();
    if (!directory) {
      break;
    }

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) {
        continue;
      }
      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      for (const sessionId of remaining) {
        if (!entry.name.toLowerCase().includes(sessionId.toLowerCase())) {
          continue;
        }

        result.set(sessionId, fullPath);
        const cacheKey = `${root}\0${sessionId}`;
        sessionFilePathCache.set(cacheKey, fullPath);
        missingSessionFileCache.delete(cacheKey);
        remaining.delete(sessionId);
        break;
      }
    }
  }

  const retryAfter = Date.now() + MISSING_SESSION_FILE_RESCAN_MS;
  for (const sessionId of remaining) {
    missingSessionFileCache.set(`${root}\0${sessionId}`, retryAfter);
  }

  return result;
}

async function buildSessionFileIndex(root: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const files = await listJsonlFiles(root);

  for (const file of files) {
    const match = path.basename(file).match(/^.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    if (match) {
      index.set(match[1], file);
    }
  }

  return index;
}

async function buildArchivedSessionIds(root: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const files = await listJsonlFiles(root);

  for (const file of files) {
    const match = path.basename(file).match(/^.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    if (match) {
      ids.add(match[1]);
    }
  }

  return ids;
}

async function readCodexThreadStates(codexHome: string): Promise<Map<string, CodexThreadState>> {
  const databasePath = await findCodexStateDatabase(codexHome);

  if (!databasePath) {
    return new Map();
  }

  try {
    const { stdout } = await execFileAsync(
      "sqlite3",
      [
        databasePath,
        [
          `select 'thread' || char(31) || id || char(31) || archived || char(31) || source from threads;`,
          `select 'edge' || char(31) || child_thread_id from thread_spawn_edges;`,
        ].join("\n"),
      ],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );

    return parseCodexThreadStateRows(stdout);
  } catch {
    return new Map();
  }
}

function parseCodexThreadStateRows(stdout: string): Map<string, CodexThreadState> {
  const states = new Map<string, CodexThreadState>();

  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const fields = line.split(SQLITE_SEPARATOR);
    const rowType = fields[0];

    if (rowType === "thread") {
      const [, id, archived, source = ""] = fields;
      if (!id) {
        continue;
      }

      states.set(id, {
        archived: archived === "1",
        source,
        isSubAgent: source.trimStart().startsWith('{"subagent"'),
      });
      continue;
    }

    if (rowType === "edge") {
      const childThreadId = fields[1];
      if (!childThreadId) {
        continue;
      }

      const previous = states.get(childThreadId);
      states.set(childThreadId, {
        archived: previous?.archived ?? false,
        source: previous?.source ?? null,
        isSubAgent: true,
      });
    }
  }

  return states;
}

function parseSessionContextPreview(
  text: string,
  options: { messageLimit: number; messageMaxChars: number },
): CodexSessionContextMessage[] {
  const messages: CodexSessionContextMessage[] = [];

  for (const line of text.split("\n").filter(Boolean)) {
    const message = parseContextMessageLine(line, options.messageMaxChars);

    if (message) {
      messages.push(message);
    }
  }

  return messages.slice(-Math.max(1, options.messageLimit));
}

function parseSessionRealtimeEvents(
  text: string,
  options: { eventLimit: number; messageMaxChars: number },
): CodexSessionRealtimeEvent[] {
  const events: CodexSessionRealtimeEvent[] = [];

  for (const line of text.split("\n").filter(Boolean)) {
    const event = parseRealtimeEventLine(line, options.messageMaxChars);

    if (event) {
      events.push(event);
    }
  }

  return events.slice(-Math.max(1, options.eventLimit));
}

function parseContextMessageLine(line: string, messageMaxChars: number): CodexSessionContextMessage | null {
  let parsed: {
    type?: string;
    payload?: {
      type?: string;
      role?: string;
      phase?: string;
      content?: unknown;
    };
  };

  try {
    parsed = JSON.parse(line) as {
      type?: string;
      payload?: {
        type?: string;
        role?: string;
        phase?: string;
        content?: unknown;
      };
    };
  } catch {
    return null;
  }

  if (parsed.type !== "response_item" || parsed.payload?.type !== "message") {
    return null;
  }

  if (parsed.payload.role === "assistant" && parsed.payload.phase !== "final_answer") {
    return null;
  }

  if (parsed.payload.role !== "user" && parsed.payload.role !== "assistant") {
    return null;
  }

  const rawText = extractContentText(parsed.payload.content);
  const text =
    parsed.payload.role === "user"
      ? normalizeUserContextText(rawText)
      : normalizeContextText(rawText);

  if (!text) {
    return null;
  }

  return {
    role: parsed.payload.role,
    text: truncateContextText(text, messageMaxChars),
  };
}

function parseRealtimeEventLine(line: string, messageMaxChars: number): CodexSessionRealtimeEvent | null {
  let parsed:
    | {
        type?: string;
        payload?: {
          type?: string;
          role?: string;
          phase?: string;
          content?: unknown;
          name?: string;
          arguments?: unknown;
        };
      }
    | undefined;

  try {
    parsed = JSON.parse(line) as {
      type?: string;
      payload?: {
        type?: string;
        role?: string;
        phase?: string;
        content?: unknown;
        name?: string;
        arguments?: unknown;
      };
    };
  } catch {
    return null;
  }

  if (!parsed || !parsed.type || !parsed.payload) {
    return null;
  }

  if (parsed.type === "response_item" && parsed.payload.type === "message") {
    if (parsed.payload.role === "user") {
      const text = normalizeUserContextText(extractContentText(parsed.payload.content));

      return text
        ? {
            key: hashSessionEventLine(line),
            kind: "user",
            text: truncateContextText(text, messageMaxChars),
          }
        : null;
    }

    if (parsed.payload.role === "assistant") {
      const text = normalizeContextText(extractContentText(parsed.payload.content));

      return text
        ? {
            key: hashSessionEventLine(line),
            kind: "assistant",
            text: truncateContextText(text, messageMaxChars),
          }
        : null;
    }
  }

  if (
    parsed.type === "response_item" &&
    (parsed.payload.type === "function_call" || parsed.payload.type === "custom_tool_call")
  ) {
    const statusText = parseRealtimeStatusText({
      name: parsed.payload.name ?? "",
      arguments: parsed.payload.arguments,
    });

    return statusText
      ? {
          key: hashSessionEventLine(line),
          kind: "status",
          text: truncateContextText(statusText, messageMaxChars),
        }
      : null;
  }

  if (parsed.type === "event_msg" && parsed.payload.type === "task_started") {
    return {
      key: hashSessionEventLine(line),
      kind: "status",
      text: "작업 시작",
    };
  }

  if (parsed.type === "event_msg" && parsed.payload.type === "task_complete") {
    return {
      key: hashSessionEventLine(line),
      kind: "status",
      text: "작업 완료",
    };
  }

  return null;
}

function hashSessionEventLine(line: string): string {
  return createHash("sha1").update(line).digest("hex");
}

function parseRealtimeStatusText(input: { name: string; arguments: unknown }): string | null {
  const name = input.name.trim();
  const args = parseToolArguments(input.arguments);
  const searchable = `${name} ${args.command ?? ""}`.toLowerCase();

  if (
    searchable.includes("image") ||
    searchable.includes("imagegen") ||
    searchable.includes("generate_image") ||
    searchable.includes("dall-e")
  ) {
    return formatRealtimeStatus("이미지 생성 중", [args.command, name]);
  }

  if (
    searchable.includes("rg --files") ||
    searchable.includes("find ") ||
    searchable.includes("glob") ||
    searchable.includes("file_search")
  ) {
    return formatRealtimeStatus("파일 탐색 중", [args.command]);
  }

  if (searchable.includes("web_search") || searchable.includes("search_query")) {
    return formatRealtimeStatus("웹 검색 중", [args.command, name]);
  }

  if (searchable.includes("apply_patch") || searchable.includes("write") || searchable.includes("edit")) {
    return formatRealtimeStatus("파일 수정 중", [args.command, name]);
  }

  if (name === "exec_command" || searchable.includes("shell")) {
    return formatRealtimeStatus("명령 실행 중", [args.command, name === "exec_command" ? null : name]);
  }

  return name ? formatRealtimeStatus("도구 실행 중", [name, args.command]) : null;
}

function parseToolArguments(value: unknown): { command: string | null } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { command: null };
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const command = parsed.cmd ?? parsed.command ?? parsed.query ?? parsed.prompt;
    return {
      command: typeof command === "string" && command.trim().length > 0 ? normalizeRealtimeDetail(command) : null,
    };
  } catch {
    return { command: null };
  }
}

function normalizeRealtimeDetail(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function formatRealtimeStatus(label: string, parts: Array<string | null>): string {
  const detail = parts.filter((part): part is string => Boolean(part && part.trim().length > 0)).join(" · ");
  return detail.length > 0 ? `${label} · ${detail}` : label;
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (typeof item === "object" && item !== null && "text" in item) {
        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeUserContextText(value: string): string {
  const requestMarker = "## My request for Codex:";
  const markerIndex = value.indexOf(requestMarker);
  const requestText = markerIndex >= 0 ? value.slice(markerIndex + requestMarker.length) : value;
  const normalized = normalizeContextText(requestText);

  if (
    normalized.startsWith("# AGENTS.md instructions") ||
    normalized.startsWith("<environment_context>") ||
    normalized.startsWith("<permissions instructions>")
  ) {
    return "";
  }

  return normalized;
}

function normalizeContextText(value: string): string {
  return value
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function truncateContextText(value: string, maxChars: number): string {
  const limit = Math.max(120, maxChars);

  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 16).trimEnd()}\n... (truncated)`;
}

async function findCodexStateDatabase(codexHome: string): Promise<string | null> {
  let entries: import("node:fs").Dirent[];

  try {
    entries = await fs.readdir(codexHome, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) {
      return null;
    }

    throw error;
  }

  const candidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = entry.name.match(/^state_(\d+)\.sqlite$/);
      return match
        ? {
            version: Number.parseInt(match[1], 10),
            filePath: path.join(codexHome, entry.name),
          }
        : null;
    })
    .filter((candidate): candidate is { version: number; filePath: string } => candidate !== null)
    .sort((a, b) => b.version - a.version);

  return candidates[0]?.filePath ?? null;
}

async function listJsonlFiles(root: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];

  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }

    throw error;
  }

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return listJsonlFiles(fullPath);
      }

      return entry.isFile() && entry.name.endsWith(".jsonl") ? [fullPath] : [];
    }),
  );

  return nested.flat();
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return null;
    }

    throw error;
  }
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
