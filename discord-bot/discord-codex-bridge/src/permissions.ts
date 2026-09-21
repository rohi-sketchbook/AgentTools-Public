import { randomBytes } from "node:crypto";

import type { BackendId } from "./contracts.ts";

export interface PendingConfirmation {
  token: string;
  channelId: string;
  userId: string;
  backend: BackendId | "workflow";
  text: string;
  payload?: Record<string, unknown>;
  createdAt: number;
}

const DANGEROUS_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "ファイル・ディレクトリ削除", pattern: /(?:\brm\b|del(?:ete)?|削除|remove\s+(?:file|directory)|rmdir)/i },
  { label: "Git push", pattern: /\bgit\s+push\b|\bpushして\b/i },
  { label: "Git reset", pattern: /\bgit\s+reset\b|\breset\s+--hard\b/i },
  { label: "大量変更", pattern: /(?:一括|大量|すべて|全て).{0,12}(?:変更|削除|置換|書き換)/i },
  { label: "Unity Scene削除", pattern: /(?:unity|scene).{0,20}(?:削除|delete)/i },
  { label: "Blender Collection削除", pattern: /(?:blender|collection).{0,20}(?:削除|delete)/i },
  { label: "外部公開・送信", pattern: /(?:公開|publish|deploy|本番反映|送信|post).{0,20}(?:外部|production|github|discord|sns|webhook)?/i },
];

export function detectDangerousOperation(text: string): string | null {
  return DANGEROUS_PATTERNS.find(({ pattern }) => pattern.test(text))?.label ?? null;
}

export class ConfirmationManager {
  private readonly pending = new Map<string, PendingConfirmation>();
  private readonly ttlMs = 10 * 60 * 1000;

  create(input: Omit<PendingConfirmation, "token" | "createdAt">): PendingConfirmation {
    this.cleanup();
    const token = randomBytes(4).toString("hex");
    const confirmation: PendingConfirmation = {
      ...input,
      token,
      createdAt: Date.now(),
    };
    this.pending.set(token, confirmation);
    return confirmation;
  }

  consume(token: string, channelId: string, userId: string): PendingConfirmation | null {
    this.cleanup();
    const confirmation = this.pending.get(token);
    if (!confirmation || confirmation.channelId !== channelId || confirmation.userId !== userId) {
      return null;
    }
    this.pending.delete(token);
    return confirmation;
  }

  cancel(token: string, channelId: string, userId: string): boolean {
    this.cleanup();
    const confirmation = this.pending.get(token);
    if (!confirmation || confirmation.channelId !== channelId || confirmation.userId !== userId) {
      return false;
    }
    this.pending.delete(token);
    return true;
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [token, confirmation] of this.pending) {
      if (confirmation.createdAt < cutoff) {
        this.pending.delete(token);
      }
    }
  }
}
