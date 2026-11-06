import { ModelSelectorLogo, ModelSelectorLogoGroup } from "@/components/ai-elements/model-selector";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import type { ConversationMeta, ProviderId } from "@/lib/protocol";
import { deleteConversation, openConversation, renameConversation, toast, useStore } from "@/lib/store";
import { DownloadIcon, MessagesSquareIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { APP_ICON, PROVIDER_LOGO, PROVIDER_NAME } from "./brand";
import { confirmDialog, promptDialog } from "./dialogs";

function group(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const day = 86_400_000;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= start) return "Today";
  if (ts >= start - day) return "Yesterday";
  if (ts >= start - 6 * day) return "This week";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function time(ts: number): string {
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Conversations in the shadcn Sidebar: fixed on desktop, a sheet on phones. */
export function AppSidebar() {
  const conversations = useStore((s) => s.conversations);
  const currentId = useStore((s) => s.currentId);
  const { isMobile, setOpenMobile } = useSidebar();
  const pick = (id: string | null) => {
    openConversation(id);
    if (isMobile) setOpenMobile(false);
  };
  const groups: [string, ConversationMeta[]][] = [];
  for (const c of conversations) {
    const g = group(c.updatedAt);
    const last = groups[groups.length - 1];
    if (last && last[0] === g) last[1].push(c);
    else groups.push([g, [c]]);
  }

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" onClick={() => pick(null)}>
              <img src={APP_ICON} alt="" className="size-8" />
              <span className="font-semibold">Twinmind</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => pick(null)} tooltip="New chat">
              <PlusIcon />
              <span>New chat</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {conversations.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessagesSquareIcon />
              </EmptyMedia>
              <EmptyTitle>No conversations yet</EmptyTitle>
              <EmptyDescription>Start a chat; it will show up here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {groups.map(([g, items]) => (
          <SidebarGroup key={g}>
            <SidebarGroupLabel>{g}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {items.map((c) => (
                  <ConversationItem key={c.id} c={c} active={c.id === currentId} onPick={() => pick(c.id)} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
        <ImportGroup onImported={(id) => pick(id)} />
      </SidebarContent>
    </Sidebar>
  );
}

function ConversationItem({ c, active, onPick }: { c: ConversationMeta; active: boolean; onPick: () => void }) {
  const providers = (Object.keys(c.native) as ProviderId[]).filter((p) => p in PROVIDER_LOGO);
  if (!providers.length) providers.push(c.provider);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={active} onClick={onPick} size="lg" tooltip={c.title}>
        <ModelSelectorLogoGroup>
          {providers.map((p) => (
            <ModelSelectorLogo key={p} provider={PROVIDER_LOGO[p]} />
          ))}
        </ModelSelectorLogoGroup>
        <div className="grid min-w-0 flex-1 leading-tight">
          <span className="truncate">{c.title}</span>
          <span className="truncate text-muted-foreground text-xs">
            {c.running ? "Replying…" : `${time(c.updatedAt)} · ${c.messageCount} messages`}
          </span>
        </div>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction showOnHover aria-label="Conversation actions">
            <MoreHorizontalIcon />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start">
          <DropdownMenuItem
            onSelect={async () => {
              const t = await promptDialog({ title: "Rename conversation", value: c.title, confirmLabel: "Rename" });
              if (t) void renameConversation(c.id, t);
            }}
          >
            <PencilIcon /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onSelect={async () => {
              const ok = await confirmDialog({
                title: "Delete conversation?",
                description: `"${c.title}" will be removed from Twinmind. The assistants' own session files are kept.`,
                confirmLabel: "Delete",
                destructive: true,
              });
              if (ok) void deleteConversation(c.id);
            }}
          >
            <Trash2Icon /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

interface NativeSession {
  id: string;
  title: string;
  updatedAt: number;
}

/** Native Claude/Codex sessions stored by this add-on that are not in the list (e.g. after a delete). */
function ImportGroup({ onImported }: { onImported: (id: string) => void }) {
  const all = useStore((s) => s.providers);
  const providers = all.filter((p) => p.auth.state === "signed-in" && p.id !== "mock");
  const [open, setOpen] = useState<ProviderId | null>(null);
  const [sessions, setSessions] = useState<NativeSession[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!providers.length) return null;

  const load = async (p: ProviderId) => {
    if (open === p) return setOpen(null);
    setOpen(p);
    setSessions(null);
    try {
      const r = await api<{ sessions: NativeSession[] }>(`providers/${p}/sessions`);
      setSessions(r.sessions);
    } catch (e: any) {
      toast(e.message);
      setSessions([]);
    }
  };
  const doImport = async (p: ProviderId, sid: string) => {
    setBusy(sid);
    try {
      const r = await api<{ id: string }>(`providers/${p}/sessions/${encodeURIComponent(sid)}/import`, { method: "POST" });
      onImported(r.id);
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Continue a session</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {providers.map((p) => (
            <SidebarMenuItem key={p.id}>
              <SidebarMenuButton isActive={open === p.id} onClick={() => load(p.id)}>
                <DownloadIcon />
                <span>{p.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          {open && !sessions && <SidebarMenuSkeleton />}
          {open && sessions?.length === 0 && (
            <SidebarMenuItem>
              <SidebarMenuButton disabled>
                <span>No other {PROVIDER_NAME[open]} sessions</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {open &&
            sessions?.map((s) => (
              <SidebarMenuItem key={s.id}>
                <SidebarMenuButton size="lg" disabled={!!busy} onClick={() => doImport(open, s.id)}>
                  <div className="grid min-w-0 flex-1 leading-tight">
                    <span className="truncate">{s.title}</span>
                    <span className="truncate text-muted-foreground text-xs">{time(s.updatedAt)}</span>
                  </div>
                  {busy === s.id && <Spinner />}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
