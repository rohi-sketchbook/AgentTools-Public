import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const runnerRoot = path.dirname(fileURLToPath(import.meta.url));
const agentToolsRoot = path.resolve(runnerRoot, "..");

function requiredString(config, key) {
  const value = String(config[key] ?? "").trim();
  if (!value) {
    throw new Error(`Devlog local configuration is missing "${key}". Copy devlog.config.example.json to devlog.local.json and configure it.`);
  }
  return value;
}

export function loadDevlogConfig() {
  const configPath = process.env.AGENTTOOLS_DEVLOG_CONFIG
    ? path.resolve(process.env.AGENTTOOLS_DEVLOG_CONFIG)
    : path.join(runnerRoot, "devlog.local.json");

  if (!existsSync(configPath)) {
    throw new Error(`Devlog local configuration not found: ${configPath}. Copy devlog.config.example.json to devlog.local.json.`);
  }

  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const siteRoot = path.resolve(requiredString(config, "siteRoot"));
  const viewerRoot = path.resolve(requiredString(config, "viewerRoot"));
  const bridgeRoot = path.resolve(config.bridgeRoot || path.join(agentToolsRoot, "discord-bot", "discord-codex-bridge"));
  const connectorRoot = path.resolve(config.connectorRoot || path.join(agentToolsRoot, "discord-bot", "codex-discord-connector"));
  const gitHelperScript = path.resolve(config.gitHelperScript || path.join(agentToolsRoot, "git-helper", "scripts", "git_commit_push.ps1"));
  const referenceImage = path.resolve(requiredString(config, "referenceImage"));
  const loaderPath = path.join(connectorRoot, "node_modules", "tsx", "dist", "loader.mjs");
  const pipelinePromptPath = path.resolve(config.pipelinePromptPath || path.join(runnerRoot, "DEVLOG_CODEX_PIPELINE.md"));
  const specialPromptPath = path.resolve(config.specialPromptPath || path.join(runnerRoot, "DEVLOG_SPECIAL_PREVIEW_PIPELINE.md"));

  return {
    configPath,
    siteRoot,
    viewerRoot,
    referenceImage,
    pipelinePromptPath,
    specialPromptPath,
    bridgeRoot,
    connectorRoot,
    loaderUri: pathToFileURL(loaderPath).href,
    gitHelperScript,
    pagesBaseUrl: requiredString(config, "pagesBaseUrl").replace(/\/$/, ""),
    codexModel: String(config.codexModel || "gpt-5.6-terra"),
    codexReasoningEffort: String(config.codexReasoningEffort || "medium"),
  };
}
