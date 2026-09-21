import { access } from "node:fs/promises";

import type { Backend, BackendExecutionContext, BackendRequest, BackendResult } from "../contracts.ts";

function extractConnectorResult(response: unknown): BackendResult {
  if (typeof response !== "object" || response === null) {
    return { status: "failed", backendId: "codex", error: "Codex connector returned an invalid response." };
  }
  if ("error" in response) {
    const error = (response as { error?: { message?: unknown } }).error;
    return {
      status: "failed",
      backendId: "codex",
      error: typeof error?.message === "string" ? error.message : "Codex request failed.",
    };
  }
  const result = (response as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) {
    return { status: "failed", backendId: "codex", error: "Codex result is missing." };
  }
  const raw = result as {
    status?: unknown;
    finalMessage?: unknown;
    sessionId?: unknown;
    stderr?: unknown;
  };
  const status = raw.status === "completed" ? "completed" : raw.status === "cancelled" ? "cancelled" : "failed";
  return {
    status,
    backendId: "codex",
    text: typeof raw.finalMessage === "string" ? raw.finalMessage : undefined,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
    error: status === "failed" && typeof raw.stderr === "string" && raw.stderr.trim() ? raw.stderr.trim() : undefined,
  };
}

export class CodexBackend implements Backend {
  readonly id = "codex" as const;
  readonly displayName = "Codex CLI (explicit only)";
  readonly capabilities = {
    read: true,
    write: true,
    shell: true,
    git: true,
    imageInput: true,
    imageOutput: true,
  } as const;

  prepareUpstreamContent(text: string): string {
    return `codex ${text}`.trim();
  }

  async execute(request: BackendRequest, context: BackendExecutionContext): Promise<BackendResult> {
    if (!context.submitCodexPrompt || !context.computerId) {
      return { status: "failed", backendId: this.id, error: "Codex connector is not available." };
    }

    const response = await context.submitCodexPrompt({
      computerId: context.computerId,
      payload: {
        workspaceRoot: request.workspaceRoot,
        cwd: request.cwd,
        prompt: request.text,
        timeoutMs: request.timeoutMs ?? 300_000,
        sessionId: request.sessionId ?? null,
        imageAttachments: request.attachments ?? [],
      },
    });
    return extractConnectorResult(response);
  }

  async resume(sessionId: string, request: BackendRequest, context: BackendExecutionContext): Promise<BackendResult> {
    return this.execute({ ...request, sessionId }, context);
  }

  async status() {
    const cliPath = process.env.CODEX_CLI_JS;
    if (!cliPath) {
      return { available: false, detail: "CODEX_CLI_JS未設定（Codex明示実行のみ利用不可）" };
    }
    try {
      await access(cliPath);
      return { available: true, detail: `明示指定のみ: ${cliPath}` };
    } catch {
      return { available: false, detail: `Codex CLIが見つかりません: ${cliPath}` };
    }
  }
}
