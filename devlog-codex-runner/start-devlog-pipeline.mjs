import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runnerRoot = path.dirname(fileURLToPath(import.meta.url));
const runnerScript = path.join(runnerRoot, "run-devlog-pipeline.mjs");
const args = [runnerScript, "--report"];

const dateIndex = process.argv.indexOf("--date");
const requestedDate = dateIndex >= 0 && process.argv[dateIndex + 1]
  ? process.argv[dateIndex + 1]
  : null;
if (requestedDate) {
  args.push("--date", requestedDate);
}

const now = new Date();
const timestamp = now.toISOString().replace(/[:.]/g, "-");
const runDate = requestedDate ?? new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(now);
const launcherLogDirectory = path.join(runnerRoot, "logs", "launcher");
mkdirSync(launcherLogDirectory, { recursive: true });
const launcherLogPath = path.join(
  launcherLogDirectory,
  `${runDate}-${timestamp}.log`,
);
const logFd = openSync(launcherLogPath, "a");

writeSync(logFd, [
  `[${now.toISOString()}] Starting devlog pipeline`,
  `node=${process.execPath}`,
  `script=${runnerScript}`,
  `args=${JSON.stringify(args.slice(1))}`,
  "",
].join("\n"));

let child;
try {
  child = spawn(process.execPath, args, {
    cwd: runnerRoot,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });

  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeSync(logFd, `[${new Date().toISOString()}] Launcher spawn failed\n${message}\n`);
  closeSync(logFd);
  console.error(`DEVLOG_PIPELINE_START_FAILED LOG=${launcherLogPath}`);
  process.exitCode = 1;
  throw error;
}

const pid = child.pid;
writeSync(logFd, `[${new Date().toISOString()}] Child spawned pid=${pid ?? "unknown"}\n`);
closeSync(logFd);
child.unref();
console.log(`DEVLOG_PIPELINE_STARTED PID=${pid ?? "unknown"} LOG=${launcherLogPath}`);
