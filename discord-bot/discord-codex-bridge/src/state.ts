import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BackendId, BackendSelection, ChannelBackendState } from "./contracts.ts";

interface PersistedState {
  version: 1;
  channels: Record<string, ChannelBackendState>;
}

const EMPTY_STATE: PersistedState = { version: 1, channels: {} };

export class ChannelStateStore {
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly statePath: string,
    private readonly defaultBackend: BackendSelection = "codex",
  ) {}

  async get(channelId: string): Promise<ChannelBackendState> {
    const state = await this.readState();
    return state.channels[channelId] ?? {
      backend: this.defaultBackend,
      updatedAt: new Date(0).toISOString(),
    };
  }

  async setBackend(channelId: string, backend: BackendSelection): Promise<ChannelBackendState> {
    return this.updateChannel(channelId, (current) => ({ ...current, backend }));
  }

  async setWorkspace(channelId: string, workspaceRoot: string | undefined): Promise<ChannelBackendState> {
    return this.updateChannel(channelId, (current) => ({ ...current, workspaceRoot }));
  }

  async setSession(channelId: string, backend: BackendId, sessionId: string | null | undefined): Promise<ChannelBackendState> {
    return this.updateChannel(channelId, (current) => {
      const sessions = { ...(current.sessions ?? {}) };
      if (sessionId) {
        sessions[backend] = sessionId;
      } else {
        delete sessions[backend];
      }
      return { ...current, sessions };
    });
  }

  private async updateChannel(
    channelId: string,
    updater: (current: ChannelBackendState) => ChannelBackendState,
  ): Promise<ChannelBackendState> {
    let result!: ChannelBackendState;
    this.updateQueue = this.updateQueue.catch(() => undefined).then(async () => {
      const state = await this.readState();
      const current = state.channels[channelId] ?? {
        backend: this.defaultBackend,
        updatedAt: new Date(0).toISOString(),
      };
      result = {
        ...updater(current),
        updatedAt: new Date().toISOString(),
      };
      state.channels[channelId] = result;
      await this.writeState(state);
    });
    await this.updateQueue;
    return result;
  }

  private async readState(): Promise<PersistedState> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<PersistedState>;
      if (parsed.version !== 1 || !parsed.channels || typeof parsed.channels !== "object") {
        return structuredClone(EMPTY_STATE);
      }
      return { version: 1, channels: parsed.channels };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return structuredClone(EMPTY_STATE);
      }
      throw error;
    }
  }

  private async writeState(state: PersistedState): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}
