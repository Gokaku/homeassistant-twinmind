import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import type { ConversationMeta, ProviderId } from "@/lib/protocol";
import { deleteConversation, openConversation, renameConversation, toast, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { DownloadIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Logo, PROVIDER_STYLE, ProviderAvatar } from "./brand";
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
  return sameDay ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The conversation list: a drawer on phones, a permanent sidebar on desktop. */
export function ConversationList({ onPicked }: { onPicked?: () => void }) {
  const conversations = useStore((s) => s.conversations);
  const currentId = useStore((s) => s.currentId);
  const groups: [string, ConversationMeta[]][] = [];
  for (const c of conversations) {
    const g = group(c.updatedAt);
    const last = groups[groups.length - 1];
    if (last && last[0] === g) last[1].push(c);
    else groups.push([g, [c]]);
  }
  const pick = (id: string | null) => {
    openConversation(id);
    onPicked?.();
  };
  return (
    <>
      <div className="px-3 pt-3">
        <Button className="h-10 w-full justify-start gap-2 rounded-xl" variant="secondary" onClick={() => pick(null)}>
          <PlusIcon className="size-4" /> New chat
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pt-2 pb-safe">
        {conversations.length === 0 && <p className="px-3 py-8 text-center text-muted-foreground text-sm">No conversations yet.</p>}
        {groups.map(([g, items]) => (
          <section key={g} className="mb-2">
            <h3 className="px-3 pt-3 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">{g}</h3>
            {items.map((c) => (
              <ConversationRow key={c.id} c={c} active={c.id === currentId} onPick={() => pick(c.id)} />
            ))}
          </section>
        ))}
        <ImportSection onImported={(id) => pick(id)} />
      </div>
    </>
  );
}

export function HistorySheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-[86vw] max-w-sm gap-0 p-0 pt-safe">
        <SheetHeader className="flex-row items-center gap-2.5 border-b px-4 py-3">
          <Logo className="size-7" />
          <div>
            <SheetTitle className="text-base">Twinmind</SheetTitle>
            <SheetDescription className="text-xs">Your conversations</SheetDescription>
          </div>
        </SheetHeader>
        <ConversationList onPicked={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}

function ConversationRow({ c, active, onPick }: { c: ConversationMeta; active: boolean; onPick: () => void }) {
  const providers = (Object.keys(c.native) as ProviderId[]).filter((p) => p in PROVIDER_STYLE);
  if (!providers.length) providers.push(c.provider);
  return (
    <div className={cn("group flex items-center gap-1 rounded-xl pr-1", active ? "bg-accent" : "hover:bg-accent/60")}>
      <button type="button" onClick={onPick} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left">
        <span className="-space-x-2 flex shrink-0">
          {providers.map((p) => (
            <ProviderAvatar key={p} provider={p} className="size-5 ring-2 ring-background" pulse={c.running && p === c.provider} />
          ))}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{c.title}</span>
          <span className="block text-muted-foreground text-xs">
            {time(c.updatedAt)} · {c.messageCount} messages
          </span>
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" className="size-8 shrink-0 rounded-lg opacity-60 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 data-[state=open]:opacity-100" aria-label="Conversation actions">
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={async () => {
              const t = await promptDialog({ title: "Rename conversation", value: c.title, confirmLabel: "Rename" });
              if (t) void renameConversation(c.id, t);
            }}
          >
            <PencilIcon className="size-4" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
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
            <Trash2Icon className="size-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

interface NativeSession {
  id: string;
  title: string;
  updatedAt: number;
}

/** Sessions started outside Twinmind (e.g. in a terminal) can be pulled in and continued. */
function ImportSection({ onImported }: { onImported: (id: string) => void }) {
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
    <section className="mt-4 border-t pt-3">
      <h3 className="px-3 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">Continue a session</h3>
      <div className="flex gap-2 px-2 py-1">
        {providers.map((p) => (
          <Button key={p.id} size="sm" variant={open === p.id ? "secondary" : "ghost"} className="rounded-full" onClick={() => load(p.id)}>
            <DownloadIcon className="size-3.5" /> {p.label}
          </Button>
        ))}
      </div>
      {open && (
        <div className="px-1">
          {!sessions && <Spinner className="mx-auto my-4 size-4 text-muted-foreground" />}
          {sessions?.length === 0 && <p className="px-3 py-3 text-muted-foreground text-xs">No other {PROVIDER_STYLE[open].name} sessions in /config.</p>}
          {sessions?.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={!!busy}
              onClick={() => doImport(open, s.id)}
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-accent/60"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{s.title}</span>
                <span className="block text-muted-foreground text-xs">{time(s.updatedAt)}</span>
              </span>
              {busy === s.id && <Spinner className="size-4" />}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
