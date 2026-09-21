import { promises as fs } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { discoverCodexSessions, getCodexSessionChangeToken } from "./parser.js";

const createdRoots: string[] = [];

async function createCodexHome(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-adapter-"));
  createdRoots.push(root);
  await mkdir(path.join(root, "sessions", "2026", "08", "21"), { recursive: true });
  return root;
}

function indexLine(id: string, threadName: string, updatedAt: string): string {
  return JSON.stringify({ id, thread_name: threadName, updated_at: updatedAt });
}

function sessionMetaLine(id: string, cwd: string): string {
  return JSON.stringify({ type: "session_meta", payload: { id, cwd } });
}

function messageLine(role: "user" | "assistant", text: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role,
      phase: role === "assistant" ? "final_answer" : undefined,
      content: [{ type: "text", text }],
    },
  });
}

afterEach(async () => {
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("discoverCodexSessions exact session selection", () => {
  test("returns only requested session ids", async () => {
    const root = await createCodexHome();
    const requestedId = "019fcc33-081b-7670-b4c2-e4b5788087cd";
    const otherId = "019fcc33-081b-7670-b4c2-e4b5788087ce";
    const sessionDir = path.join(root, "sessions", "2026", "08", "21");

    await writeFile(
      path.join(root, "session_index.jsonl"),
      `${indexLine(requestedId, "requested", "2026-08-21T00:00:00.000Z")}\n${indexLine(otherId, "other", "2026-08-21T00:00:01.000Z")}\n`,
      "utf8",
    );
    await writeFile(
      path.join(sessionDir, `rollout-${requestedId}.jsonl`),
      `${sessionMetaLine(requestedId, "H:/requested")}\n${messageLine("user", "hello")}\n`,
      "utf8",
    );
    await writeFile(
      path.join(sessionDir, `rollout-${otherId}.jsonl`),
      `${sessionMetaLine(otherId, "H:/other")}\n${messageLine("user", "other message")}\n`,
      "utf8",
    );

    const sessions = await discoverCodexSessions(root, {
      onlySessionIds: [requestedId],
      includeContextPreview: true,
      includeRealtimeEvents: true,
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: requestedId, threadName: "requested", cwdHint: "H:/requested" });
    expect(sessions[0].realtimeEvents?.at(-1)?.text).toBe("hello");
  });

  test("rate-limits missing-session rescans and discovers the file after the retry window", async () => {
    const root = await createCodexHome();
    const missingId = "019fcc33-081b-7670-b4c2-e4b5788087dd";
    const sessionDir = path.join(root, "sessions", "2026", "08", "21");
    const readdirSpy = vi.spyOn(fs, "readdir");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);

    try {
      expect(await getCodexSessionChangeToken(root, [missingId])).toContain("missing");
      const callsAfterFirstLookup = readdirSpy.mock.calls.length;
      expect(callsAfterFirstLookup).toBeGreaterThan(0);

      expect(await getCodexSessionChangeToken(root, [missingId])).toContain("missing");
      expect(readdirSpy.mock.calls.length).toBe(callsAfterFirstLookup);

      await writeFile(path.join(sessionDir, `rollout-${missingId}.jsonl`), `${sessionMetaLine(missingId, "H:/late")}\n`, "utf8");
      nowSpy.mockReturnValue(31_001);

      expect(await getCodexSessionChangeToken(root, [missingId])).not.toContain("missing");
      expect(readdirSpy.mock.calls.length).toBeGreaterThan(callsAfterFirstLookup);
    } finally {
      nowSpy.mockRestore();
      readdirSpy.mockRestore();
    }
  });

  test("updates cached transcript details from appended jsonl data", async () => {
    const root = await createCodexHome();
    const sessionId = "019fcc33-081b-7670-b4c2-e4b5788087cf";
    const sessionDir = path.join(root, "sessions", "2026", "08", "21");
    const sessionFile = path.join(sessionDir, `rollout-${sessionId}.jsonl`);
    const filler = `${JSON.stringify({ type: "event_msg", payload: { type: "ignored", data: "x".repeat(2048) } })}\n`.repeat(350);

    await writeFile(
      path.join(root, "session_index.jsonl"),
      `${indexLine(sessionId, "active", "2026-08-21T00:00:00.000Z")}\n`,
      "utf8",
    );
    await writeFile(
      sessionFile,
      `${sessionMetaLine(sessionId, "H:/active")}\n${filler}${messageLine("user", "first")}\n`,
      "utf8",
    );

    const firstToken = await getCodexSessionChangeToken(root, [sessionId]);
    const first = await discoverCodexSessions(root, {
      onlySessionIds: [sessionId],
      includeContextPreview: true,
      includeRealtimeEvents: true,
      realtimeEventLimit: 40,
    });
    expect(first[0].realtimeEvents?.at(-1)?.text).toBe("first");

    await appendFile(sessionFile, `${messageLine("assistant", "second")}\n`, "utf8");

    const secondToken = await getCodexSessionChangeToken(root, [sessionId]);
    expect(secondToken).not.toBe(firstToken);

    const second = await discoverCodexSessions(root, {
      onlySessionIds: [sessionId],
      includeContextPreview: true,
      includeRealtimeEvents: true,
      realtimeEventLimit: 40,
    });

    expect(second[0].realtimeEvents?.map((event) => event.text).slice(-2)).toEqual(["first", "second"]);
  });
});
