import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import { AccountsSheet } from "@/components/app/accounts-sheet";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Composer } from "@/components/app/composer";
import { DialogHost } from "@/components/app/dialogs";
import { AppSidebar } from "@/components/app/app-sidebar";
import { Thread } from "@/components/app/thread";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { openConversation, useStore } from "@/lib/store";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { CircleUserRoundIcon, LockIcon, SquarePenIcon, WifiOffIcon } from "lucide-react";
import { useState } from "react";

export default function App() {
  const connection = useStore((s) => s.connection);
  const denied = useStore((s) => s.deniedReason);
  const [accounts, setAccounts] = useState(false);
  const [suggestion, setSuggestion] = useState<{ text: string; n: number } | null>(null);

  if (connection === "denied") return <Denied reason={denied} />;

  return (
    <TooltipProvider delayDuration={400}>
      <PromptInputProvider>
        <SidebarProvider className="h-full min-h-0">
          <AppSidebar />
          <SidebarInset className="min-h-0 min-w-0">
            <Header onAccounts={() => setAccounts(true)} />
            {connection !== "open" && (
              <Alert className="rounded-none border-x-0 border-t-0">
                <WifiOffIcon />
                <AlertDescription>{connection === "connecting" ? "Connecting…" : "Reconnecting…"}</AlertDescription>
              </Alert>
            )}
            <div className="flex min-h-0 flex-1 flex-col">
              <Thread onSuggestion={(text) => setSuggestion((s) => ({ text, n: (s?.n ?? 0) + 1 }))} />
            </div>
            <Composer onOpenAccounts={() => setAccounts(true)} suggestion={suggestion} />
          </SidebarInset>
          <AccountsSheet open={accounts} onOpenChange={setAccounts} />
          <DialogHost />
          <Toaster position="top-center" />
        </SidebarProvider>
      </PromptInputProvider>
    </TooltipProvider>
  );
}

function Header({ onAccounts }: { onAccounts: () => void }) {
  const title = useStore((s) => (s.currentId ? s.conversations.find((c) => c.id === s.currentId)?.title : null));
  const hasChat = useStore((s) => !!s.currentId);
  return (
    <header className="pt-safe flex h-14 shrink-0 items-center gap-2 border-b px-2">
      <SidebarTrigger />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      <span className="min-w-0 flex-1 truncate font-medium text-sm">{title ?? "Twinmind"}</span>
      {hasChat && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon" variant="ghost" onClick={() => openConversation(null)} aria-label="New chat">
              <SquarePenIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New chat</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon" variant="ghost" onClick={onAccounts} aria-label="Accounts">
            <CircleUserRoundIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Accounts</TooltipContent>
      </Tooltip>
    </header>
  );
}

function Denied({ reason }: { reason: string | null }) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LockIcon />
        </EmptyMedia>
        <EmptyTitle>Twinmind is admin-only</EmptyTitle>
        <EmptyDescription>{reason ?? "You need to be a Home Assistant administrator."}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
