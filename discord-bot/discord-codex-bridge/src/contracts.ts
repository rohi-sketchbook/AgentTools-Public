export type BackendId = "local" | "chatgpt" | "codex";
export type BackendSelection = BackendId | "auto";

export interface Attachment {
  url?: string;
  name: string;
  contentType?: string | null;
  size?: number | null;
  localPath?: string;
}

export interface OutputFile {
  path: string;
  name?: string;
}

export interface OutputImage extends OutputFile {
  contentType?: string;
}

export interface BackendCapabilities {
  read?: boolean;
  write?: boolean;
  shell?: boolean;
  git?: boolean;
  imageInput?: boolean;
  imageOutput?: boolean;
  localOnly?: boolean;
  asynchronousQueue?: boolean;
  devspace?: boolean;
}

export interface BackendRequest {
  text: string;
  workspaceRoot?: string;
  cwd?: string;
  sessionId?: string | null;
  attachments?: Attachment[];
  timeoutMs?: number;
  channelId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface BackendResult {
  text?: string;
  files?: OutputFile[];
  images?: OutputImage[];
  sessionId?: string | null;
  status: "completed" | "failed" | "cancelled";
  error?: string;
  backendId?: BackendId;
  metadata?: Record<string, unknown>;
}

export interface BackendStatus {
  available: boolean;
  detail?: string;
  metadata?: Record<string, unknown>;
}

export interface BackendExecutionContext {
  submitCodexPrompt?: (input: {
    computerId: string;
    payload: Record<string, unknown>;
    onProgress?: (event: unknown) => Promise<void> | void;
  }) => Promise<unknown>;
  computerId?: string;
  codexHome?: string;
}

export interface Backend {
  readonly id: BackendId;
  readonly displayName: string;
  readonly capabilities: BackendCapabilities;
  execute(request: BackendRequest, context: BackendExecutionContext): Promise<BackendResult>;
  cancel?(requestId: string): Promise<void>;
  resume?(sessionId: string, request: BackendRequest, context: BackendExecutionContext): Promise<BackendResult>;
  status?(): Promise<BackendStatus>;
}

export interface ChannelBackendState {
  backend: BackendSelection;
  workspaceRoot?: string;
  sessions?: Partial<Record<BackendId, string>>;
  mode?: string;
  updatedAt: string;
}

export interface PublicAssistantConfig {
  enabled: boolean;
  channelIds: string[];
  channelPersonas: Record<string, string>;
  requireBotMention: boolean;
  respondingByDefault: boolean;
  statePath: string;
  workspaceRoot: string;
  codexHome: string;
  timeoutMs: number;
  maxRequestsPerWindow: number;
  windowMs: number;
  maxConcurrentTotal: number;
  conversationTtlMs: number;
  maxConversationTurns: number;
}

export interface MultiBackendConfig {
  enabled: boolean;
  defaultBackend: BackendSelection;
  statePath: string;
  unity?: {
    baseUrls: string[];
    autoDiscoverPorts: boolean;
  };
  chatgptQueue: {
    root: string;
    allowedOutputRoot?: string;
    pollIntervalMs: number;
  };
  activityNotifications: {
    enabled: boolean;
    root: string;
    channelId: string;
    pollIntervalMs: number;
  };
  publicAssistant: PublicAssistantConfig;
}
