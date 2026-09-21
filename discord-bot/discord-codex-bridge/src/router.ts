import type { Attachment, BackendId, BackendSelection } from "./contracts.ts";

export type RouteDecision =
  | { kind: "set-backend"; backend: BackendSelection }
  | { kind: "status" }
  | { kind: "workflow"; text: string; steps?: BackendId[] }
  | { kind: "backend"; backend: BackendId; text: string; explicit: boolean }
  | { kind: "passthrough"; text: string };

const BACKEND_IDS = new Set<BackendSelection>(["local", "chatgpt", "codex", "auto"]);

export function isBackendSelection(value: string): value is BackendSelection {
  return BACKEND_IDS.has(value as BackendSelection);
}

export function autoSelectBackend(text: string, attachments: Attachment[] = []): BackendId {
  void attachments;
  const normalized = text.trim().toLowerCase();

  // AI不要の問い合わせを最優先する。任意Shellへは変換せず、LocalBackendのAllowlistに限定する。
  if (
    /^(?:status|where|pwd|ls|dir|git\s+status|git\s+diff|log|build-status|autodev\s+(?:list|queue))$/i.test(normalized) ||
    /(?:現在地|作業場所|ファイル一覧|フォルダ一覧|git.{0,4}状態|git.{0,4}差分|bot.{0,4}状態|ビルド.{0,4}状態|課題キュー.{0,8}(?:一覧|表示))/i.test(text) ||
    /(?:^|\s)(?:ls|dir|pwd)(?:して|見せて|表示|教えて)/i.test(text) ||
    /git\s+(?:status|diff).{0,12}(?:見せて|表示|確認|教えて)/i.test(text) ||
    /(?:ログ|log).{0,8}(?:見せて|表示|一覧)/i.test(text)
  ) {
    return "local";
  }

  // 明示的なCodex指定以外は、推論・調査・編集をChatGPT Queueへ送る。
  if (/\bcodex\b/i.test(text)) {
    return "codex";
  }

  return "chatgpt";
}

export function routeMultiBackendMessage(input: {
  content: string;
  defaultBackend: BackendSelection;
  attachments?: Attachment[];
}): RouteDecision {
  const content = input.content.trim();
  const backendCommand = content.match(/^(?:__mb_backend|\/backend)\s+(local|chatgpt|codex|auto)$/i);
  if (backendCommand) {
    return { kind: "set-backend", backend: backendCommand[1]!.toLowerCase() as BackendSelection };
  }

  if (/^(?:__mb_status|\/bridge-status)$/i.test(content)) {
    return { kind: "status" };
  }

  const workflow = content.match(/^@workflow\b\s*(.*)$/is);
  if (workflow) {
    const body = workflow[1]?.trim() ?? "";
    const explicitSteps = body.match(/^([a-z,+>\s-]+?)\s*::\s*(.+)$/is);
    if (explicitSteps) {
      const steps = explicitSteps[1]!
        .split(/[,+>\s-]+/)
        .map((value) => value.trim().toLowerCase())
        .filter((value): value is BackendId => ["local", "chatgpt", "codex"].includes(value));
      return { kind: "workflow", text: explicitSteps[2]!.trim(), steps: steps.length > 0 ? steps : undefined };
    }
    return { kind: "workflow", text: body };
  }

  const codexTextCommand = content.match(/^codex\b[:\s-]*(.*)$/is);
  if (codexTextCommand) {
    return { kind: "backend", backend: "codex", text: codexTextCommand[1]?.trim() ?? "", explicit: true };
  }

  const slashStyle = content.match(/^\/(local|ask|chatgpt|codex)\b[:\s-]*(.*)$/is);
  if (slashStyle) {
    const selected = slashStyle[1]!.toLowerCase() === "ask" ? "chatgpt" : slashStyle[1]!.toLowerCase() as BackendId;
    return { kind: "backend", backend: selected, text: slashStyle[2]?.trim() ?? "", explicit: true };
  }

  const explicit = content.match(/^@(local|chatgpt|codex|auto)\b[:\s-]*(.*)$/is);
  if (explicit) {
    const selected = explicit[1]!.toLowerCase() as BackendSelection;
    const text = explicit[2]?.trim() ?? "";
    const backend = selected === "auto" ? autoSelectBackend(text, input.attachments) : selected;
    return { kind: "backend", backend, text, explicit: true };
  }

  if (input.defaultBackend === "codex") {
    return { kind: "passthrough", text: content };
  }

  const backend = input.defaultBackend === "auto"
    ? autoSelectBackend(content, input.attachments)
    : input.defaultBackend;
  return { kind: "backend", backend, text: content, explicit: false };
}
