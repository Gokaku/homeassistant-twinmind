import type {
  TokenUsage,
  Question,
  ApprovalDecision,
  AuthState,
  ChatMessage,
  ModeInfo,
  ModelInfo,
  Part,
  ProviderId,
  ToolKind,
} from "../protocol.js";
import type { StoredUpload } from "../uploads.js";

export type ProviderEvent =
  | { type: "native-id"; id: string }
  | { type: "text-delta"; partId: string; delta: string }
  | { type: "reasoning-delta"; partId: string; delta: string }
  /** Insert or replace a whole part (tool updates, todo lists, notices...). */
  | { type: "part"; part: Part }
  | { type: "usage"; usage: TokenUsage };

export interface ApprovalRequest {
  /** The tool part this approval belongs to (created if it does not exist yet). */
  toolPartId: string;
  name: string;
  kind: ToolKind;
  title: string;
  input?: unknown;
  reason?: string;
  /** Cancels the request (the card is closed as denied), e.g. when the tool call timed out. */
  signal?: AbortSignal;
}

/** A message the user sent while the turn was running. */
export interface SteerInput {
  text: string;
  attachments: StoredUpload[];
}

export interface TurnContext {
  prompt: string;
  attachments: StoredUpload[];
  mode: string;
  model?: string;
  /** Thinking level picked by the user, if the model supports choosing one. */
  effort?: string;
  cwd: string;
  /** Native session/thread id to resume, if this provider has seen the conversation before. */
  nativeId?: string;
  /** Twinmind's Home Assistant tools (MCP over HTTP), if available. */
  mcp?: { url: string; secret: string };
  signal: AbortSignal;
  emit(e: ProviderEvent): void;
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
  /** Ask the user questions; resolves with their answers, or null if dismissed/aborted. */
  requestInput(req: { partId: string; questions: Question[]; signal?: AbortSignal }): Promise<Record<string, string[]> | null>;
  /**
   * Providers that can take more user input while the turn runs register how. The function
   * resolves true once the provider has accepted the message into this turn; false (or no
   * function) and Twinmind queues it for the next turn instead.
   */
  setSteer?(fn: (input: SteerInput) => Promise<boolean>): void;
}

export interface NativeSession {
  id: string;
  title: string;
  updatedAt: number;
  cwd?: string;
}

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  readonly modes: ModeInfo[];
  readonly defaultMode: string;
  models(): Promise<ModelInfo[]>;
  auth(): Promise<AuthState>;
  startLogin?(): Promise<AuthState>;
  submitLoginCode?(code: string): Promise<AuthState>;
  cancelLogin?(): Promise<void>;
  logout?(): Promise<void>;
  /** Run one turn. Resolves when the turn ends; rejects on failure. */
  run(ctx: TurnContext): Promise<{ status: "completed" | "interrupted" }>;
  listNative?(): Promise<NativeSession[]>;
  readNative?(id: string): Promise<ChatMessage[]>;
  /** Called when the add-on shuts down. */
  dispose?(): Promise<void>;
}
