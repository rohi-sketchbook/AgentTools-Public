import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
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
  specialPromptPath,
  bridgeRoot,
  loaderUri,
  codexModel,
  codexReasoningEffort,
} = loadDevlogConfig();
const logRoot = path.join(runnerRoot, "logs", "special-preview");
const lockPath = path.join(runnerRoot, ".devlog-special-preview.lock");
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
    // Broken or stale lock is replaced below.
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

function isPathWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertAllowedLocalInput(targetPath, label) {
  const resolved = path.resolve(targetPath);
  const allowedRoots = [siteRoot, viewerRoot];
  if (!allowedRoots.some((root) => isPathWithin(root, resolved))) {
    throw new Error(`${label} must be under the configured siteRoot or viewerRoot: ${resolved}`);
  }
  return resolved;
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
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (child.stdin) {
      child.stdin.end(options.stdinText, "utf8");
    }
  });
}

async function sendDiscordPreview(reportPath, imagePath) {
  if (!reportToDiscord) return;
  const args = [
    "--import",
    loaderUri,
    "scripts/discord-agent.ts",
    "send",
    "--content-file",
    reportPath,
    "--attachment",
    imagePath,
  ];
  const result = await runProcess(process.execPath, args, { cwd: bridgeRoot });
  if (result.code !== 0) {
    throw new Error(`Discord preview queue failed with exit code ${result.code}.\n${result.stderr || result.stdout}`);
  }
}

const qaKeys = [
  "exactly_four_panels",
  "reference_image_match",
  "logo_reference_match",
  "no_unknown_main_character",
  "no_poster_layout",
  "japanese_legible",
];

function validateQaStatus(status, slug, runDate) {
  const errors = [];
  if (status?.schema_version !== 1) errors.push("schema_version must be 1");
  if (status?.slug !== slug) errors.push(`slug must be ${slug}`);
  if (status?.date !== runDate) errors.push(`date must be ${runDate}`);
  if (status?.article_ready !== true) errors.push("article_ready must be true");
  if (status?.prompt_ready !== true) errors.push("prompt_ready must be true");
  if (status?.published !== false) errors.push("published must be false");
  if (!Number.isInteger(status?.image_attempts) || status.image_attempts < 1 || status.image_attempts > 3) {
    errors.push("image_attempts must be an integer from 1 to 3");
  }
  for (const key of qaKeys) {
    if (status?.qa?.[key] !== true) errors.push(`qa.${key} must be true`);
  }
  if (status?.error !== null) errors.push("error must be null");
  return errors;
}

function validateFinalStatus(status, slug, runDate) {
  const errors = validateQaStatus(status, slug, runDate);
  if (status?.stage !== "ready_for_user_review") errors.push("stage must be ready_for_user_review");
  if (status?.image_ready !== true) errors.push("image_ready must be true");
  if (status?.draft_ready !== true) errors.push("draft_ready must be true");
  return errors;
}

async function validateOutputFile(filePath, label) {
  const info = await stat(filePath);
  if (!info.isFile() || info.size <= 0) throw new Error(`${label} is missing or empty: ${filePath}`);
}

async function fileExistsNonEmpty(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function previewHtml(articleText, logoReference, draftPath) {
  const logoSrc = path.relative(path.dirname(draftPath), logoReference).replaceAll("\\", "/");
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VRAS 開発日記 特別版 - 公開前プレビュー</title>
  <style>
    :root { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #17213a; background: #f7faff; }
    body { margin: 0; }
    main { width: min(960px, calc(100% - 32px)); margin: 32px auto 64px; }
    .notice { padding: 14px 18px; border: 1px solid #7aa8ff; border-radius: 12px; background: #eef5ff; font-weight: 700; }
    .asset { display: block; max-width: 100%; height: auto; margin: 24px auto; border-radius: 12px; }
    .logo { max-height: 420px; object-fit: contain; }
    .comic { width: min(760px, 100%); }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 24px; border-radius: 14px; background: white; box-shadow: 0 8px 30px rgb(24 60 120 / 8%); line-height: 1.75; font: inherit; }
  </style>
</head>
<body>
<main>
  <div class="notice">公開前プレビュー / 未公開 — commit・push・公開は行っていません。</div>
  <img class="asset logo" src="${htmlEscape(logoSrc)}" alt="VRAS 仮ロゴ">
  <img class="asset comic" src="generated.png" alt="VRAS正式名称決定の4コマ漫画">
  <pre>${htmlEscape(articleText)}</pre>
</main>
</body>
</html>
`;
}

async function finalizePreview({ articlePath, imagePromptPath, imagePath, draftPath, statusPath, logoReference, slug, runDate }) {
  await Promise.all([
    validateOutputFile(articlePath, "article.md"),
    validateOutputFile(imagePromptPath, "image_prompt.txt"),
    validateOutputFile(imagePath, "generated.png"),
    validateOutputFile(statusPath, "special-status.json"),
  ]);

  const status = JSON.parse(await readFile(statusPath, "utf8"));
  const qaErrors = validateQaStatus(status, slug, runDate);
  if (qaErrors.length > 0) {
    throw new Error(`Special preview QA status validation failed:\n- ${qaErrors.join("\n- ")}`);
  }

  const articleText = await readFile(articlePath, "utf8");
  await writeFile(draftPath, previewHtml(articleText, logoReference, draftPath), "utf8");
  status.stage = "ready_for_user_review";
  status.image_ready = true;
  status.draft_ready = true;
  status.published = false;
  status.error = null;
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");

  const finalErrors = validateFinalStatus(status, slug, runDate);
  if (finalErrors.length > 0) {
    throw new Error(`Special preview final status validation failed:\n- ${finalErrors.join("\n- ")}`);
  }
  await validateOutputFile(draftPath, "draft.html");
  return status;
}

const slug = argumentValue("--slug").trim();
const runDate = argumentValue("--date").trim() || jstDateString();
const briefInput = argumentValue("--brief").trim();
const logoInput = argumentValue("--logo").trim();

if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(slug)) {
  console.error("--slug is required and must match ^[a-z0-9][a-z0-9-]{2,79}$");
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
  console.error("--date must be YYYY-MM-DD");
  process.exit(2);
}
if (!briefInput || !logoInput) {
  console.error("--brief and --logo are required");
  process.exit(2);
}

let lockOwned = false;
let reportPath = "";
let runDirectory = "";

try {
  const briefPath = assertAllowedLocalInput(briefInput, "brief");
  const logoReference = assertAllowedLocalInput(logoInput, "logo");
  const workRoot = path.join(siteRoot, ".devlog-work", slug);
  const articlePath = path.join(workRoot, "article.md");
  const imagePromptPath = path.join(workRoot, "image_prompt.txt");
  const imagePath = path.join(workRoot, "generated.png");
  const draftPath = path.join(workRoot, "draft.html");
  const statusPath = path.join(workRoot, "special-status.json");

  lockOwned = await acquireLock();
  if (!lockOwned) {
    console.log("DEVLOG_SPECIAL_PREVIEW_ALREADY_RUNNING");
    process.exit(0);
  }

  await Promise.all([
    ensureExists(siteRoot),
    ensureExists(viewerRoot),
    ensureExists(referenceImage),
    ensureExists(specialPromptPath),
    ensureExists(briefPath),
    ensureExists(logoReference),
    ensureExists(codexCliPath()),
  ]);

  await mkdir(logRoot, { recursive: true });
  runDirectory = path.join(logRoot, `${slug}-${timestampString()}`);
  await mkdir(runDirectory, { recursive: true });
  await mkdir(workRoot, { recursive: true });

  const [basePrompt, briefText] = await Promise.all([
    readFile(specialPromptPath, "utf8"),
    readFile(briefPath, "utf8"),
  ]);

  const promptPath = path.join(runDirectory, "prompt.txt");
  const eventLogPath = path.join(runDirectory, "codex-events.log");
  const errorLogPath = path.join(runDirectory, "codex-error.log");
  const lastMessagePath = path.join(runDirectory, "last-message.txt");
  reportPath = path.join(runDirectory, "discord-report.txt");

  const runContext = `\n\n# SPECIAL_RUN_CONTEXT\n\n- SPECIAL_SLUG: ${slug}\n- RUN_DATE_JST: ${runDate}\n- SITE_ROOT: ${siteRoot}\n- VIEWER_ROOT_READ_ONLY: ${viewerRoot}\n- SPECIAL_BRIEF_PATH: ${briefPath}\n- REFERENCE_IMAGE_ATTACHED_WITH_CODEX_IMAGE_INPUT: ${referenceImage}\n- LOGO_REFERENCE_ATTACHED_WITH_CODEX_IMAGE_INPUT: ${logoReference}\n- PUBLICATION_ALLOWED: false\n- EXECUTION_MODE: special_preview_only\n\nThe following brief text is authoritative. Do not replace it with daily Git history or previous devlog topics.\n\n# SPECIAL_BRIEF_CONTENT\n\n${briefText.trim()}\n\nCreate article.md, image_prompt.txt, perform image generation and visual QA, save generated.png, update special-status.json through stage=image_validated, then stop. The outer Runner creates draft.html deterministically. Never commit, push, publish, or update the public docs indexes.\n`;
  const prompt = `${basePrompt}${runContext}`;
  await writeFile(promptPath, prompt, "utf8");

  let resumed = false;
  if (!dryRun && await fileExistsNonEmpty(articlePath) && await fileExistsNonEmpty(imagePromptPath) && await fileExistsNonEmpty(imagePath) && await fileExistsNonEmpty(statusPath)) {
    try {
      const existingStatus = JSON.parse(await readFile(statusPath, "utf8"));
      if (validateQaStatus(existingStatus, slug, runDate).length === 0) {
        resumed = true;
      }
    } catch {
      resumed = false;
    }
  }

  if (dryRun) {
    const report = [
      "Devlog special preview dry-run passed.",
      `Slug: ${slug}`,
      `Date: ${runDate}`,
      `Brief: ${briefPath}`,
      `Reference image: ${referenceImage}`,
      `Logo reference: ${logoReference}`,
      `Prompt: ${promptPath}`,
      "Publication: disabled",
      "",
    ].join("\n");
    await writeFile(reportPath, report, "utf8");
    console.log(report.trim());
    process.exitCode = 0;
  } else if (!resumed) {
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
      "-i",
      logoReference,
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

    if (result.code !== 0) {
      const recoverable = await fileExistsNonEmpty(articlePath)
        && await fileExistsNonEmpty(imagePromptPath)
        && await fileExistsNonEmpty(imagePath)
        && await fileExistsNonEmpty(statusPath)
        && validateQaStatus(JSON.parse(await readFile(statusPath, "utf8")), slug, runDate).length === 0;
      if (!recoverable) {
        throw new Error(`Special preview Codex run failed with exit code ${result.code}. See ${errorLogPath}`);
      }
    }
  }

  if (!dryRun) {
    const status = await finalizePreview({
      articlePath,
      imagePromptPath,
      imagePath,
      draftPath,
      statusPath,
      logoReference,
      slug,
      runDate,
    });

    const report = [
      "VRAS開発日記 特別版プレビューを作成しました。",
      `slug: ${slug}`,
      `画像生成試行: ${status.image_attempts}`,
      resumed ? "状態: 既存のQA済み画像から安全に再開" : "状態: 新規生成完了",
      "QA: 4パネル / 主役参照 / ロゴ参照 / 未知キャラなし / ポスター化なし / 日本語可読 を通過",
      `article: ${articlePath}`,
      `comic: ${imagePath}`,
      `draft: ${draftPath}`,
      "公開・commit・push: 未実施",
      "",
    ].join("\n");
    await writeFile(reportPath, report, "utf8");

    if (reportToDiscord && status.discord_reported !== true) {
      await sendDiscordPreview(reportPath, imagePath);
      status.discord_reported = true;
      await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
    }
    console.log(`DEVLOG_SPECIAL_PREVIEW_FINISHED SLUG=${slug} EXIT=0 STAGE=ready_for_user_review`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (runDirectory) {
    const failurePath = path.join(runDirectory, "failure.txt");
    await writeFile(failurePath, `${message}\n`, "utf8").catch(() => undefined);
  }
  console.error(`DEVLOG_SPECIAL_PREVIEW_FINISHED SLUG=${slug} EXIT=1 STAGE=failed`);
  console.error(message);
  process.exitCode = 1;
} finally {
  if (lockOwned) await unlink(lockPath).catch(() => undefined);
}
