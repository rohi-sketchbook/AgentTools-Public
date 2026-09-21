import { describe, expect, test } from "vitest";
import type { DirectSyncState, DirectSyncStateStore, ScheduledCommandState } from "./directState.js";
import { runDueScheduledCommands } from "./scheduler.js";

function createSchedule(overrides: Partial<ScheduledCommandState> = {}): ScheduledCommandState {
  return {
    id: "schedule-1",
    channelId: "channel-1",
    userId: "user-1",
    roleIds: ["admin"],
    command: "devlog run",
    schedule: { type: "daily", time: "03:00" },
    enabled: true,
    nextRunAt: "2026-08-03T03:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    lastRunAt: null,
    runCount: 0,
    lastResultStatus: null,
    lastError: null,
    failureCount: 0,
    retryCount: 0,
    ...overrides,
  };
}

function createStateStore(schedule: ScheduledCommandState): {
  store: DirectSyncStateStore;
  readState(): DirectSyncState;
} {
  let state: DirectSyncState = {
    version: 1,
    transcriptSyncMode: "realtime",
    archivedCodexSessionIds: [],
    workspaces: [],
    sessionChannels: [],
    scheduledCommands: [schedule],
  };

  const store = {
    async read() {
      return state;
    },
    async update(mutator: (current: DirectSyncState) => DirectSyncState | void) {
      state = mutator(state) ?? state;
      return state;
    },
  } as unknown as DirectSyncStateStore;

  return { store, readState: () => state };
}

describe("scheduled command execution state", () => {
  test("records a blocked run as failure and retries after five minutes", async () => {
    const now = new Date("2026-08-03T03:00:10.000Z");
    const stateStore = createStateStore(createSchedule());

    const result = await runDueScheduledCommands({
      stateStore: stateStore.store,
      now,
      execute: async () => ({ status: "blocked", error: "not allowlisted" }),
    });

    expect(result).toEqual({ checked: 1, executed: 0, failed: 1 });
    expect(stateStore.readState().scheduledCommands[0]).toMatchObject({
      runCount: 1,
      lastResultStatus: "failed",
      lastError: "not allowlisted",
      failureCount: 1,
      retryCount: 1,
      nextRunAt: "2026-08-03T03:05:10.000Z",
    });
  });

  test("stops retrying after three retries and returns to the regular schedule", async () => {
    const now = new Date("2026-08-03T03:15:10.000Z");
    const stateStore = createStateStore(
      createSchedule({
        nextRunAt: now.toISOString(),
        runCount: 3,
        failureCount: 3,
        retryCount: 3,
      }),
    );

    await runDueScheduledCommands({
      stateStore: stateStore.store,
      now,
      execute: async () => ({ status: "failed", error: "still failing" }),
    });

    const schedule = stateStore.readState().scheduledCommands[0];
    expect(schedule.retryCount).toBe(0);
    expect(schedule.failureCount).toBe(4);
    expect(schedule.nextRunAt).not.toBe("2026-08-03T03:20:10.000Z");
  });

  test("records a successful run and clears retry state", async () => {
    const now = new Date("2026-08-03T03:05:10.000Z");
    const stateStore = createStateStore(
      createSchedule({
        nextRunAt: now.toISOString(),
        failureCount: 1,
        retryCount: 1,
      }),
    );

    const result = await runDueScheduledCommands({
      stateStore: stateStore.store,
      now,
      execute: async () => ({ status: "completed" }),
    });

    expect(result).toEqual({ checked: 1, executed: 1, failed: 0 });
    expect(stateStore.readState().scheduledCommands[0]).toMatchObject({
      lastResultStatus: "success",
      lastError: null,
      retryCount: 0,
    });
  });
});
