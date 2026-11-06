import { useSyncExternalStore } from "react";
import { toast as sonner } from "sonner";
import { api, uploadFile, wsUrl } from "./api";
import { loadPref, savePref } from "./prefs";
import type {
  ApprovalDecision,
  ChatMessage,
  ClientMessage,
  Conversation,
  ConversationMeta,
  Part,
  ProviderId,
  ProviderInfo,
  ServerEvent,
} from "./protocol";

export type Connection = "connecting" | "open" | "reconnecting" | "denied";

export interface State {
  connection: Connection;
  deniedReason: string | null;
  user: { id: string; name: string } | null;
  providers: ProviderInfo[];
  conversations: ConversationMeta[];
  details: Record<string, Conversation>;
  currentId: string | null;
  provider: ProviderId;
  modes: Partial<Record<ProviderId, string>>;
  models: Partial<Record<ProviderId, string>>;
  /** A send is in flight and no conversation event has confirmed it yet. */
  pending: string | null;
}

let state: State = {
  connection: "connecting",
  deniedReason: null,
  user: null,
  providers: [],
  conversations: [],
  details: {},
  currentId: null,
  provider: loadPref<ProviderId>("provider", "claude"),
  modes: loadPref("modes", {}),
  models: loadPref("models", {}),
  pending: null,
};

const listeners = new Set<() => void>();
function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}
export const getState = () => state;
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

/** Show a toast (shadcn's sonner). */
export function toast(text: string, level: "error" | "info" = "error") {
  if (level === "error") sonner.error(text);
  else sonner.info(text);
}

/* ---------- immutable helpers ---------- */

function patchConversation(id: string, fn: (c: Conversation) => Conversation) {
  const c = state.details[id];
  if (!c) return;
  set({ details: { ...state.details, [id]: fn(c) } });
}

function patchMessage(cid: string, mid: string, fn: (m: ChatMessage) => ChatMessage) {
  patchConversation(cid, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === mid ? fn(m) : m)) }));
}

function upsertPart(m: ChatMessage, part: Part): ChatMessage {
  const i = m.parts.findIndex((p) => p.id === part.id);
  const parts = i >= 0 ? m.parts.map((p, j) => (j === i ? part : p)) : [...m.parts, part];
  return { ...m, parts };
}

function upsertMeta(meta: ConversationMeta) {
  const list = state.conversations.filter((c) => c.id !== meta.id);
  list.push(meta);
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  const d = state.details[meta.id];
  set({
    conversations: list,
    details: d ? { ...state.details, [meta.id]: { ...d, ...meta } } : state.details,
  });
}

/* ---------- WebSocket ---------- */

/** The send waiting for the server's confirmation (conversation event) or rejection (error event). */
let inflight: {
  id: string;
  /** Conversation that was open when the user pressed send (null = new chat). */
  from: string | null;
  resolve: () => void;
  reject: (e: Error) => void;
} | null = null;

function settleInflight(err?: Error) {
  const f = inflight;
  if (!f) return;
  inflight = null;
  set({ pending: null });
  if (err) f.reject(err);
  else f.resolve();
}

let ws: WebSocket | null = null;
let retry = 0;
let pingTimer: ReturnType<typeof setInterval> | null = null;

export function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const sock = new WebSocket(wsUrl());
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    set({ connection: "open", deniedReason: null });
    void refreshConversations();
    if (state.currentId) void loadConversation(state.currentId);
    pingTimer = setInterval(() => send({ type: "ping" }), 25_000);
  };
  sock.onmessage = (ev) => {
    try {
      handle(JSON.parse(ev.data) as ServerEvent);
    } catch (e) {
      console.error(e);
    }
  };
  sock.onclose = async (ev) => {
    if (pingTimer) clearInterval(pingTimer);
    ws = null;
    // A send that was not confirmed yet will never be: give the text back to the user.
    settleInflight(new Error("Connection lost before the message was confirmed. Please send it again."));
    // Find out whether we were refused (not an admin) or just disconnected.
    // Only Twinmind's own 403 is final. A 401 usually means Home Assistant's ingress
    // session expired (the HA frontend renews it), a 503 that HA is unreachable: retry.
    if (ev.code === 4403 || state.connection !== "open") {
      try {
        await api("me");
      } catch (e: any) {
        if (e?.status === 403) {
          set({ connection: "denied", deniedReason: e.message });
          return;
        }
      }
    }
    set({ connection: "reconnecting" });
    scheduleReconnect();
  };
}

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleReconnect(delay = Math.min(15_000, 500 * 2 ** retry++)) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// Phones suspend background tabs: reconnect right away when the app comes back.
if (typeof window !== "undefined") {
  const wake = () => {
    if (ws || state.connection === "denied") return;
    retry = 0;
    scheduleReconnect(0);
  };
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && wake());
}

function send(msg: ClientMessage): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

function handle(e: ServerEvent) {
  switch (e.type) {
    case "hello":
      set({ user: e.user, providers: e.providers });
      ensureProviderValid();
      break;
    case "providers":
      set({ providers: e.providers });
      ensureProviderValid();
      break;
    case "conversation": {
      if (e.clientRequestId && inflight && e.clientRequestId === inflight.id) {
        if (!state.details[e.meta.id]) {
          set({ details: { ...state.details, [e.meta.id]: { ...e.meta, seen: {}, messages: [] } } });
        }
        // Follow the message only if the user is still looking at where they sent it from.
        if (state.currentId === inflight.from) set({ currentId: e.meta.id });
        settleInflight();
      }
      upsertMeta(e.meta);
      break;
    }
    case "snapshot":
      set({ details: { ...state.details, [e.conversation.id]: e.conversation } });
      break;
    case "conversation.deleted": {
      const { [e.id]: _, ...rest } = state.details;
      set({
        conversations: state.conversations.filter((c) => c.id !== e.id),
        details: rest,
        currentId: state.currentId === e.id ? null : state.currentId,
      });
      break;
    }
    case "message":
      patchConversation(e.conversationId, (c) => {
        const exists = c.messages.some((m) => m.id === e.message.id);
        return { ...c, messages: exists ? c.messages.map((m) => (m.id === e.message.id ? e.message : m)) : [...c.messages, e.message] };
      });
      break;
    case "part":
      patchMessage(e.conversationId, e.messageId, (m) => upsertPart(m, e.part));
      break;
    case "text.delta":
    case "reasoning.delta":
      patchMessage(e.conversationId, e.messageId, (m) => {
        const p = m.parts.find((x) => x.id === e.partId);
        if (p && (p.type === "text" || p.type === "reasoning")) return upsertPart(m, { ...p, text: p.text + e.delta });
        const created: Part =
          e.type === "text.delta" ? { type: "text", id: e.partId, text: e.delta } : { type: "reasoning", id: e.partId, text: e.delta };
        return upsertPart(m, created);
      });
      break;
    case "usage":
      patchMessage(e.conversationId, e.messageId, (m) => ({ ...m, usage: e.usage }));
      break;
    case "turn.end":
      patchMessage(e.conversationId, e.messageId, (m) => ({
        ...m,
        status: e.status,
        parts: m.parts.map((p) => (p.type === "reasoning" ? { ...p, done: true } : p)),
      }));
      break;
    case "error":
      if (e.clientRequestId && inflight && e.clientRequestId === inflight.id) settleInflight(new Error(e.message));
      else toast(e.message);
      break;
  }
}

function ensureProviderValid() {
  const ids = state.providers.map((p) => p.id);
  if (ids.length && !ids.includes(state.provider)) set({ provider: ids[0] });
}

/* ---------- actions ---------- */

export async function refreshConversations() {
  try {
    const r = await api<{ conversations: ConversationMeta[] }>("conversations");
    set({ conversations: r.conversations });
  } catch {
    /* shown via connection state */
  }
}

export async function loadConversation(id: string) {
  // Preferred: ask on the event socket. The snapshot then arrives in order with the live
  // events, so text streamed while loading is neither lost nor applied twice.
  if (send({ type: "subscribe", conversationId: id })) return;
  // Not connected: nothing is streaming to us anyway, plain HTTP is fine.
  try {
    const r = await api<{ conversation: Conversation }>(`conversations/${id}`);
    set({ details: { ...state.details, [id]: r.conversation } });
  } catch (e: any) {
    toast(e.message);
  }
}

export function openConversation(id: string | null) {
  set({ currentId: id });
  if (id) {
    const c = state.conversations.find((x) => x.id === id);
    if (c && c.provider !== state.provider && state.providers.some((p) => p.id === c.provider)) setProvider(c.provider);
    void loadConversation(id);
  }
}

export function setProvider(p: ProviderId) {
  set({ provider: p });
  savePref("provider", p);
}

export function currentMode(s: State, p: ProviderId = s.provider): string {
  const info = s.providers.find((x) => x.id === p);
  const m = s.modes[p];
  return info && m && info.modes.some((x) => x.id === m) ? m : info?.defaultMode ?? "";
}

export function setMode(p: ProviderId, mode: string) {
  set({ modes: { ...state.modes, [p]: mode } });
  savePref("modes", state.modes);
}

export function setModel(p: ProviderId, model: string) {
  set({ models: { ...state.models, [p]: model } });
  savePref("models", state.models);
}

export interface OutgoingFile {
  url: string;
  mediaType: string;
  filename?: string;
}

/**
 * Send a message. Resolves true once the server has accepted it; false (after showing
 * why) if it was rejected or the connection dropped, so the composer keeps the text.
 */
export async function sendMessage(text: string, files: OutgoingFile[]): Promise<boolean> {
  if (state.pending) return false;
  // Capture where this message goes now: the user may switch chats while files upload.
  const from = state.currentId;
  const provider = state.provider;
  const mode = currentMode(state);
  const model = state.models[provider] || undefined;
  const clientRequestId = crypto.randomUUID?.() ?? String(Math.random());
  set({ pending: clientRequestId });
  try {
    const attachments: string[] = [];
    for (const f of files) {
      const blob = await (await fetch(f.url)).blob();
      const typed = blob.type ? blob : new Blob([blob], { type: f.mediaType });
      const u = await uploadFile(typed, f.filename || "attachment");
      attachments.push(u.id);
    }
    const confirmed = new Promise<void>((resolve, reject) => {
      inflight = { id: clientRequestId, from, resolve, reject };
    });
    const timer = setTimeout(() => settleInflight(new Error("The server did not confirm the message. Please try again.")), 20_000);
    const ok = send({ type: "send", clientRequestId, conversationId: from ?? undefined, provider, mode, model, text, attachments });
    if (!ok) settleInflight(new Error("Not connected. Reconnecting…"));
    try {
      await confirmed;
    } finally {
      clearTimeout(timer);
    }
    return true;
  } catch (e: any) {
    if (inflight?.id === clientRequestId) inflight = null;
    set({ pending: null });
    toast(e?.message ?? "Could not send");
    return false;
  }
}

export function approve(approvalId: string, decision: ApprovalDecision) {
  if (!send({ type: "approve", approvalId, decision })) toast("Not connected");
}

export function answerQuestion(questionPartId: string, answers: Record<string, string[]> | null) {
  if (!send({ type: "answer", questionPartId, answers })) toast("Not connected");
}

export function interrupt(conversationId: string) {
  send({ type: "interrupt", conversationId });
}

export async function deleteConversation(id: string) {
  try {
    await api(`conversations/${id}`, { method: "DELETE" });
  } catch (e: any) {
    toast(e.message);
  }
}

export async function renameConversation(id: string, title: string) {
  try {
    await api(`conversations/${id}`, { method: "PATCH", json: { title } });
  } catch (e: any) {
    toast(e.message);
  }
}

export async function refreshProviders() {
  try {
    const r = await api<{ providers: ProviderInfo[] }>("providers");
    set({ providers: r.providers });
  } catch (e: any) {
    toast(e.message);
  }
}
