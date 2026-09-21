import type { DirectSyncStateStore, SyncedSessionChannelState } from "./directState.js";

export interface ArchiveSyncedCodexSessionResult {
  codexSessionId: string;
  deletedChannel: boolean;
  removedChannelMapping: boolean;
  wasAlreadyArchived: boolean;
}

export interface DiscordGuildArchiveSurface {
  deleteChannel?(id: string): Promise<void>;
}

function findTargetChannel(input: {
  channels: SyncedSessionChannelState[];
  discordChannelId: string;
  codexSessionId?: string | null;
}): SyncedSessionChannelState | null {
  return (
    input.channels.find((channel) => channel.discordChannelId === input.discordChannelId) ??
    input.channels.find((channel) => channel.codexSessionId === input.codexSessionId) ??
    null
  );
}

export async function archiveSyncedCodexSession(input: {
  stateStore: DirectSyncStateStore;
  guild?: DiscordGuildArchiveSurface | null;
  discordChannelId: string;
  codexSessionId?: string | null;
}): Promise<ArchiveSyncedCodexSessionResult> {
  const state = await input.stateStore.read();
  const targetChannel = findTargetChannel({
    channels: state.sessionChannels,
    discordChannelId: input.discordChannelId,
    codexSessionId: input.codexSessionId,
  });
  const codexSessionId = input.codexSessionId ?? targetChannel?.codexSessionId ?? null;

  if (!codexSessionId) {
    throw new Error("No synced Codex session was found to archive.");
  }

  const wasAlreadyArchived = state.archivedCodexSessionIds.includes(codexSessionId);

  let deletedChannel = false;

  if (targetChannel && input.guild?.deleteChannel) {
    await input.guild.deleteChannel(targetChannel.discordChannelId);
    deletedChannel = true;
  }

  let removedChannelMapping = false;
  await input.stateStore.update((current) => {
    const archivedIds = new Set(current.archivedCodexSessionIds);
    archivedIds.add(codexSessionId);
    const nextSessionChannels = current.sessionChannels.filter(
      (channel) =>
        channel.codexSessionId !== codexSessionId && channel.discordChannelId !== targetChannel?.discordChannelId,
    );
    removedChannelMapping = nextSessionChannels.length !== current.sessionChannels.length;
    return {
      ...current,
      archivedCodexSessionIds: [...archivedIds],
      sessionChannels: nextSessionChannels,
    };
  });

  return {
    codexSessionId,
    deletedChannel,
    removedChannelMapping,
    wasAlreadyArchived,
  };
}
