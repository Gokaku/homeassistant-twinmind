import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import { AccountsSheet } from "@/components/app/accounts-sheet";
import { Logo } from "@/components/app/brand";
import { Composer } from "@/components/app/composer";
import { DialogHost } from "@/components/app/dialogs";
import { ConversationList, HistorySheet } from "@/components/app/history-sheet";
import { ProviderSwitch } from "@/components/app/provider-switch";
import { Thread } from "@/components/app/thread";
import { Button } from "@/components/ui/button";
import { openConversation, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CircleUserRoundIcon, LockIcon, MenuIcon, SquarePenIcon, WifiOffIcon } from "lucide-react";
import { useState } from "react";

export default function App() {
  const connection = useStore((s) => s.connection);
  const denied = useStore((s) => s.deniedReason);
  const [history, setHistory] = useState(false);
  const [accounts, setAccounts] = useState(false);
  const [suggestion, setSuggestion] = useState<{ text: string; n: number } | null>(null);

  if (connection === "denied") return <Denied reason={denied} />;

  return (
    <PromptInputProvider>
      <div className="flex h-full">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
        <Header onMenu={() => setHistory(true)} onAccounts={() => setAccounts(true)} />
        {connection !== "open" && (
          <div className="flex items-center justify-center gap-2 bg-muted py-1.5 text-muted-foreground text-xs">
            <WifiOffIcon className="size-3.5" /> {connection === "connecting" ? "Connecting…" : "Reconnecting…"}
          </div>
        )}
        <main className="flex min-h-0 flex-1 flex-col">
          <Thread onSuggestion={(text) => setSuggestion((s) => ({ text, n: (s?.n ?? 0) + 1 }))} />
        </main>
        <Composer onOpenAccounts={() => setAccounts(true)} suggestion={suggestion} />
        </div>
        <HistorySheet open={history} onOpenChange={setHistory} />
        <AccountsSheet open={accounts} onOpenChange={setAccounts} />
        <DialogHost />
        <Toast />
      </div>
    </PromptInputProvider>
  );
}

/** Desktop: the conversation list stays visible. */
function Sidebar() {
  return (
    <aside className="hidden w-72 shrink-0 flex-col border-r bg-muted/30 lg:flex xl:w-80">
      <div className="flex h-14 items-center gap-2.5 border-b px-4">
        <Logo className="size-7" />
        <span className="font-semibold tracking-tight">Twinmind</span>
      </div>
      <ConversationList />
    </aside>
  );
}

function Header({ onMenu, onAccounts }: { onMenu: () => void; onAccounts: () => void }) {
  const title = useStore((s) => (s.currentId ? s.conversations.find((c) => c.id === s.currentId)?.title : null));
  const hasChat = useStore((s) => !!s.currentId);
  return (
    <header className="pt-safe sticky top-0 z-20 border-b bg-background/80 backdrop-blur-xl">
      <div className="mx-auto grid h-14 max-w-3xl grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 px-1.5">
        <Button size="icon" variant="ghost" className="size-10 rounded-full lg:invisible" onClick={onMenu} aria-label="Conversations">
          <MenuIcon className="size-5" />
        </Button>
        <div className="flex min-w-0 items-center justify-center gap-2 overflow-hidden">
          {title ? (
            <span className="hidden truncate font-medium text-sm md:block">{title}</span>
          ) : (
            <Logo className="hidden size-6 md:block lg:hidden" />
          )}
          <ProviderSwitch className="md:ml-3" />
        </div>
        <div className="flex items-center">
          {hasChat && (
            <Button size="icon" variant="ghost" className="size-10 rounded-full" onClick={() => openConversation(null)} aria-label="New chat">
              <SquarePenIcon className="size-5" />
            </Button>
          )}
          <Button size="icon" variant="ghost" className="size-10 rounded-full" onClick={onAccounts} aria-label="Accounts">
            <CircleUserRoundIcon className="size-5" />
          </Button>
        </div>
      </div>
    </header>
  );
}

function Toast() {
  const t = useStore((s) => s.toast);
  // The live region stays mounted so screen readers announce the text when it changes.
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+4rem)] z-50 flex justify-center px-4"
    >
      {t && (
        <div
          key={t.id}
          className={cn(
            "fade-in slide-in-from-top-2 pointer-events-auto max-w-md animate-in rounded-2xl border px-4 py-2.5 text-sm shadow-lg backdrop-blur-xl",
            t.level === "error" ? "border-destructive/30 bg-background/95 text-destructive" : "bg-background/95",
          )}
        >
          {t.text}
        </div>
      )}
    </div>
  );
}

function Denied({ reason }: { reason: string | null }) {
  return (
    <div className="twin-glow flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-muted">
        <LockIcon className="size-6 text-muted-foreground" />
      </span>
      <div>
        <h1 className="font-semibold text-lg">Twinmind is admin-only</h1>
        <p className="mt-1 max-w-xs text-muted-foreground text-sm">{reason ?? "You need to be a Home Assistant administrator."}</p>
      </div>
    </div>
  );
}
