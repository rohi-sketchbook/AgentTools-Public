import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BRIDGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DISCORD_ROOT = path.resolve(BRIDGE_ROOT, "..");
const DEFAULT_PUBLIC_WORKSPACE = path.join(DISCORD_ROOT, "public-workspace");
const INTEGRATION_URL = pathToFileURL(path.join(BRIDGE_ROOT, "src", "integration.ts")).href;
const TARGET = "codex-discord-connector";

// Runtime-only Japanese localization for codex-discord-connector.
// The npm-installed package itself is not modified.
// Longest phrases are replaced first so that short Korean fragments do not
// partially rewrite larger phrases before they can be translated correctly.
const translations = [
  // Windows does not permit ordinary directory symlinks for unelevated users by default.
  // Use a junction for the ASCII workspace alias so Japanese workspace paths work safely.
  ["await symlink(resolvedWorkspaceRoot, aliasPath, \"dir\");", "await symlink(resolvedWorkspaceRoot, aliasPath, process.platform === \"win32\" ? \"junction\" : \"dir\");"],

  // Public Discord assistant channels need a minimal direct-mode context even
  // though they are not admin/session channels managed by the upstream connector.
  ["export interface DirectConnectConfig {\n  mode: \"direct\";", "export interface DirectConnectConfig {\n  mode: \"direct\";\n  multiBackend?: {\n    publicAssistant?: {\n      channelIds?: string[];\n      workspaceRoot?: string;\n      timeoutMs?: number;\n    };\n  };"],
  ["    async getChannelContext(discordChannelId) {\n      if (discordChannelId === config.direct.channelId) {", "    async getChannelContext(discordChannelId) {\n      const configuredPublicChannelIds = config.multiBackend?.publicAssistant?.channelIds ?? [];\n      const environmentPublicChannelIds = (process.env.DISCORD_PUBLIC_CHANNEL_IDS ?? \"\")\n        .split(\",\")\n        .map((value) => value.trim())\n        .filter(Boolean);\n      const publicChannelIds = configuredPublicChannelIds.length > 0\n        ? configuredPublicChannelIds\n        : environmentPublicChannelIds;\n      if (publicChannelIds.includes(discordChannelId)) {\n        const publicWorkspaceRoot = config.multiBackend?.publicAssistant?.workspaceRoot\n          ?? " + JSON.stringify(DEFAULT_PUBLIC_WORKSPACE) + ";\n        return {\n          channelMode: \"session-linked\",\n          allowedRoleIds: [...config.discord.allowedRoleIds],\n          computerId: config.direct.computerId,\n          computerDisplayName: config.direct.computerDisplayName,\n          workspaceDisplayName: \"Public Discord Assistant\",\n          workspaceRoot: publicWorkspaceRoot,\n          cwd: publicWorkspaceRoot,\n          timeoutMs: config.multiBackend?.publicAssistant?.timeoutMs ?? 120_000,\n          codexSessionId: null,\n        };\n      }\n\n      if (discordChannelId === config.direct.channelId) {"],

  // Japanese channel-name support. The upstream sanitizer permits Latin/Korean
  // characters only; replace the Korean ranges with Hiragana/Katakana/CJK.
  [".replace(/[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ_-]+/gi, \"-\")", ".replace(/[^0-9a-z\\u3040-\\u309F\\u30A0-\\u30FF\\u4E00-\\u9FFF々ー_-]+/gi, \"-\")"],

  // Windows Codex CLI compatibility. npm exposes codex as a .cmd shim, but
  // child_process.spawn() cannot execute that shim directly without a shell.
  // Invoke the underlying codex.js through the current Node executable instead.
  ["const codexCommand = input.codexCommand ?? \"codex\";", "const codexCommand = input.codexCommand ?? (process.platform === \"win32\" ? process.execPath : \"codex\");"],
  ["const child = spawn(codexCommand, args, {", "const child = spawn(codexCommand, process.platform === \"win32\" && !input.codexCommand\n      ? [process.env.CODEX_CLI_JS ?? path.join(process.env.APPDATA ?? \"\", \"npm\", \"node_modules\", \"@openai\", \"codex\", \"bin\", \"codex.js\"), ...args]\n      : args, {"],
  ["      stdio: [\"ignore\", \"pipe\", \"pipe\"],", "      stdio: [\"ignore\", \"pipe\", \"pipe\"],\n      windowsHide: true,"],
  ["      maxBuffer: MAX_BUFFER_BYTES,\n    });", "      maxBuffer: MAX_BUFFER_BYTES,\n      windowsHide: true,\n    });"],
  ["      { encoding: \"utf8\", maxBuffer: 10 * 1024 * 1024 },", "      { encoding: \"utf8\", maxBuffer: 10 * 1024 * 1024, windowsHide: true },"],
  ["        stdio: \"inherit\",\n      });", "        stdio: \"inherit\",\n        windowsHide: true,\n      });"],
  ["      env: {\n        ...process.env,\n        ...(input.codexHome ? { CODEX_HOME: input.codexHome } : {}),\n      },", "      env: input.publicMode\n        ? {\n            PATH: process.env.PATH,\n            Path: process.env.Path,\n            PATHEXT: process.env.PATHEXT,\n            SYSTEMROOT: process.env.SYSTEMROOT,\n            WINDIR: process.env.WINDIR,\n            COMSPEC: process.env.COMSPEC,\n            TEMP: process.env.TEMP,\n            TMP: process.env.TMP,\n            USERPROFILE: process.env.USERPROFILE,\n            APPDATA: process.env.APPDATA,\n            LOCALAPPDATA: process.env.LOCALAPPDATA,\n            CODEX_HOME: input.codexHome ?? defaultCodexHome(),\n            CODEX_CLI_JS: process.env.CODEX_CLI_JS,\n          }\n        : {\n            ...process.env,\n            ...(input.codexHome ? { CODEX_HOME: input.codexHome } : {}),\n          },"],
  ["      \"review\",\n      \"--json\",\n      \"--full-auto\",", "      \"review\",\n      \"--json\",\n      ...(input.publicMode\n        ? [\"--ignore-user-config\", \"--ignore-rules\", \"--ephemeral\", \"--sandbox\", \"read-only\", \"-c\", \"approval_policy=\\\"never\\\"\", \"--disable\", \"shell_tool\", \"--disable\", \"shell_snapshot\", \"--disable\", \"unified_exec\", \"--disable\", \"apps\", \"--disable\", \"plugins\", \"--disable\", \"remote_plugin\", \"--disable\", \"browser_use\", \"--disable\", \"browser_use_external\", \"--disable\", \"browser_use_full_cdp_access\", \"--disable\", \"in_app_browser\", \"--disable\", \"computer_use\", \"--disable\", \"multi_agent\", \"--disable\", \"hooks\", \"--disable\", \"skill_search\", \"--disable\", \"skill_mcp_dependency_install\", \"--disable\", \"tool_suggest\", \"--disable\", \"workspace_dependencies\"]\n        : [\"-c\", \"sandbox_mode=\\\"workspace-write\\\"\"]),"],
  ["      \"resume\",\n      \"--json\",\n      \"--full-auto\",", "      \"resume\",\n      \"--json\",\n      ...(input.publicMode\n        ? [\"--ignore-user-config\", \"--ignore-rules\", \"--ephemeral\", \"--sandbox\", \"read-only\", \"-c\", \"approval_policy=\\\"never\\\"\", \"--disable\", \"shell_tool\", \"--disable\", \"shell_snapshot\", \"--disable\", \"unified_exec\", \"--disable\", \"apps\", \"--disable\", \"plugins\", \"--disable\", \"remote_plugin\", \"--disable\", \"browser_use\", \"--disable\", \"browser_use_external\", \"--disable\", \"browser_use_full_cdp_access\", \"--disable\", \"in_app_browser\", \"--disable\", \"computer_use\", \"--disable\", \"multi_agent\", \"--disable\", \"hooks\", \"--disable\", \"skill_search\", \"--disable\", \"skill_mcp_dependency_install\", \"--disable\", \"tool_suggest\", \"--disable\", \"workspace_dependencies\"]\n        : [\"-c\", \"sandbox_mode=\\\"workspace-write\\\"\"]),\n      \"--skip-git-repo-check\",\n      ...imageArgs(imagePaths),"],
  ["  return [\n    \"exec\",\n    \"--json\",\n    \"--full-auto\",", "  return [\n    \"exec\",\n    \"--json\",\n    ...(input.publicMode\n      ? [\"--ignore-user-config\", \"--ignore-rules\", \"--ephemeral\", \"--sandbox\", \"read-only\", \"-c\", \"approval_policy=\\\"never\\\"\", \"--disable\", \"shell_tool\", \"--disable\", \"shell_snapshot\", \"--disable\", \"unified_exec\", \"--disable\", \"apps\", \"--disable\", \"plugins\", \"--disable\", \"remote_plugin\", \"--disable\", \"browser_use\", \"--disable\", \"browser_use_external\", \"--disable\", \"browser_use_full_cdp_access\", \"--disable\", \"in_app_browser\", \"--disable\", \"computer_use\", \"--disable\", \"multi_agent\", \"--disable\", \"hooks\", \"--disable\", \"skill_search\", \"--disable\", \"skill_mcp_dependency_install\", \"--disable\", \"tool_suggest\", \"--disable\", \"workspace_dependencies\"]\n      : [\"--sandbox\", \"workspace-write\"]),\n    ...imageArgs(imagePaths),"],

  // Discord -> Codex image input. Keep attachment metadata in Discord messages,
  // materialize only supported Discord CDN images on the machine running Codex,
  // then pass them through Codex CLI -i/--image. Temporary files are removed by
  // the runner's existing temp-directory cleanup.
  ["import { mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, unlink } from \"node:fs/promises\";", "import { mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, unlink, writeFile } from \"node:fs/promises\";"],
  ["export interface RunCodexPromptInput {\n  workspaceRoot: string;\n  cwd: string;\n  prompt: string;\n  timeoutMs: number;", "export interface RunCodexPromptInput {\n  workspaceRoot: string;\n  cwd: string;\n  prompt: string;\n  imageAttachments?: Array<{ url: string; name: string; contentType?: string | null; size?: number | null }>;\n  publicMode?: boolean;\n  timeoutMs: number;"],
  ["export interface RunCodexPromptJobPayload {\n  workspaceRoot: string;\n  cwd: string;\n  prompt: string;\n  timeoutMs: number;", "export interface RunCodexPromptJobPayload {\n  workspaceRoot: string;\n  cwd: string;\n  prompt: string;\n  imageAttachments?: Array<{ url: string; name: string; contentType?: string | null; size?: number | null }>;\n  publicMode?: boolean;\n  timeoutMs: number;"],
  ["export interface DiscordMessageLike {\n  authorBot: boolean;\n  userId: string;\n  channelId: string;\n  content: string;\n  roleIds: string[];", "export interface DiscordMessageLike {\n  authorBot: boolean;\n  userId: string;\n  channelId: string;\n  content: string;\n  imageAttachments?: Array<{ url: string; name: string; contentType?: string | null; size?: number | null }>;\n  roleIds: string[];"],
  ["    const discordMessage = message as Message;\n\n    void handleMessage({", "    const discordMessage = message as Message;\n    const imageAttachments = [...discordMessage.attachments.values()]\n      .filter((attachment) => {\n        const contentType = attachment.contentType?.split(\";\", 1)[0]?.toLowerCase() ?? \"\";\n        const imageName = attachment.name ?? \"\";\n        const supportedMime = [\"image/png\", \"image/jpeg\", \"image/webp\", \"image/gif\"].includes(contentType);\n        const extensionFallback = (!contentType || contentType === \"application/octet-stream\") && /\\.(?:png|jpe?g|webp|gif)$/i.test(imageName);\n        return supportedMime || extensionFallback;\n      })\n      .map((attachment, index) => ({\n        url: attachment.url,\n        name: attachment.name || `image-${index + 1}`,\n        contentType: attachment.contentType,\n        size: attachment.size,\n      }));\n\n    void handleMessage({"],
  ["      content: discordMessage.content,\n      roleIds: getRoleIds(discordMessage),", "      content:\n        discordMessage.content.trim().length > 0\n          ? discordMessage.content\n          : imageAttachments.length > 0\n            ? \"添付画像を確認してください。\"\n            : discordMessage.content,\n      imageAttachments,\n      roleIds: getRoleIds(discordMessage),"],
  ["            prompt: routed.prompt,\n            timeoutMs: Math.max(channelContext.timeoutMs, 300_000),", "            prompt: routed.prompt,\n            imageAttachments: message.imageAttachments ?? [],\n            timeoutMs: Math.max(channelContext.timeoutMs, 300_000),"],
  ["            prompt: routed.content,\n            timeoutMs: Math.max(channelContext.timeoutMs, 300_000),", "            prompt: routed.content,\n            imageAttachments: message.imageAttachments ?? [],\n            timeoutMs: Math.max(channelContext.timeoutMs, 300_000),"],
  ["function createCodexArgs(input: RunCodexPromptInput, outputPath: string, workspaceRoot: string): string[] {", "function imageArgs(imagePaths: string[]): string[] {\n  return imagePaths.flatMap((imagePath) => [\"-i\", imagePath]);\n}\n\nfunction createCodexArgs(input: RunCodexPromptInput, outputPath: string, workspaceRoot: string, imagePaths: string[]): string[] {"],
  ["function defaultCodexHome(): string {", "const MAX_CODEX_IMAGE_BYTES = 25 * 1024 * 1024;\nconst MAX_CODEX_IMAGES = 10;\nconst SUPPORTED_CODEX_IMAGE_MIME_TYPES = new Set([\"image/png\", \"image/jpeg\", \"image/webp\", \"image/gif\"]);\nconst DISCORD_IMAGE_HOSTS = new Set([\"cdn.discordapp.com\", \"media.discordapp.net\"]);\n\nfunction safeCodexImageName(name: string, index: number): string {\n  const fallback = `image-${index + 1}.png`;\n  const baseName = path.basename(name || fallback).replace(/[<>:\"/\\\\|?*\\u0000-\\u001F]/g, \"_\");\n  return `${index + 1}-${baseName || fallback}`;\n}\n\nfunction hasSupportedImageExtension(name: string): boolean {\n  return /\\.(?:png|jpe?g|webp|gif)$/i.test(name);\n}\n\nfunction detectCodexImageMime(data: Buffer): string | null {\n  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {\n    return \"image/png\";\n  }\n  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {\n    return \"image/jpeg\";\n  }\n  if (data.length >= 6 && (data.subarray(0, 6).toString(\"ascii\") === \"GIF87a\" || data.subarray(0, 6).toString(\"ascii\") === \"GIF89a\")) {\n    return \"image/gif\";\n  }\n  if (data.length >= 12 && data.subarray(0, 4).toString(\"ascii\") === \"RIFF\" && data.subarray(8, 12).toString(\"ascii\") === \"WEBP\") {\n    return \"image/webp\";\n  }\n  return null;\n}\n\nasync function materializeCodexImages(input: RunCodexPromptInput, tempRoot: string): Promise<string[]> {\n  const attachments = (input.imageAttachments ?? []).slice(0, MAX_CODEX_IMAGES);\n  if (attachments.length === 0 || input.mode === \"review\") {\n    return [];\n  }\n\n  const imageDir = path.join(tempRoot, \"input-images\");\n  await mkdir(imageDir, { recursive: true });\n  const imagePaths: string[] = [];\n\n  for (let index = 0; index < attachments.length; index += 1) {\n    const attachment = attachments[index];\n    const contentType = attachment.contentType?.split(\";\", 1)[0]?.toLowerCase() ?? \"\";\n    const metadataSupported = SUPPORTED_CODEX_IMAGE_MIME_TYPES.has(contentType);\n    const extensionFallback = (!contentType || contentType === \"application/octet-stream\") && hasSupportedImageExtension(attachment.name);\n    if (!metadataSupported && !extensionFallback) {\n      continue;\n    }\n\n    if (typeof attachment.size === \"number\" && attachment.size > MAX_CODEX_IMAGE_BYTES) {\n      throw new Error(`Discord image is too large for Codex input: ${attachment.name} (${attachment.size} bytes)`);\n    }\n\n    const url = new URL(attachment.url);\n    if (url.protocol !== \"https:\" || !DISCORD_IMAGE_HOSTS.has(url.hostname.toLowerCase())) {\n      throw new Error(`Refusing non-Discord image attachment URL: ${url.hostname}`);\n    }\n\n    const response = await fetch(url, { redirect: \"follow\" });\n    if (!response.ok) {\n      throw new Error(`Failed to download Discord image: ${attachment.name} (HTTP ${response.status})`);\n    }\n\n    const finalUrl = new URL(response.url);\n    if (finalUrl.protocol !== \"https:\" || !DISCORD_IMAGE_HOSTS.has(finalUrl.hostname.toLowerCase())) {\n      throw new Error(`Refusing redirected non-Discord image URL: ${finalUrl.hostname}`);\n    }\n\n    const data = Buffer.from(await response.arrayBuffer());\n    if (data.byteLength > MAX_CODEX_IMAGE_BYTES) {\n      throw new Error(`Discord image is too large for Codex input: ${attachment.name} (${data.byteLength} bytes)`);\n    }\n\n    const detectedMime = detectCodexImageMime(data);\n    if (!detectedMime || !SUPPORTED_CODEX_IMAGE_MIME_TYPES.has(detectedMime)) {\n      throw new Error(`Discord attachment is not a supported image: ${attachment.name}`);\n    }\n\n    const imagePath = path.join(imageDir, safeCodexImageName(attachment.name, index));\n    await writeFile(imagePath, data);\n    imagePaths.push(imagePath);\n  }\n\n  return imagePaths;\n}\n\nfunction defaultCodexHome(): string {"],
  ["  const workspaceRoot = await ensureAsciiWorkspaceRoot(input.workspaceRoot);\n  const args = createCodexArgs(input, outputPath, workspaceRoot);\n  const codexCommand = input.codexCommand ?? \"codex\";", "  const workspaceRoot = await ensureAsciiWorkspaceRoot(input.workspaceRoot);\n  let args: string[] = [];\n  const codexCommand = input.codexCommand ?? \"codex\";"],
  ["  try {\n    const child = spawn(codexCommand, args, {", "  try {\n    const imagePaths = await materializeCodexImages(input, tempRoot);\n    const existingGeneratedImages = new Set(await listGeneratedImagePaths({\n      codexHome: input.codexHome,\n      sessionId: input.sessionId ?? null,\n    }));\n    args = createCodexArgs(input, outputPath, workspaceRoot, imagePaths);\n    const child = spawn(codexCommand, args, {"],

  ["async function generatedImageMarkdown(input: {\n  codexHome?: string;\n  sessionId: string | null;\n}): Promise<string> {\n  if (!input.sessionId) {\n    return \"\";\n  }\n\n  const imageDir = path.join(input.codexHome ?? defaultCodexHome(), \"generated_images\", input.sessionId);\n  let entries: import(\"node:fs\").Dirent[];\n\n  try {\n    entries = await readdir(imageDir, { withFileTypes: true });\n  } catch (error) {\n    if (error instanceof Error && \"code\" in error && error.code === \"ENOENT\") {\n      return \"\";\n    }\n\n    throw error;\n  }\n\n  const imagePaths = entries\n    .filter((entry) => entry.isFile() && isGeneratedImageFile(entry.name))\n    .map((entry) => path.join(imageDir, entry.name))\n    .sort();\n\n  return imagePaths\n    .map((imagePath, index) => `![generated image ${index + 1}](${imagePath})`)\n    .join(\"\\n\\n\");\n}", "async function listGeneratedImagePaths(input: {\n  codexHome?: string;\n  sessionId: string | null;\n}): Promise<string[]> {\n  if (!input.sessionId) {\n    return [];\n  }\n\n  const imageDir = path.join(input.codexHome ?? defaultCodexHome(), \"generated_images\", input.sessionId);\n  let entries: import(\"node:fs\").Dirent[];\n\n  try {\n    entries = await readdir(imageDir, { withFileTypes: true });\n  } catch (error) {\n    if (error instanceof Error && \"code\" in error && error.code === \"ENOENT\") {\n      return [];\n    }\n\n    throw error;\n  }\n\n  return entries\n    .filter((entry) => entry.isFile() && isGeneratedImageFile(entry.name))\n    .map((entry) => path.join(imageDir, entry.name))\n    .sort();\n}\n\nasync function generatedImageMarkdown(input: {\n  codexHome?: string;\n  sessionId: string | null;\n  excludePaths?: Set<string>;\n}): Promise<string> {\n  const imagePaths = (await listGeneratedImagePaths(input))\n    .filter((imagePath) => !input.excludePaths?.has(imagePath));\n\n  return imagePaths\n    .map((imagePath, index) => `![generated image ${index + 1}](${imagePath})`)\n    .join(\"\\n\\n\");\n}"],
  ["    const generatedImagesMessage = outputMessage.trim().length > 0\n      ? \"\"\n      : await generatedImageMarkdown({\n          codexHome: input.codexHome,\n          sessionId,\n        });\n    const finalMessage = outputMessage.trim().length > 0 ? outputMessage : generatedImagesMessage;", "    const generatedImagesMessage = await generatedImageMarkdown({\n      codexHome: input.codexHome,\n      sessionId,\n      excludePaths: existingGeneratedImages,\n    });\n    const finalMessage = [outputMessage.trimEnd(), generatedImagesMessage]\n      .filter((value) => value.length > 0)\n      .join(\"\\n\\n\");"],

  // Realtime transcript image attachments. Upstream transcript sync only renders
  // local Markdown image links as text; detect newly emitted local images and send
  // each image once as a Discord attachment while keeping the rolling text message.
  ["import { createHash } from \"node:crypto\";", "import { createHash } from \"node:crypto\";\nimport { existsSync } from \"node:fs\";\nimport path from \"node:path\";"],
  ["function sanitizeDiscordText(value: string): string {\n  return value.replace(/@/g, \"[at]\").trimEnd();\n}", "function normalizeTranscriptImagePath(reference: string): string | null {\n  if (reference.startsWith(\"file://\")) {\n    try {\n      const pathname = decodeURIComponent(new URL(reference).pathname);\n      return process.platform === \"win32\" ? pathname.replace(/^\\/([A-Za-z]:\\/)/, \"$1\") : pathname;\n    } catch {\n      return null;\n    }\n  }\n\n  return path.isAbsolute(reference) ? reference : null;\n}\n\nfunction transcriptImageFiles(messages: TranscriptMessage[]) {\n  const files: Array<{ attachment: string; name: string }> = [];\n  const seen = new Set<string>();\n  const pattern = /!\\[[^\\]]*]\\(([^)]+)\\)/g;\n\n  for (const message of messages) {\n    for (const match of message.text.matchAll(pattern)) {\n      const reference = (match[1] ?? \"\").trim().replace(/^<|>$/g, \"\");\n      if (!reference || /^https?:\\/\\//i.test(reference) || seen.has(reference)) {\n        continue;\n      }\n\n      const localPath = normalizeTranscriptImagePath(reference);\n      if (!localPath || !existsSync(localPath)) {\n        continue;\n      }\n\n      seen.add(reference);\n      files.push({ attachment: localPath, name: path.basename(localPath) || \"codex-image.png\" });\n    }\n  }\n\n  return files;\n}\n\nfunction stripLocalTranscriptImageMarkdown(value: string): string {\n  return value.replace(/!\\[[^\\]]*]\\(([^)]+)\\)/g, (match, reference: string) => {\n    const rawReference = String(reference ?? \"\").trim().replace(/^<|>$/g, \"\");\n    if (/^https?:\\/\\//i.test(rawReference)) {\n      return match;\n    }\n\n    const localPath = normalizeTranscriptImagePath(rawReference);\n    return localPath && existsSync(localPath) ? \"\" : match;\n  });\n}\n\nfunction sanitizeDiscordText(value: string): string {\n  return stripLocalTranscriptImageMarkdown(value).replace(/@/g, \"[at]\").trimEnd();\n}"],
  ["      const transcriptDiscordMessageId = await upsertTranscriptDiscordMessage({\n        guild: input.guild,\n        channel,\n        content: formatRollingTranscriptUpdateMessage(transcriptMessages),\n      });\n      channel.lastTranscriptDiscordMessageId = transcriptDiscordMessageId;\n      postedMessages += newMessages.length;", "      const transcriptDiscordMessageId = await upsertTranscriptDiscordMessage({\n        guild: input.guild,\n        channel,\n        content: formatRollingTranscriptUpdateMessage(transcriptMessages),\n      });\n      channel.lastTranscriptDiscordMessageId = transcriptDiscordMessageId;\n\n      const imageFiles = transcriptImageFiles(newMessages);\n      if (imageFiles.length > 0 && input.guild.sendTextMessage) {\n        await input.guild.sendTextMessage(channel.discordChannelId, {\n          allowedMentions: { parse: [] },\n          content: \"生成画像\",\n          embeds: [],\n          files: imageFiles,\n        });\n      }\n\n      postedMessages += newMessages.length;"],
  ["  const expanded = codexProgressMessages.get(messageId)?.expanded ?? view.view.expanded;\n  return formatCodexThoughtView(view, { expanded });", "  const expanded = codexProgressMessages.get(messageId)?.expanded ?? view.view.expanded;\n  const rendered = formatCodexThoughtView(view, { expanded });\n  if (Array.isArray((message as DiscordMessagePayload).files) && (message as DiscordMessagePayload).files!.length > 0) {\n    rendered.files = (message as DiscordMessagePayload).files;\n  }\n  return rendered;"],

  // Help / channel boundaries.
  ["Codex 운영 콘솔 사용법", "Codex 運用コンソールの使い方"],
  ["main/admin 채널은 운영 전용입니다. 파일 탐색, 세션 생성/동기화, 봇 관리만 수행하고 Codex 대화는 session 채널에서 진행합니다.", "main/admin チャンネルは運用専用です。ファイル閲覧、セッション作成・同期、Bot管理を行い、Codexとの会話は session チャンネルで行います。"],
  ["main/admin 채널은 운영 전용입니다. Codex 대화, 리뷰, 테스트 수정, 모델 설정은 새 채팅 또는 동기화된 session 채널에서 실행하세요.", "main/admin チャンネルは運用専用です。Codexとの会話、レビュー、テスト修正、モデル設定は新規または同期済みの session チャンネルで実行してください。"],
  ["session 채널은 Codex 대화 전용입니다. 세션 동기화, 새 채팅 생성, 봇 재등록/재시작은 main/admin 채널에서 실행하세요.", "session チャンネルはCodexとの会話専用です。セッション同期、新規チャット作成、Botの再登録・再起動は main/admin チャンネルで実行してください。"],
  ["이 채널은 Codex 세션과 연결되어 있습니다. 자연어는 Codex로 보내고, shell 명령은 `!` 접두어를 붙입니다.", "このチャンネルはCodexセッションに接続されています。通常の文章はCodexへ送信され、shellコマンドは先頭に `!` を付けます。"],
  ["main 채널은 운영 전용입니다.", "main チャンネルは運用専用です。"],
  ["Codex와 대화하거나 모델/리뷰 명령을 실행하려면 session 채널을 사용하세요.", "Codexとの会話やモデル・レビューコマンドの実行には session チャンネルを使用してください。"],
  ["Codex와 대화하려면 /chat-new로 세션 채널을 만들거나 기존 session 채널에서 메시지를 보내세요.", "Codexと会話するには /chat-new でsessionチャンネルを作成するか、既存の session チャンネルでメッセージを送ってください。"],
  ["모델 설정과 Codex 요청은 session 채널에서 실행하세요.", "モデル設定とCodexへの依頼は session チャンネルで実行してください。"],
  ["리뷰는 session 채널에서 실행하거나 /chat-new로 새 session을 만든 뒤 요청하세요.", "レビューは session チャンネルで実行するか、/chat-new で新しいsessionを作成してから依頼してください。"],
  ["테스트 수정 요청은 session 채널에서 실행하세요. main에서는 !pnpm test처럼 shell만 실행할 수 있습니다.", "テスト修正の依頼は session チャンネルで実行してください。main では `!pnpm test` のようなshellコマンドのみ実行できます。"],
  ["이 명령은 session 채널 전용입니다.", "このコマンドは session チャンネル専用です。"],
  ["현재 세션을 보관하려면 해당 session 채널에서 /archive 또는 archive confirm을 실행하세요.", "現在のセッションをアーカイブするには、その session チャンネルで /archive または `archive confirm` を実行してください。"],
  ["이 명령은 main 채널 전용입니다.", "このコマンドは main チャンネル専用です。"],
  ["봇 명령어 재등록과 재시작은 main/admin 채널에서 실행하세요.", "Botコマンドの再登録と再起動は main/admin チャンネルで実行してください。"],
  ["메시지 삭제는 관리자 채널에서 /clear 또는 clear <개수>로 실행하세요.", "メッセージ削除は管理チャンネルで /clear または `clear <件数>` を実行してください。"],
  ["세션 동기화는 main/admin 채널에서 실행하세요.", "セッション同期は main/admin チャンネルで実行してください。"],
  ["새 Codex 채팅 채널은 main/admin 채널에서 /chat-new로 만드세요.", "新しいCodexチャットチャンネルは main/admin チャンネルで /chat-new を実行して作成してください。"],

  // Generic UI headings and labels.
  ["이 채널에서는 실행할 수 없습니다", "このチャンネルでは実行できません"],
  ["다음 단계", "次の手順"],
  ["현재 채널 상태", "現在のチャンネル状態"],
  ["파일 탐색", "ファイル閲覧"],
  ["동기화 상태", "同期状態"],
  ["봇 명령어 재등록", "Botコマンド再登録"],
  ["Git 상태", "Git状態"],
  ["Git 변경 요약", "Git変更差分"],
  ["Git 충돌 점검", "Git競合チェック"],
  ["테스트 실행", "テスト実行"],
  ["Codex 프로젝트 요약", "Codexでプロジェクトを要約"],
  ["Codex 변경 리뷰", "Codexで変更をレビュー"],
  ["Codex 테스트 수정", "Codexでテストを修正"],
  ["작업 선택", "操作を選択"],
  ["새 일반 채팅", "新規一般チャット"],
  ["현재 폴더 채팅", "現在のフォルダーでチャット"],
  ["세션 선택 동기화", "セッションを選択して同期"],
  ["유지보수", "メンテナンス"],
  ["전체 동기화", "すべて同期"],
  ["삭제 미리보기", "削除プレビュー"],
  ["명령어 재등록", "コマンド再登録"],
  ["세션 선택", "セッション選択"],
  ["전체 다시 동기화", "すべて再同期"],
  ["채팅 시작 시 동기화", "チャット開始時に同期"],
  ["실시간 동기화", "リアルタイム同期"],
  ["이 채널 삭제", "このチャンネルを削除"],
  ["채널만 삭제", "チャンネルのみ削除"],
  ["채널+카테고리 삭제", "チャンネル＋カテゴリを削除"],
  ["삭제할 채널 하나 선택", "削除するチャンネルを選択"],
  ["이 세션 보관", "このセッションをアーカイブ"],
  ["Codex에게 요청", "Codexに依頼"],
  ["파일 보기", "ファイルを見る"],
  ["Codex 리뷰", "Codexレビュー"],
  ["테스트 수정", "テスト修正"],
  ["충돌 점검", "競合チェック"],
  ["이전 페이지", "前のページ"],
  ["다음 페이지", "次のページ"],
  ["여기서 새 채팅", "ここから新規チャット"],
  ["상위 폴더", "親フォルダー"],
  ["목록으로", "一覧へ"],
  ["새로고침", "更新"],
  ["목록 새로고침", "一覧を更新"],
  ["항목 열기", "項目を開く"],
  ["Diff 보기", "Diffを見る"],
  ["테스트 다시 실행", "テストを再実行"],
  ["Codex에게 수정 요청", "Codexに修正を依頼"],
  ["이 파일을 Codex로 요약", "このファイルをCodexで要約"],
  ["이 파일을 Codex로 개선/수정", "このファイルをCodexで改善・修正"],
  ["유지보수 패널", "メンテナンスパネル"],
  ["봇 재시작", "Bot再起動"],
  ["봇 개발 채팅", "Bot開発チャット"],
  ["권장 순서", "推奨手順"],
  ["타입체크", "型チェック"],
  ["전체 출력", "全出力"],
  ["전체 오류 출력", "全エラー出力"],
  ["생성 이미지 첨부", "生成画像を添付"],
  ["전체 답변은 첨부 파일", "回答全文は添付ファイル"],

  // Help examples.
  ["Start here", "まずここから"],
  ["Codex chat workflow", "Codexチャットの流れ"],
  ["Workspace operations", "ワークスペース操作"],
  ["Admin slash commands", "管理用スラッシュコマンド"],
  ["Session slash commands", "セッション用スラッシュコマンド"],
  ["Careful operations", "注意が必要な操作"],
  ["Channel boundary", "チャンネルの役割"],
  ["Primary flow", "基本的な使い方"],
  ["Shell in this session", "このセッションでShellを実行"],
  ["Session controls", "セッション操作"],
  ["Permission denied", "権限がありません"],
  ["새 작업", "新しい作業"],
  ["/where 또는 /status", "/where または /status"],
  ["README 요약해줘", "READMEを要約して"],
  ["보안 위험 위주", "セキュリティリスクを中心に"],
  ["현재 채널", "現在のチャンネル"],
  ["이번 채널", "このチャンネル"],
  ["이번 작업 맥락 정리", "今回の作業コンテキストを整理"],
  ["UI 개선해줘", "UIを改善して"],
  ["오늘 계획 정리", "今日の計画を整理"],
  ["README 정리", "README整理"],
  ["새 채팅 채널에서: README에 사용법 추가해줘", "新しいチャットチャンネルで: READMEに使い方を追加して"],
  ["sync 또는 sync all 25", "sync または sync all 25"],
  ["그 파일 구조 설명해줘", "そのファイル構造を説明して"],
  ["이 버그 고쳐줘", "このバグを直して"],
  ["테스트까지 돌려줘", "テストまで実行して"],

  // Slash command descriptions.
  ["Codex에게 자연어로 요청합니다.", "Codexに自然言語で依頼します。"],
  ["Codex에게 보낼 요청", "Codexへ送る依頼内容"],
  ["지원되는 Codex/bridge 단축 명령을 실행합니다. 예: model, diff, mcp list", "対応しているCodex/bridgeのショートカットを実行します。例: model, diff, mcp list"],
  ["앞의 /를 제외한 Codex 명령어 이름", "先頭の / を除いたCodexコマンド名"],
  ["명령어 뒤에 붙일 프롬프트 또는 인자", "コマンドに続けるプロンプトまたは引数"],
  ["현재 작업 맥락을 압축 요약하도록 Codex에 요청합니다.", "現在の作業コンテキストを圧縮して要約するようCodexに依頼します。"],
  ["compact에 함께 전달할 요청", "compactと一緒に渡す依頼"],
  ["지정한 skill 관점으로 Codex 요청을 실행합니다.", "指定したskillの観点でCodexへの依頼を実行します。"],
  ["사용할 skill 이름", "使用するskill名"],
  ["skill과 함께 실행할 요청", "skillと一緒に実行する依頼"],
  ["이 Discord 채널의 이후 Codex 요청에 사용할 모델을 설정합니다.", "このDiscordチャンネルで以後のCodex依頼に使用するモデルを設定します。"],
  ["전환하거나 확인할 모델 이름", "切り替え・確認するモデル名"],
  ["이 채널의 Codex 요청을 빠른 응답 모드로 전환합니다.", "このチャンネルのCodex依頼を高速応答モードに切り替えます。"],
  ["이 채널의 Codex 요청을 작업 수행 모드로 전환합니다.", "このチャンネルのCodex依頼を作業実行モードに切り替えます。"],
  ["이 채널의 Codex 실행 모드를 설정하거나 기본값으로 되돌립니다.", "このチャンネルのCodex実行モードを設定するか、既定値へ戻します。"],
  ["default, fast, task 중 하나", "default / fast / task のいずれか"],
  ["현재 채널의 연결 상태, 작업 위치, Codex 세션을 보여줍니다.", "現在のチャンネルの接続状態、作業場所、Codexセッションを表示します。"],
  ["현재 작업 위치에서 git diff 요약을 보여줍니다.", "現在の作業場所のgit diff概要を表示します。"],
  ["현재 변경사항을 Codex에게 리뷰시킵니다.", "現在の変更内容をCodexにレビューさせます。"],
  ["리뷰 관점 또는 추가 지시", "レビュー観点または追加指示"],
  ["테스트 실행, 실패 분석, 수정을 Codex에게 요청합니다.", "テスト実行、失敗分析、修正をCodexに依頼します。"],
  ["현재 채널 또는 프로젝트 맥락을 요약합니다.", "現在のチャンネルまたはプロジェクトのコンテキストを要約します。"],
  ["요약할 대상", "要約する対象"],
  ["현재 Discord 채널이 연결된 컴퓨터/작업 위치를 보여줍니다.", "現在のDiscordチャンネルが接続されているPC・作業場所を表示します。"],
  ["봇 명령어를 Discord에서 재등록하거나 봇 재시작을 요청합니다.", "BotコマンドをDiscordへ再登録するか、Botの再起動を要求します。"],
  ["commands 또는 restart. 비워두면 commands입니다.", "commands または restart。空欄の場合は commands です。"],
  ["restart 모드 실행을 확정합니다.", "restartモードの実行を確定します。"],
  ["관리자 채널의 최근 메시지를 삭제합니다.", "管理チャンネルの最近のメッセージを削除します。"],
  ["삭제할 최근 메시지 수. 비우면 가능한 전체 메시지를 삭제합니다.", "削除する最近のメッセージ数。空欄の場合は削除可能な全メッセージを対象にします。"],
  ["가능한 전체 메시지를 삭제합니다.", "削除可能な全メッセージを削除します。"],
  ["동기화할 활성 Codex 세션을 선택하는 목록을 엽니다.", "同期するアクティブなCodexセッションの選択一覧を開きます。"],
  ["선택 목록에 보여줄 최대 세션 수", "選択一覧に表示する最大セッション数"],
  ["활성 Codex 세션을 선택 없이 모두 동기화합니다.", "アクティブなCodexセッションをすべて同期します。"],
  ["가져올 최대 세션 수", "取得する最大セッション数"],
  ["활성 Codex 세션 목록에서 원하는 세션만 선택해 동기화합니다.", "アクティブなCodexセッション一覧から選択したセッションだけを同期します。"],
  ["현재 동기화된 카테고리/세션/보관 상태를 보여줍니다.", "現在同期されているカテゴリ・セッション・アーカイブ状態を表示します。"],
  ["동기화된 Codex 채널의 transcript 반영 방식을 선택합니다.", "同期済みCodexチャンネルへのtranscript反映方法を選択します。"],
  ["채팅 시작 시 동기화 또는 실시간 폴링", "チャット開始時同期またはリアルタイムポーリング"],
  ["동기화된 Discord 세션 채널을 삭제합니다. 먼저 preview로 확인하세요.", "同期済みDiscordセッションチャンネルを削除します。先にpreviewで確認してください。"],
  ["preview, all, channels, session 중 선택", "preview / all / channels / session から選択"],
  ["mode가 session일 때 삭제할 Codex 세션 ID", "modeがsessionの場合に削除するCodexセッションID"],
  ["실제 삭제 실행을 확정합니다.", "実際の削除実行を確定します。"],
  ["특정 Codex 세션을 브리지에서 보관 처리해 다음 sync에서 제외합니다.", "指定したCodexセッションをbridge側でアーカイブし、次回syncから除外します。"],
  ["보관할 Codex 세션 ID", "アーカイブするCodexセッションID"],
  ["실제 보관 실행을 확정합니다.", "実際のアーカイブ実行を確定します。"],
  ["특정 시간, 주기, 요일에 기존 Discord 명령을 반복 실행합니다.", "指定時刻・間隔・曜日に既存のDiscordコマンドを繰り返し実行します。"],
  ["create, list, delete 중 선택", "create / list / delete から選択"],
  ["create일 때 once, every, daily, weekly 중 선택", "createの場合は once / every / daily / weekly から選択"],
  ["반복 실행할 기존 채팅형 명령. 예: shell pnpm test, codex README 요약", "繰り返し実行する既存のチャット型コマンド。例: shell pnpm test, codex README要約"],
  ["once: YYYY-MM-DD HH:mm 또는 ISO. daily/weekly: HH:mm", "once: YYYY-MM-DD HH:mm またはISO。daily/weekly: HH:mm"],
  ["every 모드 주기. 예: 10m, 1h, 1d", "everyモードの間隔。例: 10m, 1h, 1d"],
  ["weekly 모드 요일. 예: mon,wed,fri 또는 월,수,금", "weeklyモードの曜日。例: mon,wed,fri または 月,水,金"],
  ["delete일 때 삭제할 schedule id", "deleteの場合に削除するschedule id"],
  ["새 Codex 채팅 채널을 만듭니다. 일반/현재 폴더/지정 폴더 중 위치를 고릅니다.", "新しいCodexチャットチャンネルを作成します。一般・現在のフォルダー・指定フォルダーから場所を選択します。"],
  ["새 Discord 채널/채팅 이름", "新しいDiscordチャンネル・チャット名"],
  ["general, current, path 중 선택합니다. 비우면 cwd 유무로 결정합니다.", "general / current / path から選択します。空欄の場合はcwdの有無で決定します。"],
  ["location:path일 때 Codex를 시작할 폴더 경로입니다.", "location:path の場合にCodexを開始するフォルダーパスです。"],
  ["cwd가 있을 때 해당 폴더 카테고리 아래에 생성합니다.", "cwdがある場合は、そのフォルダーのカテゴリ配下に作成します。"],
  ["채널 생성 후 첫 요청으로 안내할 프롬프트", "チャンネル作成後の最初の依頼として渡すプロンプト"],
  ["현재 Codex 세션 채널을 보관하고 다음 sync에서 제외합니다.", "現在のCodexセッションチャンネルをアーカイブし、次回syncから除外します。"],
  ["현재 위치의 파일 목록을 버튼/드롭다운 UI로 엽니다.", "現在位置のファイル一覧をボタン・ドロップダウンUIで開きます。"],
  ["현재 채널 위치에서 shell 명령을 실행합니다.", "現在のチャンネル位置でshellコマンドを実行します。"],
  ["실행할 shell 명령", "実行するshellコマンド"],

  // Default prompts sent to Codex.
  ["지금까지의 작업 맥락을 압축 요약해줘.", "これまでの作業コンテキストを圧縮して要約してください。"],
  ["skill을 적용해서 다음 요청을 처리해줘", "skillを適用して次の依頼を処理してください"],
  ["현재 변경사항을 리뷰해줘.", "現在の変更内容をレビューしてください。"],
  ["Codex CLI 명령", "Codex CLIコマンド"],
  ["을 직접 실행할 수 있는지 확인하고, 가능하면 대체 실행 방법을 제안해줘. 인자:", "を直接実行できるか確認し、可能なら代替の実行方法を提案してください。引数:"],
  ["테스트를 실행하고 실패 원인을 분석한 뒤 수정해줘. 수정 후 테스트를 다시 실행해줘", "テストを実行し、失敗原因を分析して修正してください。修正後にテストを再実行してください"],
  ["을 요약하고 다음 액션을 제안해줘", "を要約して次のアクションを提案してください"],
  ["다음 요청을 처리해줘", "次の依頼を処理してください"],
  ["선택한 파일을 요약해줘", "選択したファイルを要約してください"],
  ["선택한 파일을 개선하거나 수정해줘. 파일:", "選択したファイルを改善または修正してください。ファイル:"],
  ["현재 프로젝트 상태를 요약하고 다음 액션을 제안해줘", "現在のプロジェクト状態を要約し、次のアクションを提案してください"],
  ["현재 변경사항을 리뷰하고 위험한 부분을 알려줘", "現在の変更内容をレビューし、危険な箇所を教えてください"],
  ["테스트 실패를 분석하고 수정해줘. 수정 후 테스트도 다시 실행해줘", "テスト失敗を分析して修正してください。修正後にテストも再実行してください"],
  ["이 세션은 Codex Discord Connector 봇 자체를 Discord에서 유지보수하기 위한 세션입니다. 변경 전 Git 상태를 확인하고, 수정 후 pnpm typecheck와 pnpm test를 실행한 뒤, Discord에서 reload 또는 봇 재시작으로 반영할 수 있게 안내해줘.", "このセッションはCodex Discord Connector Bot自体をDiscordからメンテナンスするためのセッションです。変更前にGit状態を確認し、修正後にpnpm typecheckとpnpm testを実行し、DiscordからreloadまたはBot再起動で反映できるよう案内してください。"],
  ["봇 유지보수", "Botメンテナンス"],

  // Modals and client messages.
  ["요청 내용", "依頼内容"],
  ["예: README 요약해줘 / 테스트 실패 고쳐줘", "例: READMEを要約して / テスト失敗を直して"],
  ["현재 폴더에서 새 채팅", "現在のフォルダーで新規チャット"],
  ["채널 이름", "チャンネル名"],
  ["예: 지금 폴더 작업", "例: 現在のフォルダーで作業"],
  ["예: 자유 메모", "例: 自由メモ"],
  ["첫 요청", "最初の依頼"],
  ["비워두면 채널만 만들고, 새 채널에서 직접 요청할 수 있습니다.", "空欄の場合はチャンネルだけ作成し、新しいチャンネルで直接依頼できます。"],
  ["이 진행 메시지는 더 이상 펼칠 수 없습니다. 새 요청에서 다시 열어주세요.", "この進捗メッセージはこれ以上展開できません。新しい依頼から再度開いてください。"],
  ["이 Discord 클라이언트에서는 진행 메시지를 수정할 수 없습니다.", "このDiscordクライアントでは進捗メッセージを更新できません。"],
  ["이 slash command는 아직 연결되어 있지 않습니다.", "このスラッシュコマンドはまだ接続されていません。"],
  ["요청 내용이 비어 있습니다.", "依頼内容が空です。"],
  ["이 Discord 클라이언트는 모달을 열 수 없습니다.", "このDiscordクライアントではダイアログを開けません。"],
  ["이 버튼은 더 이상 사용할 수 없습니다. `help`를 다시 눌러 최신 버튼을 열어주세요.", "このボタンはもう使用できません。`help` をもう一度実行して最新のボタンを表示してください。"],

  // Maintenance panel.
  ["버튼으로 Git 상태, Diff, 충돌 점검, 테스트 실행, Codex 리뷰와 테스트 수정을 이어갑니다.", "ボタンからGit状態、Diff、競合チェック、テスト実行、Codexレビュー、テスト修正を行えます。"],
  ["버튼으로 Git 상태, Diff, 충돌 점검, 테스트 실행, 명령어 재등록과 봇 재시작을 처리합니다.", "ボタンからGit状態、Diff、競合チェック、テスト実行、コマンド再登録、Bot再起動を行えます。"],
  ["Git 상태 → 충돌 점검 → 테스트 실행 → Codex 리뷰/수정", "Git状態 → 競合チェック → テスト実行 → Codexレビュー/修正"],
  ["Git 상태 → 충돌 점검 → 테스트 실행 → 필요 시 명령어 재등록", "Git状態 → 競合チェック → テスト実行 → 必要に応じてコマンド再登録"],

  // Channel status / model / mode.
  ["Current channel target", "現在のチャンネル接続先"],
  ["이 Discord 채널이 현재 어디에 연결되어 있는지 보여줍니다.", "このDiscordチャンネルが現在どこに接続されているかを表示します。"],
  ["\"Mode\"", "\"モード\""],
  ["\"Timeout\"", "\"タイムアウト\""],
  ["\"Target\"", "\"接続先\""],
  ["\"Workspace root\"", "\"ワークスペースルート\""],
  ["\"Working directory\"", "\"作業ディレクトリ\""],
  ["\"Codex session\"", "\"Codexセッション\""],
  ["\"Codex model\"", "\"Codexモデル\""],
  ["\"(not linked yet)\"", "\"（未接続）\""],
  ["이 Discord 채널의 이후 Codex 요청에 선택한 모델을 사용합니다. 봇이 재시작되면 기본 모델로 돌아갑니다.", "このDiscordチャンネルで以後のCodex依頼に選択したモデルを使用します。Botを再起動すると既定モデルに戻ります。"],
  ["이 Discord 채널의 Codex 실행 모드를 기본 설정으로 되돌렸습니다.", "このDiscordチャンネルのCodex実行モードを既定設定に戻しました。"],
  ["이 Discord 채널의 이후 Codex 요청에 선택한 실행 모드를 사용합니다. 봇이 재시작되면 기본 모드로 돌아갑니다.", "このDiscordチャンネルで以後のCodex依頼に選択した実行モードを使用します。Botを再起動すると既定モードに戻ります。"],
  ["현재 브리지 상태 파일에 기록된 동기화 요약입니다.", "現在bridge状態ファイルに記録されている同期概要です。"],

  // Sync / reload / delete / archive.
  ["동기화된 Codex 세션 채널을 주기적으로 확인해 새 desktop 대화 내용을 Discord에 반영합니다.", "同期済みCodexセッションチャンネルを定期的に確認し、新しいdesktop側の会話内容をDiscordへ反映します。"],
  ["실시간 폴링은 끄고, 동기화된 세션 채널에서 다시 채팅을 시작할 때 최신 desktop 대화 내용을 먼저 반영합니다.", "リアルタイムポーリングを停止し、同期済みセッションチャンネルで再びチャットを開始するときに最新のdesktop側会話を先に反映します。"],
  ["봇 프로세스 재시작은 현재 응답을 보낸 뒤 연결을 잠시 끊습니다. `pnpm connect start`로 실행 중이면 자동으로 다시 올라오고, 직접 `pnpm dev:bot`로 실행 중이면 터미널에서 다시 시작해야 합니다.", "Botプロセスの再起動では現在の応答送信後に接続が一時的に切れます。`pnpm connect start` で実行中なら自動で再起動し、`pnpm dev:bot` を直接実行している場合はターミナルから再起動する必要があります。"],
  ["명령어만 재등록", "コマンドのみ再登録"],
  ["Discord slash command를 재등록한 뒤 봇 재시작을 예약합니다.", "Discordスラッシュコマンドを再登録した後、Bot再起動を予約します。"],
  ["Discord slash command를 현재 실행 중인 봇 코드 기준으로 다시 등록합니다.", "Discordスラッシュコマンドを現在実行中のBotコードを基準に再登録します。"],
  ["재시작 요청을 보냈습니다. `pnpm connect start`로 실행 중이면 곧 새 프로세스로 돌아옵니다.", "再起動要求を送信しました。`pnpm connect start` で実行中なら、まもなく新しいプロセスで復帰します。"],
  ["Discord slash command 재등록이 완료되었습니다.", "Discordスラッシュコマンドの再登録が完了しました。"],
  ["관리자 채널의 가능한 최근 메시지를 모두 삭제하려면 확인 명령을 다시 실행하세요.", "管理チャンネルの削除可能な最近のメッセージをすべて削除するには、確認コマンドをもう一度実行してください。"],

  // New chat result.
  ["Codex chat channel creation failed", "Codexチャットチャンネルの作成に失敗しました"],
  ["Unknown new chat failure", "新規チャット作成で不明なエラーが発生しました"],
  ["Codex chat channel ready", "Codexチャットチャンネルを作成しました"],
  ["지정한 작업 위치에 연결된 새 Codex 채널을 만드는 중입니다.", "指定した作業場所に接続する新しいCodexチャンネルを作成しています。"],
  ["카테고리 없는 일반 Codex 채팅 채널을 만드는 중입니다.", "カテゴリなしの一般Codexチャットチャンネルを作成しています。"],
  ["새 Discord 채널이 Codex 대기 세션으로 연결되었습니다. 그 채널에서 바로 메시지를 보내면 첫 응답 때 실제 Codex 세션 ID가 자동으로 붙습니다.", "新しいDiscordチャンネルをCodex待機セッションとして接続しました。そのチャンネルでメッセージを送ると、最初の応答時に実際のCodexセッションIDが自動で紐づきます。"],
  ["새 채널에서 자연어로 바로 대화하세요. 예: 이 프로젝트 구조 설명해줘", "新しいチャンネルでそのまま自然文で話しかけてください。例: このプロジェクト構成を説明して"],
  ["일반 채팅 하나 더", "一般チャットをもう1つ作成"],
  ["기존 세션 선택", "既存セッションを選択"],
  ["\"Channel\"", "\"チャンネル\""],
  ["\"Category\"", "\"カテゴリ\""],
  ["\"Name\"", "\"名前\""],
  ["\"Workspace\"", "\"ワークスペース\""],
  ["\"Next step\"", "\"次の手順\""],

  // Session synchronization.
  ["Codex 세션을 읽고 Discord 카테고리/채널을 생성하는 중입니다.", "Codexセッションを読み込み、Discordカテゴリ・チャンネルを作成しています。"],
  ["동기화할 Codex 세션 목록을 불러오는 중입니다.", "同期するCodexセッション一覧を読み込んでいます。"],
  ["동기화할 Codex 세션 선택", "同期するCodexセッションを選択"],
  ["전체 활성 세션 동기화", "すべてのアクティブセッションを同期"],
  ["드롭다운에서 가져올 Codex 세션을 여러 개 선택하세요. 선택한 세션만 Discord 채널로 생성됩니다.", "ドロップダウンから取得するCodexセッションを複数選択してください。選択したセッションだけがDiscordチャンネルとして作成されます。"],
  ["동기화할 활성 Codex 세션이 없습니다.", "同期できるアクティブなCodexセッションはありません。"],
  ["Codex 폴더는 Discord 카테고리로, Codex 세션은 Discord 채널로 매핑되었습니다.", "CodexフォルダーをDiscordカテゴリへ、CodexセッションをDiscordチャンネルへマッピングしました。"],
  ["활성 Codex 세션만 Discord 채널로 동기화하는 중입니다.", "アクティブなCodexセッションだけをDiscordチャンネルへ同期しています。"],
  ["삭제될 Discord 리소스를 확인하세요. 아래 버튼으로 확정할 수 있습니다. Codex 세션 파일은 삭제하지 않습니다. 텍스트 명령은", "削除されるDiscordリソースを確認してください。下のボタンから確定できます。Codexセッションファイルは削除しません。テキストコマンドは"],
  [" 입니다.", " です。"],
  ["Discord에 생성했던 동기화 채널을 삭제했습니다. 로컬 Codex 세션 파일은 그대로 유지됩니다.", "Discordに作成した同期チャンネルを削除しました。ローカルCodexセッションファイルはそのまま保持されます。"],
  ["동기화로 생성된 Discord 채널과 카테고리를 삭제하는 중입니다. Codex 세션 파일은 삭제하지 않습니다.", "同期によって作成されたDiscordチャンネルとカテゴリを削除しています。Codexセッションファイルは削除しません。"],
  ["선택한 동기화 세션 채널만 삭제하는 중입니다. 카테고리와 Codex 세션 파일은 유지합니다.", "選択した同期セッションチャンネルだけを削除しています。カテゴリとCodexセッションファイルは保持します。"],
  ["동기화로 생성된 Discord 채널만 삭제하는 중입니다. 카테고리와 Codex 세션 파일은 유지합니다.", "同期によって作成されたDiscordチャンネルだけを削除しています。カテゴリとCodexセッションファイルは保持します。"],
  ["이 세션을 브리지 보관 목록에 추가하고 연결된 Discord 채널 매핑을 정리하는 중입니다. 로컬 Codex 세션 파일은 건드리지 않습니다.", "このセッションをbridgeのアーカイブ一覧へ追加し、関連するDiscordチャンネルのマッピングを整理しています。ローカルCodexセッションファイルには触れません。"],
  ["정말 보관하려면 아래 버튼을 누르거나 `archive confirm` 또는 `sync archive <session-id> confirm`을 사용하세요. 보관은 브리지 상태에 기록되어 다음 sync부터 제외됩니다.", "本当にアーカイブするには下のボタンを押すか、`archive confirm` または `sync archive <session-id> confirm` を使用してください。アーカイブ状態はbridgeに記録され、次回syncから除外されます。"],
  ["이 세션은 다음 동기화부터 제외됩니다. 로컬 Codex 원본 세션 파일은 이동하거나 삭제하지 않았습니다.", "このセッションは次回の同期から除外されます。ローカルのCodex元セッションファイルは移動・削除していません。"],
  ["**이전 Codex 대화 맥락**", "**以前のCodex会話コンテキスト**"],
  ["세션:", "セッション:"],
  ["최근 업데이트:", "最終更新:"],

  // Progress/status text.
  ["Codex 작업 시작", "Codex作業開始"],
  ["요청 접수됨", "依頼受付済み"],
  ["세션 연결됨", "セッション接続済み"],
  ["답변 작성 중", "回答作成中"],
  ["요청 분석 중", "依頼分析中"],
  ["작업 단계 실행 중", "作業ステップ実行中"],
  ["작업 단계 완료", "作業ステップ完了"],
  ["응답 정리 중", "応答整理中"],
  ["오류 확인 중", "エラー確認中"],
  ["작업 중", "作業中"],
  ["생각중...", "考え中..."],
  ["파일 탐색중...", "ファイル探索中..."],
  ["파일 편집중...", "ファイル編集中..."],
  ["편집중", "編集中"],
  ["편집함", "編集済み"],
  ["탐색마침", "探索完了"],
  ["파일 수정 완료", "ファイル修正完了"],
  ["이미지 생성 중", "画像生成中"],
  ["파일 탐색 중", "ファイル探索中"],
  ["웹 검색 중", "Web検索中"],
  ["파일 수정 중", "ファイル修正中"],
  ["명령 실행 중", "コマンド実行中"],
  ["도구 실행 중", "ツール実行中"],
  ["컨텍스트 압축 중", "コンテキスト圧縮中"],
  ["작업 시작", "作業開始"],
  ["작업 완료", "作業完了"],
  ["생각 닫기", "思考を閉じる"],
  ["생각 열기", "思考を開く"],
  ["Codex 작업 중", "Codex作業中"],
  ["진행:", "進捗:"],
  ["**요청**", "**依頼**"],
  ["생각과 중간 출력은 버튼으로 열 수 있습니다.", "思考と途中出力はボタンから開けます。"],
  ["**생각 / 중간 출력**", "**思考 / 途中出力**"],
  ["아직 표시할 중간 출력이 없습니다.", "まだ表示できる途中出力はありません。"],
  ["일부만 표시", "一部のみ表示"],
  ["예약 실행", "予約実行"],
  ["개 파일", "個のファイル"],
  ["개의 파일 탐색중...", "個のファイルを探索中..."],

  // Attachment notices.
  ["은 첨부 파일", "は添付ファイル"],
  ["에서 확인하세요.", "で確認してください。"],

  // Scheduler UI/errors and Japanese weekday aliases.
  ["every 값은 10m, 1h, 1d 형식이어야 합니다.", "everyの値は 10m, 1h, 1d の形式で指定してください。"],
  ["at 값은 HH:mm 형식이어야 합니다.", "atの値は HH:mm 形式で指定してください。"],
  ["at 시간은 00:00부터 23:59 사이여야 합니다.", "atの時刻は 00:00 から 23:59 の範囲で指定してください。"],
  ["once 스케줄에는 at 값이 필요합니다.", "onceスケジュールにはatの値が必要です。"],
  ["once at 값은 YYYY-MM-DD HH:mm 또는 ISO 날짜여야 합니다.", "onceのat値は YYYY-MM-DD HH:mm またはISO日時で指定してください。"],
  ["weekly 스케줄에는 weekdays 값이 필요합니다. 예: mon,wed,fri", "weeklyスケジュールにはweekdaysの値が必要です。例: mon,wed,fri"],
  ["예약할 command 값이 비어 있거나 schedule 명령 자체입니다.", "予約するcommandの値が空、またはscheduleコマンド自体になっています。"],
  ["다음 실행 시간이 없습니다. once 시간은 현재보다 이후여야 합니다.", "次回実行時刻がありません。onceの時刻は現在より未来である必要があります。"],
  ["등록된 schedule이 없습니다.", "登録済みscheduleはありません。"],
  ["\"일\"", "\"日\""],
  ["\"월\"", "\"月\""],
  ["\"화\"", "\"火\""],
  ["\"수\"", "\"水\""],
  ["\"목\"", "\"木\""],
  ["\"금\"", "\"金\""],
  ["\"토\"", "\"土\""],

  // Text command alias: keep maintenance usable in Japanese instead of Korean.
  ["maintenance|maint|유지보수", "maintenance|maint|メンテナンス"],
];

const orderedTranslations = [...translations].sort((a, b) => b[0].length - a[0].length);

function applyMultiBackendBridgePatch(source) {
  let out = source;

  // Message handler: hand messages to the local/ChatGPT queue router before the
  // upstream Codex-oriented command router. Returning false preserves the full
  // upstream Codex path (resume/progress/realtime/image attachments).
  out = out.replace(
    'import { classifyCommand } from "../../../packages/core/src/index.js";',
    `import { classifyCommand } from "../../../packages/core/src/index.js";\nimport { tryHandleMultiBackendMessage } from "${INTEGRATION_URL}";`,
  );
  out = out.replace(
    '  imageAttachments?: Array<{ url: string; name: string; contentType?: string | null; size?: number | null }>;\n  roleIds: string[];',
    '  imageAttachments?: Array<{ url: string; name: string; contentType?: string | null; size?: number | null }>;\n  attachments?: Array<{ url?: string; name: string; contentType?: string | null; size?: number | null; localPath?: string }>;\n  messageId?: string;\n  guildId?: string;\n  authorName?: string;\n  timestamp?: string;\n  botMentioned?: boolean;\n  botUserId?: string;\n  roleIds: string[];',
  );
  out = out.replace(
    '    if (!channelContext) {\n      return;\n    }\n\n    const routed = routeDiscordMessage({',
    '    if (!channelContext) {\n      return;\n    }\n\n    if (await tryHandleMultiBackendMessage({ message, channelContext, handlerInput: input })) {\n      return;\n    }\n\n    const routed = routeDiscordMessage({',
  );

  // Discord message metadata + all attachments for ChatGPT Queue. The existing
  // imageAttachments path remains intact for explicit Codex image input.
  out = out.replace(
    '    const imageAttachments = [...discordMessage.attachments.values()]',
    '    const bridgeAttachments = [...discordMessage.attachments.values()].map((attachment, index) => ({\n      url: attachment.url,\n      name: attachment.name || `attachment-${index + 1}`,\n      contentType: attachment.contentType,\n      size: attachment.size,\n    }));\n    const imageAttachments = [...discordMessage.attachments.values()]',
  );
  out = out.replace(
    '      imageAttachments,\n      roleIds: getRoleIds(discordMessage),',
    '      imageAttachments,\n      attachments: bridgeAttachments,\n      messageId: discordMessage.id,\n      guildId: discordMessage.guild?.id ?? "",\n      authorName: discordMessage.author.globalName ?? discordMessage.author.username,\n      timestamp: discordMessage.createdAt.toISOString(),\n      botMentioned: Boolean(discordMessage.client.user && discordMessage.mentions.users.has(discordMessage.client.user.id)),\n      botUserId: discordMessage.client.user?.id ?? "",\n      roleIds: getRoleIds(discordMessage),',
  );

  // Slash commands for the new formal routes.
  out = out.replace(
    'export const DISCORD_APPLICATION_COMMANDS: readonly DiscordApplicationCommandDefinition[] = [',
    `export const DISCORD_APPLICATION_COMMANDS: readonly DiscordApplicationCommandDefinition[] = [
  {
    name: "ask",
    description: "ChatGPT Queueへ依頼を登録します。AIはこの時点では起動しません。",
    options: [stringOption({ name: "prompt", description: "ChatGPT + DevSpaceへ渡す依頼", required: true })],
  },
  {
    name: "local",
    description: "AIを使わず許可済みローカル操作を実行します。",
    options: [stringOption({
      name: "command",
      description: "実行する安全なローカル操作",
      required: true,
      choices: [
        { name: "status", value: "status" },
        { name: "ls", value: "ls" },
        { name: "pwd", value: "pwd" },
        { name: "git status", value: "git status" },
        { name: "git diff", value: "git diff" },
        { name: "log", value: "log" },
        { name: "build-status", value: "build-status" },
      ],
    })],
  },
  {
    name: "backend",
    description: "このチャンネルの既定処理先を設定します。",
    options: [stringOption({
      name: "backend",
      description: "Local優先のautoを推奨",
      required: true,
      choices: [
        { name: "auto", value: "auto" },
        { name: "local", value: "local" },
        { name: "chatgpt", value: "chatgpt" },
        { name: "codex", value: "codex" },
      ],
    })],
  },
  {
    name: "public-assistant",
    description: "一般向けBotの応答を管理します。管理者専用です。",
    options: [stringOption({
      name: "mode",
      description: "応答の再開・停止・状態確認",
      required: true,
      choices: [
        { name: "再開", value: "start" },
        { name: "停止", value: "stop" },
        { name: "状態", value: "status" },
      ],
    })],
  },
  { name: "bridge-status", description: "Discord Remote Control / ChatGPT Bridgeの状態を表示します。" },
  {
    name: "confirm",
    description: "危険操作の確認トークンを承認します。",
    options: [stringOption({ name: "token", description: "8桁の確認トークン", required: true })],
  },
  {
    name: "cancel",
    description: "危険操作の確認待ちを取り消します。",
    options: [stringOption({ name: "token", description: "8桁の確認トークン", required: true })],
  },`,
  );
  out = out.replace(
    '  switch (interaction.commandName) {\n    case "codex":',
    `  switch (interaction.commandName) {
    case "ask":
      return \`@chatgpt \${interaction.options.getString("prompt", true)?.trim() ?? ""}\`.trim();
    case "local":
      return \`@local \${interaction.options.getString("command", true)?.trim() ?? ""}\`.trim();
    case "backend": {
      const backend = interaction.options.getString("backend", true)?.trim().toLowerCase();
      return backend ? \`__mb_backend \${backend}\` : null;
    }
    case "public-assistant": {
      const mode = interaction.options.getString("mode", true)?.trim().toLowerCase();
      return mode ? \`__mb_public_assistant \${mode}\` : null;
    }
    case "bridge-status":
      return "__mb_status";
    case "confirm": {
      const token = interaction.options.getString("token", true)?.trim().toLowerCase();
      return token ? \`__mb_confirm \${token}\` : null;
    }
    case "cancel": {
      const token = interaction.options.getString("token", true)?.trim().toLowerCase();
      return token ? \`__mb_cancel \${token}\` : null;
    }
    case "codex":`,
  );

  // Legacy convenience commands that used to spend Codex quota are redirected
  // to the ChatGPT queue. Codex-only administration commands remain explicit.
  out = out.replace(
    'case "review":\n      return `__cdc_codex_review ${prompt?.trim() || "現在の変更内容をレビューしてください。"}`;',
    'case "review":\n      return `@chatgpt ${prompt?.trim() || "現在の変更内容をレビューしてください。"}`;',
  );
  out = out.replace(
    'case "review":\n      return `__cdc_codex_review ${interaction.options.getString("prompt")?.trim() || "現在の変更内容をレビューしてください。"}`;',
    'case "review":\n      return `@chatgpt ${interaction.options.getString("prompt")?.trim() || "現在の変更内容をレビューしてください。"}`;',
  );
  out = out.replace(
    'case "fix-tests":\n      return "codex テストを実行し、失敗原因を分析して修正してください。修正後にテストを再実行してください";',
    'case "fix-tests":\n      return "@chatgpt テストを実行し、失敗原因を分析して修正してください。修正後にテストを再実行してください";',
  );
  out = out.replace(
    'case "summarize":\n      return `codex ${interaction.options.getString("target")?.trim() || "現在のチャンネル"}を要約して次のアクションを提案してください`;',
    'case "summarize":\n      return `@chatgpt ${interaction.options.getString("target")?.trim() || "現在のチャンネル"}を要約して次のアクションを提案してください`;',
  );

  // Buttons/file-browser actions that previously invoked Codex now enqueue ChatGPT work.
  const chatGptRedirects = [
    ["codex 選択したファイルを要約してください:", "@chatgpt 選択したファイルを要約してください:"],
    ["codex 選択したファイルを改善または修正してください。ファイル:", "@chatgpt 選択したファイルを改善または修正してください。ファイル:"],
    ["codex 現在のプロジェクト状態を要約し、次のアクションを提案してください", "@chatgpt 現在のプロジェクト状態を要約し、次のアクションを提案してください"],
    ["__cdc_codex_review 現在の変更内容をレビューし、危険な箇所を教えてください", "@chatgpt 現在の変更内容をレビューし、危険な箇所を教えてください"],
    ["codex テストを実行し、失敗原因を分析して修正してください。修正後にテストも再実行してください", "@chatgpt テストを実行し、失敗原因を分析して修正してください。修正後にテストも再実行してください"],
    ["codex テストを実行し、失敗原因を分析して修正してください。修正後にテストを再実行してください", "@chatgpt テストを実行し、失敗原因を分析して修正してください。修正後にテストを再実行してください"],
    ["codex テスト失敗を分析して修正してください。修正後にテストも再実行してください", "@chatgpt テスト失敗を分析して修正してください。修正後にテストも再実行してください"],
  ];
  for (const [from, to] of chatGptRedirects) {
    out = out.split(from).join(to);
  }

  // Arbitrary shell is deliberately removed from slash command registration.
  out = out.replace(
    `  {
    name: "shell",
    description: "現在のチャンネル位置でshellコマンドを実行します。",
    options: [
      stringOption({
        name: "command",
        description: "実行するshellコマンド",
        required: true,
      }),
    ],
  },`,
    "",
  );
  // Upstream source is Korean before localization, so cover that form too.
  out = out.replace(
    `  {
    name: "shell",
    description: "현재 채널 위치에서 shell 명령을 실행합니다.",
    options: [
      stringOption({
        name: "command",
        description: "실행할 shell 명령",
        required: true,
      }),
    ],
  },`,
    "",
  );

  // Interaction metadata for queued requests.
  out = out.replace(
    '  commandName: string;\n  user: { id: string };',
    '  id: string;\n  commandName: string;\n  user: { id: string; username?: string; globalName?: string | null };',
  );
  out = out.replace(
    '        content,\n        roleIds: getMemberRoleIds(interaction.member),\n        guild: createDiscordGuildSurface(interaction.guild),',
    '        content,\n        messageId: interaction.id,\n        guildId: interaction.guild?.id ?? "",\n        authorName: interaction.user.globalName ?? interaction.user.username ?? interaction.user.id,\n        timestamp: new Date().toISOString(),\n        roleIds: getMemberRoleIds(interaction.member),\n        guild: createDiscordGuildSurface(interaction.guild),',
  );
  out = out.replace(
    '      content,\n      roleIds: getMemberRoleIds(interaction.member),\n      guild: createDiscordGuildSurface(interaction.guild),',
    '      content,\n      messageId: interaction.message?.id ?? "",\n      guildId: interaction.guild?.id ?? "",\n      authorName: interaction.user.id,\n      timestamp: new Date().toISOString(),\n      roleIds: getMemberRoleIds(interaction.member),\n      guild: createDiscordGuildSurface(interaction.guild),',
  );

  // Replace the old Codex-centric help with the new formal operating model.
  out = out.replace(
    /export function formatHelp\(channelMode: ChannelMode\): DiscordMessagePayload \{[\s\S]*?\n\}\n\nexport function formatMaintenancePanel/,
    `export function formatHelp(channelMode: ChannelMode): DiscordMessagePayload {
  void channelMode;
  return messagePayload({
    title: "Discord Remote Control / ChatGPT Bridge",
    color: COLORS.neutral,
    description: "通常はCodexを起動しません。AI不要の操作はLocal、複雑な依頼はChatGPT Queue、Codexは明示指定時のみ使用します。",
    fields: [
      {
        name: "Local / AIなし",
        value: codeBlock("/local status\\n/local ls\\n/local pwd\\n/local git status\\n/local git diff\\n/local log\\n/local build-status", "text"),
        inline: false,
      },
      {
        name: "ChatGPT + DevSpace",
        value: codeBlock("/ask <依頼>\\n/review <観点>\\n/fix-tests\\n/summarize <対象>", "text"),
        inline: false,
      },
      {
        name: "Codex / 明示指定のみ",
        value: codeBlock("/codex <依頼>\\n@codex <依頼>", "text"),
        inline: false,
      },
      {
        name: "ルーティング",
        value: codeBlock("/backend auto\\n/backend local\\n/backend chatgpt\\n/backend codex\\n/bridge-status", "text"),
        inline: false,
      },
      {
        name: "一般向けBot管理",
        value: codeBlock("/public-assistant start\\n/public-assistant stop\\n/public-assistant status", "text"),
        inline: false,
      },
      {
        name: "安全性",
        value: "一般向けチャンネルはメンション時のみ応答し、会話と画像生成だけを許可します。Local、Git、Shell、DevSpace、管理操作には接続しません。",
        inline: false,
      },
    ],
  });
}

export function formatMaintenancePanel`,
  );
  out = out.replace(/Codexレビュー/g, "ChatGPTレビュー");
  out = out.replace(/Codexレビュー\/修正/g, "ChatGPTレビュー/修正");

  // Start the durable outbox pump once Discord is ready.
  out = out.replace(
    'import { pathToFileURL } from "node:url";',
    `import { pathToFileURL } from "node:url";\nimport { startMultiBackendOutboxPump, describeMultiBackendRuntime } from "${INTEGRATION_URL}";`,
  );
  out = out.replace(
    '  client.once("ready", () => {\n    console.info(`Discord bot ready as ${client.user?.tag ?? "unknown"}`);',
    '  client.once("ready", () => {\n    console.info(`Discord bot ready as ${client.user?.tag ?? "unknown"}`);\n    void startMultiBackendOutboxPump(client).catch((error) => console.error("failed to start ChatGPT outbox pump", error));\n    void describeMultiBackendRuntime().then((value) => console.info(`MultiBackend: ${value}`)).catch((error) => console.error("failed to describe MultiBackend runtime", error));',
  );

  return out;
}

function applyPrivateDiscordChannelPatch(source) {
  let out = source;

  out = out.replace(
    "  ChannelType,\n  Client,\n  GatewayIntentBits,",
    "  ChannelType,\n  Client,\n  GatewayIntentBits,\n  PermissionFlagsBits,",
  );

  out = out.replace(
    "export function createDiscordGuildSurface(guild: Guild | null): DiscordGuildSurface | null {",
    `function privateChannelPermissionOverwrites(guild: Guild) {
  const allowedRoleIds = (process.env.DISCORD_ALLOWED_ROLE_IDS ?? \"\")
    .split(\",\")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const botId = guild.members.me?.id ?? guild.client.user?.id;
  const operatorPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
  ];

  return [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    ...allowedRoleIds.map((roleId) => ({
      id: roleId,
      allow: operatorPermissions,
    })),
    ...(botId
      ? [{
          id: botId,
          allow: [...operatorPermissions, PermissionFlagsBits.ManageChannels],
        }]
      : []),
  ];
}

export function createDiscordGuildSurface(guild: Guild | null): DiscordGuildSurface | null {`,
  );

  out = out.replace(
    "        type: ChannelType.GuildCategory,\n      });",
    "        type: ChannelType.GuildCategory,\n        permissionOverwrites: privateChannelPermissionOverwrites(guild),\n      });",
  );

  out = out.replace(
    "        topic: input.topic,\n      });",
    "        topic: input.topic,\n        permissionOverwrites: privateChannelPermissionOverwrites(guild),\n      });",
  );

  return out;
}

export function localizeSourceForTest(source) {
  let out = source;
  for (const [from, to] of orderedTranslations) {
    out = out.split(from).join(to);
  }
  out = applyMultiBackendBridgePatch(out);
  return applyPrivateDiscordChannelPatch(out);
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.includes(TARGET) || result?.source == null) {
      return result;
    }

    const text = typeof result.source === "string"
      ? result.source
      : Buffer.from(result.source).toString("utf8");

    const localized = localizeSourceForTest(text);
    if (localized === text) {
      return result;
    }

    return {
      ...result,
      source: localized,
    };
  },
});
