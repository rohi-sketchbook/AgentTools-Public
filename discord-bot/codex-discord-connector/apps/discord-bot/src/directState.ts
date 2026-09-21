import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SyncedWorkspaceState {
  workspaceRoot: string;
  workspaceDisplayName: string;
  discordCategoryId: string;
  computerId: string;
  workspaceId: string;
}

export type TranscriptSyncMode = "on-chat" | "realtime";

export interface SyncedSessionChannelState {
  codexSessionId: string | null;
  threadName: string;
  updatedAt: string;
  cwd: string;
  workspaceRoot: string;
  workspaceDisplayName: string;
  discordCategoryId: string | null;
  discordChannelId: string;
  channelName: string;
  computerId: string;
  workspaceId: string;
  contextPostedAt?: string | null;
  lastTranscriptMessageKey?: string | null;
  lastTranscriptSyncedAt?: string | null;
  lastTranscriptDiscordMessageId?: string | null;
}

export type ScheduledCommandSpec =
  | { type: "once"; runAt: string }
  | { type: "interval"; everyMs: number }
  | { type: "daily"; time: string }
  | { type: "weekly"; time: string; weekdays: number[] };

export interface ScheduledCommandState {
  id: string;
  channelId: string;
  userId: string;
  roleIds: string[];
  command: string;
  schedule: ScheduledCommandSpec;
  enabled: boolean;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string | null;
  runCount: number;
  lastResultStatus?: "success" | "failed" | null;
  lastError?: string | null;
  failureCount?: number;
  retryCount?: number;
}

export interface DirectSyncState {
  version: 1;
  transcriptSyncMode: TranscriptSyncMode;
  archivedCodexSessionIds: string[];
  workspaces: SyncedWorkspaceState[];
  sessionChannels: SyncedSessionChannelState[];
  scheduledCommands: ScheduledCommandState[];
}

export type DirectSyncStateWriteInput = Omit<DirectSyncState, "transcriptSyncMode" | "scheduledCommands"> & {
  transcriptSyncMode?: TranscriptSyncMode;
  scheduledCommands?: ScheduledCommandState[];
};

export interface DirectSyncStateStore {
  read(): Promise<DirectSyncState>;
  update(
    mutator: (state: DirectSyncState) => DirectSyncStateWriteInput | DirectSyncState | void,
  ): Promise<DirectSyncState>;
  findSessionChannelByDiscordId(discordChannelId: string): Promise<SyncedSessionChannelState | null>;
  updateChannelCwd(discordChannelId: string, cwd: string): Promise<void>;
  updateSessionChannelCodexSession(
    discordChannelId: string,
    codexSessionId: string,
    threadName?: string,
  ): Promise<void>;
  updateTranscriptSyncMode(mode: TranscriptSyncMode): Promise<void>;
}

export function createEmptyDirectSyncState(): DirectSyncState {
  return {
    version: 1,
    transcriptSyncMode: "realtime",
    archivedCodexSessionIds: [],
    workspaces: [],
    sessionChannels: [],
    scheduledCommands: [],
  };
}

function normalizeDirectSyncState(state: Partial<DirectSyncState>): DirectSyncState {
  const transcriptSyncMode =
    state.transcriptSyncMode === "realtime" || state.transcriptSyncMode === "on-chat"
      ? state.transcriptSyncMode
      : "realtime";

  return {
    version: 1,
    transcriptSyncMode,
    archivedCodexSessionIds: Array.isArray(state.archivedCodexSessionIds)
      ? state.archivedCodexSessionIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [],
    workspaces: Array.isArray(state.workspaces) ? state.workspaces : [],
    sessionChannels: Array.isArray(state.sessionChannels) ? state.sessionChannels : [],
    scheduledCommands: Array.isArray(state.scheduledCommands)
      ? state.scheduledCommands.filter(
          (schedule): schedule is ScheduledCommandState =>
            typeof schedule === "object" &&
            schedule !== null &&
            typeof (schedule as ScheduledCommandState).id === "string" &&
            typeof (schedule as ScheduledCommandState).channelId === "string" &&
            typeof (schedule as ScheduledCommandState).command === "string",
        )
      : [],
  };
}

export function defaultDirectSyncStatePath(): string {
  return path.resolve(process.env.CONNECT_STATE_PATH ?? ".connect/state.json");
}

export function createDirectSyncStateStore(statePath = defaultDirectSyncStatePath()): DirectSyncStateStore {
  const resolvedStatePath = path.resolve(statePath);
  let mutationQueue: Promise<void> = Promise.resolve();

  async function readStateFile(): Promise<DirectSyncState> {
    try {
      return normalizeDirectSyncState(JSON.parse(await readFile(resolvedStatePath, "utf8")) as Partial<DirectSyncState>);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return createEmptyDirectSyncState();
      }

      throw error;
    }
  }

  async function writeStateFile(state: DirectSyncStateWriteInput): Promise<DirectSyncState> {
    const normalized = normalizeDirectSyncState(state);
    await mkdir(path.dirname(resolvedStatePath), { recursive: true });
    const temporaryPath = `${resolvedStatePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
      await rename(temporaryPath, resolvedStatePath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    return normalized;
  }

  function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  const store: DirectSyncStateStore = {
    async read() {
      await mutationQueue;
      return readStateFile();
    },
    async update(mutator) {
      return enqueueMutation(async () => {
        const current = await readStateFile();
        const mutated = mutator(current);
        return writeStateFile(mutated ?? current);
      });
    },
    async findSessionChannelByDiscordId(discordChannelId) {
      const state = await this.read();
      return state.sessionChannels.find((channel) => channel.discordChannelId === discordChannelId) ?? null;
    },
    async updateChannelCwd(discordChannelId, cwd) {
      await store.update((state) => ({
        ...state,
        sessionChannels: state.sessionChannels.map((channel) =>
          channel.discordChannelId === discordChannelId ? { ...channel, cwd } : channel,
        ),
      }));
    },
    async updateSessionChannelCodexSession(discordChannelId, codexSessionId, threadName) {
      await store.update((state) => ({
        ...state,
        sessionChannels: state.sessionChannels.map((channel) =>
          channel.discordChannelId === discordChannelId
            ? {
                ...channel,
                codexSessionId,
                threadName: threadName?.trim() || channel.threadName,
                updatedAt: new Date().toISOString(),
              }
            : channel,
        ),
      }));
    },
    async updateTranscriptSyncMode(mode) {
      await store.update((state) => ({
        ...state,
        transcriptSyncMode: mode,
      }));
    },
  };

  return store;
}
