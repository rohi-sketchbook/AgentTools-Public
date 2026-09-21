import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONNECTOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENTTOOLS_ROOT = path.resolve(CONNECTOR_ROOT, "..", "..");
const DEFAULT_DEVLOG_PIPELINE_SCRIPT = path.join(
  AGENTTOOLS_ROOT,
  "devlog-codex-runner",
  "start-devlog-pipeline.mjs",
);

export interface DevlogPipelineCompletionResult {
  succeeded: boolean;
  exitCode: number;
  stage: string;
  published: boolean;
  launcherLogPath: string;
}

export interface DevlogPipelineStartResult {
  pid: number;
  scriptPath: string;
  startedAt: string;
  completion: Promise<DevlogPipelineCompletionResult>;
}

export function resolveDevlogPipelineScriptPath(
  configuredPath = process.env.DEVLOG_PIPELINE_SCRIPT,
): string {
  const candidate = configuredPath?.trim();
  return path.resolve(candidate || DEFAULT_DEVLOG_PIPELINE_SCRIPT);
}

function jstDateString(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function parseDevlogCompletionLine(text: string): Omit<DevlogPipelineCompletionResult, "launcherLogPath"> | null {
  const matches = [...text.matchAll(/DEVLOG_PIPELINE_FINISHED DATE=\d{4}-\d{2}-\d{2} EXIT=(\d+) STAGE=([^\s]+) PUBLISHED=(true|false)/g)];
  const match = matches.at(-1);
  if (!match) return null;
  const exitCode = Number.parseInt(match[1], 10);
  const stage = match[2];
  const published = match[3] === "true";
  return {
    succeeded: exitCode === 0 && stage === "published" && published,
    exitCode,
    stage,
    published,
  };
}

async function waitForPipelineStart(
  logRoot: string,
  runDate: string,
  previousRunDirectories: Set<string>,
  previousLauncherLogs: Set<string>,
): Promise<string> {
  const launcherRoot = path.join(logRoot, "launcher");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const runEntries = await readdir(logRoot, { withFileTypes: true }).catch(() => []);
    const launcherEntries = await readdir(launcherRoot, { withFileTypes: true }).catch(() => []);
    const runStarted = runEntries.some(
      (entry) => entry.isDirectory() && entry.name.startsWith(`${runDate}-`) && !previousRunDirectories.has(entry.name),
    );
    const launcherLog = launcherEntries.find(
      (entry) => entry.isFile() && entry.name.startsWith(`${runDate}-`) && !previousLauncherLogs.has(entry.name),
    );
    if (runStarted && launcherLog) return path.join(launcherRoot, launcherLog.name);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`開発日記本体の起動確認に失敗しました。${runDate} の実行ログまたはランチャーログが生成されていません。`);
}

async function waitForPipelineCompletion(launcherLogPath: string): Promise<DevlogPipelineCompletionResult> {
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const text = await readFile(launcherLogPath, "utf8").catch(() => "");
    const completion = parseDevlogCompletionLine(text);
    if (completion) return { ...completion, launcherLogPath };
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`開発日記パイプラインが2時間以内に完了しませんでした。ログ: ${launcherLogPath}`);
}

export async function startDevlogPipeline(input: {
  scriptPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
} = {}): Promise<DevlogPipelineStartResult> {
  const scriptPath = resolveDevlogPipelineScriptPath(input.scriptPath);
  await access(scriptPath, constants.R_OK);
  const logRoot = path.join(path.dirname(scriptPath), "logs");
  const runDate = jstDateString(input.now);
  const previousRunDirectories = new Set((await readdir(logRoot, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name));
  const launcherRoot = path.join(logRoot, "launcher");
  const previousLauncherLogs = new Set((await readdir(launcherRoot, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name));

  const child = spawn(process.execPath, [scriptPath], {
    cwd: path.dirname(scriptPath),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: input.env ?? process.env,
  });

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  const pid = child.pid;
  if (!pid) {
    child.kill();
    throw new Error("開発日記ランナーのPIDを取得できませんでした。");
  }

  child.unref();
  const launcherLogPath = await waitForPipelineStart(
    logRoot,
    runDate,
    previousRunDirectories,
    previousLauncherLogs,
  );
  return {
    pid,
    scriptPath,
    startedAt: new Date().toISOString(),
    completion: waitForPipelineCompletion(launcherLogPath),
  };
}
