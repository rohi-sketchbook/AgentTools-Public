import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDevlogConfig } from "./config.mjs";

const runnerRoot = path.dirname(fileURLToPath(import.meta.url));
const {
  siteRoot,
  viewerRoot,
  referenceImage,
  pipelinePromptPath,
  bridgeRoot,
  loaderUri,
  gitHelperScript,
  pagesBaseUrl,
  codexModel,
  codexReasoningEffort,
} = loadDevlogConfig();
const statusSchemaPath = path.join(runnerRoot, "devlog-status.schema.json");
const logRoot = path.join(runnerRoot, "logs");
const lockPath = path.join(runnerRoot, ".devlog-pipeline.lock");
const reportToDiscord = process.argv.includes("--report");
const dryRun = process.argv.includes("--dry-run");

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : "";
}

function jstDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function timestampString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}-${values.hour}${values.minute}${values.second}`;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    const command = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -eq $p) { exit 1 } else { exit 0 }`;
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", command], {
      windowsHide: true,
      stdio: "ignore",
    });
    return result.status === 0;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock() {
  await mkdir(runnerRoot, { recursive: true });

  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
    await handle.close();
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  try {
    const current = JSON.parse(await readFile(lockPath, "utf8"));
    if (isProcessAlive(Number(current.pid))) return false;
  } catch {
    // Broken or stale lock: replace it below.
  }

  await unlink(lockPath).catch(() => undefined);
  const handle = await open(lockPath, "wx");
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
  await handle.close();
  return true;
}

async function ensureExists(targetPath) {
  await access(targetPath, fsConstants.F_OK);
}

function codexCliPath() {
  if (process.env.CODEX_CLI_JS?.trim()) return process.env.CODEX_CLI_JS.trim();
  const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
}

async function runProcess(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: [options.stdinText === undefined ? "ignore" : "pipe", options.stdoutFd ?? "pipe", options.stderrFd ?? "pipe"],
    });

    let stdout = "";
    let stderr = "";

    if (child.stdout) child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    if (child.stderr) child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));

    if (child.stdin) {
      child.stdin.end(options.stdinText, "utf8");
    }
  });
}

async function sendDiscordReport(reportPath, attachmentPath = "") {
  if (!reportToDiscord) return;

  const args = [
    "--import",
    loaderUri,
    "scripts/discord-agent.ts",
    "send",
    "--content-file",
    reportPath,
  ];
  if (attachmentPath) args.push("--attachment", attachmentPath);

  const result = await runProcess(process.execPath, args, { cwd: bridgeRoot });
  if (result.code !== 0) {
    throw new Error(`Discord report delivery failed with exit code ${result.code}.\n${result.stderr || result.stdout}`);
  }
}

async function latestGeneratedImage() {
  const candidates = [
    path.join(siteRoot, "docs", "assets", "images", `devlog-${runDate}-comic.png`),
    path.join(siteRoot, ".devlog-work", runDate, "generated.png"),
  ];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // Continue.
    }
  }
  return "";
}

function statusPathForDate() {
  return path.join(siteRoot, ".devlog-work", runDate, "status.json");
}

function publishPathsForDate() {
  return [
    `docs/devlog/${runDate}.html`,
    `docs/assets/images/devlog-${runDate}-comic.png`,
    "docs/devlog/index.html",
    "docs/index.html",
  ];
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function valueTypeMatches(value, expectedType) {
  if (expectedType === "null") return value === null;
  if (expectedType === "array") return Array.isArray(value);
  if (expectedType === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === expectedType;
}

function validateSchemaNode(value, schema, pathLabel, errors) {
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${pathLabel}: expected constant ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    return;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pathLabel}: expected one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}, got ${JSON.stringify(value)}`);
    return;
  }

  if (schema.type) {
    const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expectedTypes.some((type) => valueTypeMatches(value, type))) {
      errors.push(`${pathLabel}: expected type ${expectedTypes.join("|")}, got ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}`);
      return;
    }
  }

  if (typeof value === "string" && schema.pattern) {
    const pattern = new RegExp(schema.pattern);
    if (!pattern.test(value)) errors.push(`${pathLabel}: does not match pattern ${schema.pattern}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${pathLabel}: expected at least ${schema.minItems} items, got ${value.length}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${pathLabel}: expected at most ${schema.maxItems} items, got ${value.length}`);
    }
    if (schema.items) value.forEach((item, index) => validateSchemaNode(item, schema.items, `${pathLabel}[${index}]`, errors));
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const requiredKey of schema.required ?? []) {
      if (!(requiredKey in value)) errors.push(`${pathLabel}.${requiredKey}: required property is missing`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (key in value) validateSchemaNode(value[key], childSchema, `${pathLabel}.${key}`, errors);
    }
  }
}

function validateStatusAgainstSchema(status, schema) {
  const errors = [];
  validateSchemaNode(status, schema, "status", errors);
  if (status?.date !== runDate) errors.push(`status.date: expected ${runDate}, got ${JSON.stringify(status?.date)}`);
  if (status?.stage !== "validated") errors.push(`status.stage: expected \"validated\" before publication, got ${JSON.stringify(status?.stage)}`);
  if (status?.published !== false) errors.push(`status.published: expected false before publication, got ${JSON.stringify(status?.published)}`);
  const expectedPaths = publishPathsForDate();
  const actualPaths = status?.node_runner_handoff?.paths;
  if (Array.isArray(actualPaths) && JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    errors.push(`status.node_runner_handoff.paths: expected ${JSON.stringify(expectedPaths)}, got ${JSON.stringify(actualPaths)}`);
  }
  return errors;
}

async function readStatusObject() {
  return JSON.parse(await readFile(statusPathForDate(), "utf8"));
}

async function writeStatusObject(status) {
  status.updated_at = new Date().toISOString();
  await writeFile(statusPathForDate(), `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

async function statusSummary() {
  try {
    const value = await readStatusObject();
    return {
      stage: String(value.stage ?? "unknown"),
      published: Boolean(value.published),
      error: value.error == null ? "" : String(value.error),
    };
  } catch {
    return { stage: "unknown", published: false, error: "status.json unavailable" };
  }
}

function compactDiagnostic(value, maxLength = 1200) {
  const compact = String(value ?? "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3)}...`;
}

async function readCodexFailureReason(eventLogPath) {
  try {
    const text = await readFile(eventLogPath, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const event = JSON.parse(lines[index]);
        if (event?.type === "turn.failed" && event?.error?.message) {
          return compactDiagnostic(event.error.message);
        }
        if (event?.type === "error" && event?.message) {
          return compactDiagnostic(event.message);
        }
      } catch {
        // Ignore non-JSON diagnostic lines.
      }
    }
  } catch {
    // The regular report still carries the exit code and log directory.
  }
  return "";
}

async function runGitPublish(status) {
  const publishPaths = publishPathsForDate();
  const statusResult = await runProcess("git", ["-C", siteRoot, "status", "--porcelain", "--", ...publishPaths]);
  if (statusResult.code !== 0) {
    throw new Error(`Failed to inspect publish paths.\n${statusResult.stderr}`);
  }

  let commitCreated = false;
  let helperOutput = "";
  if (statusResult.stdout.trim()) {
    const pathArray = publishPaths.map(powershellQuote).join(",");
    const command = [
      `& ${powershellQuote(gitHelperScript)}`,
      `-RepoRoot ${powershellQuote(siteRoot)}`,
      `-Message ${powershellQuote(`${runDate}の開発日記を追加`)}`,
      `-Paths @(${pathArray})`,
      "-Push",
    ].join(" ");
    const helperResult = await runProcess(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      { cwd: siteRoot },
    );
    helperOutput = `${helperResult.stdout}\n${helperResult.stderr}`.trim();
    if (helperResult.code !== 0) {
      throw new Error(`Git Helper failed.\n${helperOutput}`);
    }
    commitCreated = true;
  } else {
    const pushResult = await runProcess("git", ["-C", siteRoot, "push", "origin", "main"]);
    helperOutput = `${pushResult.stdout}\n${pushResult.stderr}`.trim();
    if (pushResult.code !== 0) {
      throw new Error(`git push failed.\n${helperOutput}`);
    }
  }

  const headResult = await runProcess("git", ["-C", siteRoot, "rev-parse", "HEAD"]);
  if (headResult.code !== 0) throw new Error(`Failed to resolve local HEAD.\n${headResult.stderr}`);
  const head = headResult.stdout.trim();
  const remoteResult = await runProcess("git", ["-C", siteRoot, "ls-remote", "origin", "refs/heads/main"]);
  if (remoteResult.code !== 0) throw new Error(`Failed to resolve origin/main.\n${remoteResult.stderr}`);
  const remoteHead = remoteResult.stdout.trim().split(/\s+/)[0] ?? "";
  if (!head || head !== remoteHead) {
    throw new Error(`Push verification failed. local=${head || "unknown"} remote=${remoteHead || "unknown"}`);
  }

  status.commit = {
    attempted: true,
    created: commitCreated,
    hash: head,
    message: `${runDate}の開発日記を追加`,
    paths: publishPaths,
    helper_output: helperOutput,
  };
  status.push = { attempted: true, succeeded: true, remote: "origin", branch: "main", hash: head };
  status.published = false;
  status.stage = "pushed";
  status.error = null;
  await writeStatusObject(status);
  return head;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function verifyGitHubPages(status) {
  const articleUrl = `${pagesBaseUrl}/devlog/${runDate}.html`;
  const imageUrl = `${pagesBaseUrl}/assets/images/devlog-${runDate}-comic.png`;
  let lastError = "";

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const [articleResponse, imageResponse] = await Promise.all([
        fetch(articleUrl, { cache: "no-store", redirect: "follow" }),
        fetch(imageUrl, { cache: "no-store", redirect: "follow" }),
      ]);
      const articleText = articleResponse.ok ? await articleResponse.text() : "";
      const imageType = imageResponse.headers.get("content-type") ?? "";
      if (
        articleResponse.ok &&
        imageResponse.ok &&
        articleText.includes(runDate) &&
        imageType.toLowerCase().startsWith("image/")
      ) {
        status.published = true;
        status.stage = "published";
        status.error = null;
        status.publication = {
          verified: true,
          article_url: articleUrl,
          image_url: imageUrl,
          verified_at: new Date().toISOString(),
          attempts: attempt,
        };
        await writeStatusObject(status);
        return true;
      }
      lastError = `attempt ${attempt}: article=${articleResponse.status}, image=${imageResponse.status}, imageType=${imageType}`;
    } catch (error) {
      lastError = `attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (attempt < 6) await delay(15_000);
  }

  status.published = false;
  status.stage = "publish_pending";
  status.error = `GitHub Pages was not confirmed: ${lastError}`;
  status.publication = {
    verified: false,
    article_url: articleUrl,
    image_url: imageUrl,
    checked_at: new Date().toISOString(),
    attempts: 6,
    last_error: lastError,
  };
  await writeStatusObject(status);
  return false;
}

const requestedDate = argumentValue("--date");
const runDate = requestedDate || jstDateString();
if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
  throw new Error("--date must use yyyy-MM-dd format");
}

let lockOwned = false;
let runDirectory = "";
let reportPath = "";

try {
  lockOwned = await acquireLock();
  if (!lockOwned) {
    console.log("DEVLOG_PIPELINE_ALREADY_RUNNING");
    process.exit(0);
  }

  await Promise.all([
    ensureExists(siteRoot),
    ensureExists(viewerRoot),
    ensureExists(referenceImage),
    ensureExists(pipelinePromptPath),
    ensureExists(statusSchemaPath),
    ensureExists(codexCliPath()),
  ]);

  await mkdir(logRoot, { recursive: true });
  runDirectory = path.join(logRoot, `${runDate}-${timestampString()}`);
  await mkdir(runDirectory, { recursive: true });

  const promptPath = path.join(runDirectory, "prompt.txt");
  const eventLogPath = path.join(runDirectory, "codex-events.log");
  const errorLogPath = path.join(runDirectory, "codex-error.log");
  const lastMessagePath = path.join(runDirectory, "last-message.txt");
  reportPath = path.join(runDirectory, "discord-report.txt");

  const [basePrompt, statusSchemaText] = await Promise.all([
    readFile(pipelinePromptPath, "utf8"),
    readFile(statusSchemaPath, "utf8"),
  ]);
  const runContext = `\n\n# RUN_CONTEXT\n\n- RUN_DATE_JST: ${runDate}\n- SITE_ROOT: ${siteRoot}\n- VIEWER_ROOT_READ_ONLY: ${viewerRoot}\n- REFERENCE_IMAGE_ATTACHED_WITH_CODEX_IMAGE_INPUT: ${referenceImage}\n- USER_AUTHORIZED_SITE_COMMIT_AND_PUSH_AFTER_ALL_GATES: true\n- EXECUTION_MODE: unattended_local_codex\n\nUse this date as authoritative and execute Stage 1 through Stage 3 continuously.\n\n# STATUS_JSON_SCHEMA\n\nWrite .devlog-work/${runDate}/status.json using this exact schema. Property names are a machine contract and must not be renamed or replaced with synonyms.\n\n\`\`\`json\n${statusSchemaText.trim()}\n\`\`\`\n`;
  const prompt = `${basePrompt}${runContext}`;
  await writeFile(promptPath, prompt, "utf8");

  if (dryRun) {
    const report = `Devlog Local Codex pipeline dry-run passed.\nDate: ${runDate}\nPrompt: ${promptPath}\nReference image: ${referenceImage}\n`;
    await writeFile(reportPath, report, "utf8");
    console.log(report.trim());
    await unlink(lockPath).catch(() => undefined);
    lockOwned = false;
    process.exit(0);
  }

  const eventHandle = await open(eventLogPath, "w");
  const errorHandle = await open(errorLogPath, "w");
  const codexArgs = [
    codexCliPath(),
    "exec",
    "--model",
    codexModel,
    "--config",
    `model_reasoning_effort="${codexReasoningEffort}"`,
    "--json",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "-C",
    siteRoot,
    "--add-dir",
    viewerRoot,
    "-i",
    referenceImage,
    "--output-last-message",
    lastMessagePath,
    "-",
  ];

  const result = await runProcess(process.execPath, codexArgs, {
    cwd: siteRoot,
    stdinText: prompt,
    stdoutFd: eventHandle.fd,
    stderrFd: errorHandle.fd,
  });
  await eventHandle.close();
  await errorHandle.close();

  const codexFailureReason = result.code === 0 ? "" : await readCodexFailureReason(eventLogPath);
  let pipelineExitCode = result.code;
  let publishReport = "";

  if (result.code === 0) {
    try {
      const statusObject = await readStatusObject();
      if (statusObject.published === true && statusObject.stage === "published") {
        publishReport = "Git publication: already published; no duplicate commit was created.";
      } else {
        const statusSchema = JSON.parse(await readFile(statusSchemaPath, "utf8"));
        const schemaErrors = validateStatusAgainstSchema(statusObject, statusSchema);
        if (schemaErrors.length === 0) {
          const head = await runGitPublish(statusObject);
          const published = await verifyGitHubPages(statusObject);
          publishReport = published
            ? `Git publication: committed/pushed and GitHub Pages verified at ${head}.`
            : `Git publication: committed/pushed at ${head}; GitHub Pages verification is pending.`;
        } else {
          pipelineExitCode = 1;
          statusObject.published = false;
          statusObject.stage = "validation_failed";
          statusObject.error = `status.json schema validation failed:\n- ${schemaErrors.join("\n- ")}`;
          await writeStatusObject(statusObject);
          publishReport = `Git publication skipped: status.json schema validation failed:\n- ${schemaErrors.join("\n- ")}`;
        }
      }
    } catch (error) {
      pipelineExitCode = 1;
      const message = error instanceof Error ? error.message : String(error);
      publishReport = `Git publication failed: ${message}`;
      try {
        const statusObject = await readStatusObject();
        statusObject.published = false;
        statusObject.stage = "publish_failed";
        statusObject.error = message;
        await writeStatusObject(statusObject);
      } catch {
        // Keep the original publication error in the final report.
      }
    }
  }

  const status = await statusSummary();
  const lastMessage = await readFile(lastMessagePath, "utf8").catch(() => "Codex did not produce a final message.");
  const imagePath = await latestGeneratedImage();
  const label = pipelineExitCode === 0 && status.published
    ? "SUCCESS: published"
    : pipelineExitCode === 0
      ? "COMPLETED: publication not confirmed"
      : "FAILED";
  let report = [
    `Devlog Local Codex pipeline: ${label}`,
    `Date: ${runDate}`,
    `Codex exit code: ${result.code}`,
    ...(codexFailureReason ? [`Codex failure reason: ${codexFailureReason}`] : []),
    `Pipeline exit code: ${pipelineExitCode}`,
    `status.stage: ${status.stage}`,
    `status.published: ${status.published}`,
    `status.error: ${status.error}`,
    `Logs: ${runDirectory}`,
    "",
    publishReport,
    "",
    "Codex final report:",
    lastMessage.trim(),
    "",
  ].join("\n");
  await writeFile(reportPath, report, "utf8");
  try {
    await sendDiscordReport(reportPath, imagePath);
  } catch (error) {
    pipelineExitCode = 1;
    const message = error instanceof Error ? error.message : String(error);
    report = `${report}\nDiscord report delivery: FAILED\n${message}\n`;
    await writeFile(reportPath, report, "utf8");
    console.error(message);
  }
  console.log(`DEVLOG_PIPELINE_FINISHED DATE=${runDate} EXIT=${pipelineExitCode} STAGE=${status.stage} PUBLISHED=${status.published}`);
  process.exitCode = pipelineExitCode;
} catch (error) {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  if (!runDirectory) {
    await mkdir(logRoot, { recursive: true }).catch(() => undefined);
    runDirectory = logRoot;
  }
  if (!reportPath) reportPath = path.join(runDirectory, `startup-error-${timestampString()}.txt`);
  const report = `Devlog Local Codex pipeline failed to start.\nDate: ${runDate}\nReason: ${message}\n`;
  await writeFile(reportPath, report, "utf8").catch(() => undefined);
  await sendDiscordReport(reportPath).catch(() => undefined);
  console.error(report.trim());
  console.log(`DEVLOG_PIPELINE_FINISHED DATE=${runDate} EXIT=1 STAGE=startup_failed PUBLISHED=false`);
  process.exitCode = 1;
} finally {
  if (lockOwned) await unlink(lockPath).catch(() => undefined);
}
