/**
 * The normalized event protocol shared by every provider and the web UI.
 * The web app imports this file directly (see web/src/lib/protocol.ts).
 */

export type ProviderId = "claude" | "codex" | "mock";

export type ToolState = "running" | "awaiting-approval" | "completed" | "error" | "denied";
export type ToolKind = "command" | "file" | "read" | "search" | "web" | "mcp" | "ha" | "agent" | "other";

export interface TextPart {
  type: "text";
  id: string;
  text: string;
}
export interface ReasoningPart {
  type: "reasoning";
  id: string;
  text: string;
  done?: boolean;
}
export interface ToolPart {
  type: "tool";
  id: string;
  name: string;
  kind: ToolKind;
  /** Short human title, e.g. the command line or file path. */
  title: string;
  input?: unknown;
  output?: string;
  state: ToolState;
  error?: string;
  approval?: { id: string; decision?: ApprovalDecision; reason?: string };
}
export interface TodoPart {
  type: "todo";
  id: string;
  items: { text: string; status: "pending" | "in_progress" | "completed" }[];
}
export interface FilePart {
  type: "file";
  id: string;
  uploadId: string;
  name: string;
  mediaType: string;
  size: number;
}
export interface NoticePart {
  type: "notice";
  id: string;
  level: "info" | "warning" | "error";
  text: string;
}
export type Part = TextPart | ReasoningPart | ToolPart | TodoPart | FilePart | NoticePart;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** For assistant messages: which provider wrote it. For user messages: who it was sent to. */
  provider: ProviderId;
  model?: string;
  mode?: string;
  parts: Part[];
  createdAt: number;
  status?: "streaming" | "completed" | "interrupted" | "failed";
}

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Provider most recently used. */
  provider: ProviderId;
  /** Native session ids per provider (Claude session id, Codex thread id). */
  native: Partial<Record<ProviderId, string>>;
  messageCount: number;
  running?: boolean;
}

export interface Conversation extends ConversationMeta {
  /** Per provider: number of messages that provider has already seen in its native session. */
  seen: Partial<Record<ProviderId, number>>;
  messages: ChatMessage[];
}

export type ApprovalDecision = "allow" | "allow-session" | "deny";

export interface ModeInfo {
  id: string;
  label: string;
  description: string;
  /** "safe" = read-only, "normal" = asks, "elevated" = auto edits, "danger" = no questions asked. */
  risk: "safe" | "normal" | "elevated" | "danger";
}
export interface ModelInfo {
  id: string;
  label: string;
  description?: string;
}

export type AuthState =
  | { state: "signed-out" }
  | { state: "signed-in"; account?: string; plan?: string }
  | { state: "pending"; flow: "code-paste"; url: string }
  | { state: "pending"; flow: "device-code"; url: string; code: string }
  | { state: "unavailable"; reason: string };

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  modes: ModeInfo[];
  defaultMode: string;
  models: ModelInfo[];
  auth: AuthState;
}

export interface UploadInfo {
  id: string;
  name: string;
  mediaType: string;
  size: number;
}

/* ---------- client -> server ---------- */

export type ClientMessage =
  | {
      type: "send";
      /** Omit to start a new conversation. */
      conversationId?: string;
      clientRequestId: string;
      provider: ProviderId;
      mode: string;
      model?: string;
      text: string;
      attachments?: string[];
    }
  | { type: "approve"; approvalId: string; decision: ApprovalDecision }
  | { type: "interrupt"; conversationId: string }
  /** Ask for a snapshot of a conversation (ordered with the live events on this socket). */
  | { type: "subscribe"; conversationId: string }
  | { type: "ping" };

/* ---------- server -> client ---------- */

export type ServerEvent =
  | { type: "hello"; user: { id: string; name: string }; providers: ProviderInfo[] }
  | { type: "providers"; providers: ProviderInfo[] }
  | { type: "conversation"; meta: ConversationMeta; clientRequestId?: string }
  | { type: "conversation.deleted"; id: string }
  /** Full state of a conversation, answer to "subscribe". Events after it on the same socket are newer. */
  | { type: "snapshot"; conversation: Conversation & { running?: boolean } }
  | { type: "message"; conversationId: string; message: ChatMessage }
  | { type: "text.delta"; conversationId: string; messageId: string; partId: string; delta: string }
  | { type: "reasoning.delta"; conversationId: string; messageId: string; partId: string; delta: string }
  | { type: "part"; conversationId: string; messageId: string; part: Part }
  | {
      type: "turn.end";
      conversationId: string;
      messageId: string;
      status: "completed" | "interrupted" | "failed";
      error?: string;
    }
  | { type: "error"; message: string; clientRequestId?: string }
  | { type: "pong" };
