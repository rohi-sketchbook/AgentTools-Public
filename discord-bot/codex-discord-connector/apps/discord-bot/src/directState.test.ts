import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createDirectSyncStateStore } from "./directState.js";

const createdRoots: string[] = [];

afterEach(async () => {
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DirectSyncStateStore concurrency", () => {
  test("preserves unrelated concurrent updates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "direct-state-"));
    createdRoots.push(root);
    const store = createDirectSyncStateStore(path.join(root, "state.json"));

    await Promise.all([
      store.update((state) => ({
        ...state,
        archivedCodexSessionIds: [...state.archivedCodexSessionIds, "session-a"],
      })),
      store.update((state) => ({
        ...state,
        workspaces: [
          ...state.workspaces,
          {
            workspaceRoot: "H:/workspace-a",
            workspaceDisplayName: "workspace-a",
            discordCategoryId: "category-a",
            computerId: "computer-a",
            workspaceId: "workspace-a",
          },
        ],
      })),
      store.update((state) => ({
        ...state,
        transcriptSyncMode: "on-chat",
      })),
    ]);

    const state = await store.read();
    expect(state.archivedCodexSessionIds).toEqual(["session-a"]);
    expect(state.workspaces.map((workspace) => workspace.workspaceId)).toEqual(["workspace-a"]);
    expect(state.transcriptSyncMode).toBe("on-chat");
  });
});
