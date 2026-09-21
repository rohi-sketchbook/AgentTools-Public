import { execFile } from "node:child_process";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { Backend, BackendExecutionContext, BackendRequest, BackendResult } from "../contracts.ts";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 18_000;
const BRIDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AUTODEV_GATEWAY_ROOT = path.resolve(BRIDGE_ROOT, "..", "..", "agenttools-mcp-gateway");
const AUTODEV_CLI = path.join(AUTODEV_GATEWAY_ROOT, "src", "cli.js");
const TERMINAL_AUTODEV_STATUSES = new Set(["completed", "resolved", "cancelled"]);

type AutoDevIssuesRunner = () => Promise<string>;

function trimOutput(value: string): string {
  return value.length <= MAX_OUTPUT ? value : `${value.slice(0, MAX_OUTPUT)}\n... (省略)`;
}

async function canonicalPath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

function normalizeLocalCommand(text: string): string | null {
  const value = text.trim().replace(/^\/(?:local)\s*/i, "").replace(/^@local\s*/i, "").trim();
  const lower = value.toLowerCase();

  if (["status", "bot status", "bot状態", "状態"].includes(lower) || /bot.{0,4}状態/i.test(value)) return "status";
  if (["pwd", "where", "現在地", "作業場所"].includes(lower) || /(?:pwd|現在地|作業場所).{0,8}(?:教えて|表示|見せて)/i.test(value)) return "pwd";
  if (["ls", "dir", "files", "ファイル一覧", "フォルダ一覧"].includes(lower) || /(?:ls|dir|ファイル一覧|フォルダ一覧).{0,8}(?:して|表示|見せて)?$/i.test(value)) return "ls";
  if (/^git\s+status$/i.test(value) || /git.{0,4}状態/i.test(value) || /git\s+status.{0,12}(?:見せて|表示|確認|教えて)/i.test(value)) return "git-status";
  if (/^git\s+diff$/i.test(value) || /git.{0,4}差分/i.test(value) || /git\s+diff.{0,12}(?:見せて|表示|確認|教えて)/i.test(value)) return "git-diff";
  if (["log", "logs", "ログ", "ログ表示"].includes(lower) || /(?:ログ|log).{0,8}(?:見せて|表示|一覧)/i.test(value)) return "log";
  if (["build-status", "build status", "ビルド状態"].includes(lower) || /ビルド.{0,4}状態/i.test(value)) return "build-status";
  if (["autodev list", "autodev queue", "課題キュー", "課題キュー一覧"].includes(lower) || /(?:autodev|課題キュー).{0,8}(?:list|一覧|表示)/i.test(value)) return "autodev-list";
  return null;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
    });
    return trimOutput([stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n")) || "（出力なし）";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Gitコマンドを実行できませんでした: ${message}`;
  }
}

async function listDirectory(cwd: string): Promise<string> {
  const entries = await readdir(cwd, { withFileTypes: true });
  const rows = entries
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "ja"))
    .slice(0, 200)
    .map((entry) => `${entry.isDirectory() ? "[D]" : "[F]"} ${entry.name}`);
  return rows.length > 0 ? rows.join("\n") : "（空のフォルダ）";
}

async function recentLogs(cwd: string): Promise<string> {
  const candidates: Array<{ filePath: string; modified: number }> = [];
  const skippedDirs = new Set([".git", "node_modules", "Library", "Temp", "obj", "bin"]);

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3 || candidates.length > 200) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory() && !skippedDirs.has(entry.name)) {
        await walk(filePath, depth + 1);
      } else if (entry.isFile() && /\.(?:log|txt)$/i.test(entry.name)) {
        try {
          candidates.push({ filePath, modified: (await stat(filePath)).mtimeMs });
        } catch {
          // Ignore files that disappear while scanning.
        }
      }
      if (candidates.length > 200) break;
    }
  }

  await walk(cwd, 0);
  candidates.sort((a, b) => b.modified - a.modified);
  const latest = candidates[0];
  if (!latest) return "workspace内（深さ3まで）にログ候補はありません。";

  const handle = await open(latest.filePath, "r");
  try {
    const info = await handle.stat();
    const maxBytes = 16 * 1024;
    const length = Math.min(maxBytes, info.size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, info.size - length));
    return `Log: ${path.relative(cwd, latest.filePath)}\n\n${buffer.toString("utf8")}`;
  } finally {
    await handle.close();
  }
}

async function runAutoDevIssuesCli(): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [AUTODEV_CLI, "autodev", "issues"], {
    cwd: AUTODEV_GATEWAY_ROOT,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout;
}

function formatAutoDevQueue(raw: string): string {
  const payload = JSON.parse(raw) as {
    ok?: boolean;
    error?: string;
    issues?: Array<Record<string, unknown>>;
  };
  if (!payload.ok) throw new Error(payload.error || "Gateway CLIが課題一覧の取得に失敗しました。");

  const queued = (payload.issues ?? []).filter((issue) => !TERMINAL_AUTODEV_STATUSES.has(String(issue.status ?? "")));
  if (queued.length === 0) return "Avatar Dev Loop課題キュー: 0件";

  const rows = queued.map((issue, index) => {
    const claim = issue.claimId ? `claimed:${String(issue.assignedTo ?? "unknown")}` : "未claim";
    return [
      `${index + 1}. ${String(issue.id ?? "(idなし)")} [${String(issue.status ?? "unknown")}]`,
      `   ${String(issue.title ?? issue.detail ?? "(タイトルなし)")}`,
      `   risk=${String(issue.risk ?? "unknown")} origin=${String(issue.origin ?? "unknown")} requestMode=${String(issue.requestMode ?? "-")} ${claim}`,
    ].join("\n");
  });
  return trimOutput(`Avatar Dev Loop課題キュー: ${queued.length}件\n\n${rows.join("\n\n")}`);
}

async function buildStatus(cwd: string): Promise<string> {
  const common = ["Build", "Builds", "dist", "out", "bin"];
  const found: string[] = [];
  for (const name of common) {
    try {
      const info = await stat(path.join(cwd, name));
      if (info.isDirectory()) {
        found.push(`${name}: 存在 / 更新 ${info.mtime.toLocaleString("ja-JP")}`);
      }
    } catch {
      // Presence check only.
    }
  }
  return found.length > 0 ? found.join("\n") : "既定のビルド出力フォルダ（Build/Builds/dist/out/bin）は見つかりません。";
}

export class LocalBackend implements Backend {
  readonly id = "local" as const;
  readonly displayName = "Local Command";
  readonly capabilities = { read: true, git: true, localOnly: true } as const;

  constructor(private readonly autoDevIssuesRunner: AutoDevIssuesRunner = runAutoDevIssuesCli) {}

  async execute(request: BackendRequest, _context: BackendExecutionContext): Promise<BackendResult> {
    const workspaceRoot = await canonicalPath(request.workspaceRoot ?? request.cwd ?? process.cwd());
    const cwd = await canonicalPath(request.cwd ?? workspaceRoot);
    const relative = path.relative(workspaceRoot, cwd);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return {
        status: "failed",
        backendId: this.id,
        error: "Local Modeの作業場所がworkspaceRoot外を指しています。",
      };
    }
    const command = normalizeLocalCommand(request.text);
    if (!command) {
      return {
        status: "failed",
        backendId: this.id,
        error: "Local Modeでは許可済みコマンドのみ実行できます。status / ls / pwd / git status / git diff / log / build-status / autodev list を使用してください。",
      };
    }

    try {
      let text: string;
      switch (command) {
        case "status":
          text = `Local Bridge: OK\nPID: ${process.pid}\nNode: ${process.version}\nCWD: ${cwd}\nAI使用: なし`;
          break;
        case "pwd":
          text = cwd;
          break;
        case "ls":
          text = await listDirectory(cwd);
          break;
        case "git-status":
          text = await runGit(cwd, ["status", "--short", "--branch"]);
          break;
        case "git-diff":
          text = await runGit(cwd, ["diff", "--no-ext-diff", "--"]);
          break;
        case "log":
          text = await recentLogs(cwd);
          break;
        case "build-status":
          text = await buildStatus(cwd);
          break;
        case "autodev-list":
          text = formatAutoDevQueue(await this.autoDevIssuesRunner());
          break;
      }
      return { status: "completed", backendId: this.id, text };
    } catch (error) {
      return {
        status: "failed",
        backendId: this.id,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async status() {
    return { available: true, detail: "AIを使用しないAllowlistローカル処理" };
  }
}
