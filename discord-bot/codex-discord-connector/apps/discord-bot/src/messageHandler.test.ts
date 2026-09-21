import { describe, expect, test, vi } from "vitest";
import { createDiscordMessageHandler, type DiscordOutgoingMessage } from "./messageHandler.js";

function createHandler(input: {
  startDevlogPipeline: () => Promise<{
    pid: number;
    scriptPath: string;
    startedAt: string;
    completion: Promise<{
      succeeded: boolean;
      exitCode: number;
      stage: string;
      published: boolean;
      launcherLogPath: string;
    }>;
  }>;
  submitCodexPrompt?: Parameters<typeof createDiscordMessageHandler>[0]["submitCodexPrompt"];
}) {
  return createDiscordMessageHandler({
    resolveChannelContext: async () => ({
      channelMode: "session-linked",
      allowedRoleIds: ["admin"],
      computerId: "local-dev",
      computerDisplayName: "Local",
      workspaceDisplayName: "Devlog",
      workspaceRoot: "D:\\projects",
      cwd: "D:\\projects",
      timeoutMs: 30_000,
    }),
    submitCommandJob: vi.fn(),
    submitCodexPrompt: input.submitCodexPrompt,
    startDevlogPipeline: input.startDevlogPipeline,
    updateChannelCwd: vi.fn(),
    recordCommandAudit: vi.fn(),
  });
}

describe("Codex model routing", () => {
  const startDevlogPipeline = async () => ({
    pid: 1,
    scriptPath: "runner",
    startedAt: "2026-09-11T00:00:00.000Z",
    completion: Promise.resolve({
      succeeded: true,
      exitCode: 0,
      stage: "published",
      published: true,
      launcherLogPath: "launcher.log",
    }),
  });

  function replySurface() {
    return async () => ({ edit: async () => undefined });
  }

  test("uses Terra medium for ordinary Codex chat", async () => {
    const submitCodexPrompt = vi.fn(async () => ({ jobId: "job-1", result: { status: "completed" } }));
    const handler = createHandler({ startDevlogPipeline, submitCodexPrompt });

    await handler({
      authorBot: false,
      userId: "user-1",
      channelId: "channel-1",
      content: "codex READMEを要約して",
      roleIds: ["admin"],
      reply: replySurface(),
    });

    expect(submitCodexPrompt).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ model: "gpt-5.6-terra", reasoningEffort: "medium" }),
    }));
  });

  test("maps fast to Luna low and task to Terra high", async () => {
    const submitCodexPrompt = vi.fn(async () => ({ jobId: "job-1", result: { status: "completed" } }));
    const handler = createHandler({ startDevlogPipeline, submitCodexPrompt });
    const base = {
      authorBot: false,
      userId: "user-1",
      channelId: "channel-1",
      roleIds: ["admin"],
      reply: replySurface(),
    };

    await handler({ ...base, content: "fast" });
    await handler({ ...base, content: "codex 軽く確認して" });
    expect(submitCodexPrompt).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ model: "gpt-5.6-luna", reasoningEffort: "low" }),
    }));

    await handler({ ...base, content: "task" });
    await handler({ ...base, content: "codex 実装して" });
    expect(submitCodexPrompt).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ model: "gpt-5.6-terra", reasoningEffort: "high" }),
    }));
  });

  test("keeps review on Terra medium even in task mode", async () => {
    const submitCodexPrompt = vi.fn(async () => ({ jobId: "job-1", result: { status: "completed" } }));
    const handler = createHandler({ startDevlogPipeline, submitCodexPrompt });
    const base = {
      authorBot: false,
      userId: "user-1",
      channelId: "channel-1",
      roleIds: ["admin"],
      reply: replySurface(),
    };

    await handler({ ...base, content: "task" });
    await handler({ ...base, content: "review セキュリティを確認して" });

    expect(submitCodexPrompt).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        mode: "review",
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
      }),
    }));
  });
});

describe("devlog command handling", () => {
  test("starts the dedicated pipeline without using arbitrary shell execution", async () => {
    const replies: DiscordOutgoingMessage[] = [];
    const startDevlogPipeline = vi.fn(async () => ({
      pid: 1234,
      scriptPath: "D:\\projects\\AgentTools\\devlog-codex-runner\\start-devlog-pipeline.mjs",
      startedAt: "2026-08-03T00:00:00.000Z",
      completion: Promise.resolve({
        succeeded: true,
        exitCode: 0,
        stage: "published",
        published: true,
        launcherLogPath: "H:\\logs\\launcher.log",
      }),
    }));
    const handler = createHandler({ startDevlogPipeline });

    const result = await handler({
      authorBot: false,
      userId: "user-1",
      channelId: "channel-1",
      content: "devlog run",
      roleIds: ["admin"],
      reply: async (message) => {
        replies.push(message);
      },
    });

    expect(result).toEqual({ status: "completed" });
    expect(startDevlogPipeline).toHaveBeenCalledOnce();
    expect(replies).toEqual([
      "開発日記パイプラインを起動しました。PID=1234 / 2026-08-03T00:00:00.000Z",
    ]);
  });

  test("returns a failed outcome when the pipeline completes unsuccessfully", async () => {
    const replies: DiscordOutgoingMessage[] = [];
    const handler = createHandler({
      startDevlogPipeline: async () => ({
        pid: 1234,
        scriptPath: "D:\\projects\\AgentTools\\devlog-codex-runner\\start-devlog-pipeline.mjs",
        startedAt: "2026-08-03T00:00:00.000Z",
        completion: Promise.resolve({
          succeeded: false,
          exitCode: 1,
          stage: "validation_failed",
          published: false,
          launcherLogPath: "H:\\logs\\launcher.log",
        }),
      }),
    });

    const result = await handler({
      authorBot: false,
      userId: "user-1",
      channelId: "channel-1",
      content: "devlog run",
      roleIds: ["admin"],
      reply: async (message) => {
        replies.push(message);
      },
    });

    expect(result).toEqual({
      status: "failed",
      error: "開発日記パイプラインが失敗しました。exit=1 stage=validation_failed published=false / H:\\logs\\launcher.log",
    });
    expect(replies).toHaveLength(2);
  });

  test("returns a failed outcome when the dedicated launcher fails", async () => {
    const handler = createHandler({
      startDevlogPipeline: async () => {
        throw new Error("runner missing");
      },
    });

    const result = await handler({
      authorBot: false,
      userId: "user-1",
      channelId: "channel-1",
      content: "devlog run",
      roleIds: ["admin"],
      reply: async () => undefined,
    });

    expect(result).toEqual({ status: "failed", error: "runner missing" });
  });
});
