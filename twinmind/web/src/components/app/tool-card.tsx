import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import { Terminal, TerminalActions, TerminalContent, TerminalCopyButton, TerminalHeader, TerminalTitle } from "@/components/ai-elements/terminal";
import { Plan, PlanContent, PlanDescription, PlanFooter, PlanHeader, PlanTitle, PlanTrigger } from "@/components/ai-elements/plan";
import { Tool, ToolContent, getStatusBadge } from "@/components/ai-elements/tool";
import { MessageResponse } from "@/components/ai-elements/message";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ProviderId, ToolKind, ToolPart } from "@/lib/protocol";
import { approve } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { ToolUIPart } from "ai";
import { useEffect, useState } from "react";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  FileCodeIcon,
  FileTextIcon,
  GlobeIcon,
  HouseIcon,
  PlugIcon,
  SearchIcon,
  ShieldAlertIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { PROVIDER_STYLE } from "./brand";

const KIND_ICON: Record<ToolKind, LucideIcon> = {
  command: TerminalIcon,
  file: FileCodeIcon,
  read: FileTextIcon,
  search: SearchIcon,
  web: GlobeIcon,
  mcp: PlugIcon,
  ha: HouseIcon,
  agent: BotIcon,
  other: WrenchIcon,
};

const VERB: Record<ToolKind, string> = {
  command: "run a command",
  file: "change files",
  read: "read a file",
  search: "search files",
  web: "go online",
  mcp: "use a tool",
  ha: "change Home Assistant",
  agent: "start a helper agent",
  other: "use a tool",
};

/** Our tool states mapped onto the AI SDK states that AI Elements understands. */
export function uiState(p: ToolPart): ToolUIPart["state"] {
  switch (p.state) {
    case "awaiting-approval":
      return "approval-requested";
    case "completed":
      return "output-available";
    case "error":
      return "output-error";
    case "denied":
      return "output-denied";
    default:
      // Approved and now running.
      return p.approval?.decision ? "approval-responded" : "input-available";
  }
}

function inputPreview(p: ToolPart): { code: string; language: string } | null {
  const i = p.input as any;
  if (i == null) return null;
  if (p.kind === "command" && typeof i.command === "string") return { code: i.command, language: "bash" };
  if (p.name === "Write" && typeof i.content === "string") return { code: i.content, language: guessLang(i.file_path) };
  if ((p.name === "Edit" || p.name === "MultiEdit") && (i.old_string || i.edits)) {
    const edits = i.edits ?? [{ old_string: i.old_string, new_string: i.new_string }];
    const diff = edits
      .map((e: any) => [...String(e.old_string ?? "").split("\n").map((l: string) => `- ${l}`), ...String(e.new_string ?? "").split("\n").map((l: string) => `+ ${l}`)].join("\n"))
      .join("\n@@\n");
    return { code: diff, language: "diff" };
  }
  if (p.name === "ExitPlanMode" && typeof i.plan === "string") return null; // shown as Markdown by the caller
  try {
    return { code: JSON.stringify(i, null, 2), language: "json" };
  } catch {
    return null;
  }
}

function guessLang(path?: string): string {
  const ext = path?.split(".").pop()?.toLowerCase();
  return ext === "yaml" || ext === "yml" ? "yaml" : ext === "py" ? "python" : ext === "json" ? "json" : ext === "sh" ? "bash" : ext === "js" ? "javascript" : ext === "ts" ? "typescript" : "text";
}

/** "mcp__homeassistant__ha_update_entity" / "homeassistant.ha_update_entity" -> "Home Assistant". */
function displayName(p: ToolPart): string {
  if (p.kind === "ha") return "Home Assistant";
  return p.name.replace(/^mcp__([^_]+)__/, "$1 · ");
}

function Code({ code, language, label }: { code: string; language: string; label: string }) {
  return (
    <CodeBlock code={code} language={language as any} className="text-xs [&_pre]:max-h-72">
      <CodeBlockHeader className="py-1.5">
        <CodeBlockTitle>
          <CodeBlockFilename className="font-sans">{label}</CodeBlockFilename>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton className="size-7" />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  );
}

export function ToolCard({ part, provider }: { part: ToolPart; provider: ProviderId }) {
  const Icon = KIND_ICON[part.kind] ?? WrenchIcon;
  const state = uiState(part);
  const awaiting = part.state === "awaiting-approval" && !!part.approval && !part.approval.decision;
  const preview = inputPreview(part);
  const isDiff = part.kind === "file" && part.output?.includes("@@");
  const plan = part.name === "ExitPlanMode" && typeof (part.input as any)?.plan === "string" ? ((part.input as any).plan as string) : null;
  // Always controlled: opens by itself when an approval is needed, otherwise the user decides.
  const [open, setOpen] = useState(awaiting);
  useEffect(() => {
    if (awaiting) setOpen(true);
  }, [awaiting]);
  if (plan) return <PlanCard part={part} provider={provider} plan={plan} />;
  return (
    <Tool
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "mb-0 overflow-hidden rounded-xl bg-card/60 shadow-xs",
        awaiting && "border-warn/60 ring-2 ring-warn/20",
      )}
    >
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2.5 text-left">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted",
            part.kind === "ha" && "bg-sky-500/15",
            part.state === "running" && "animate-pulse",
          )}
        >
          <Icon className={cn("size-3.5 text-muted-foreground", part.kind === "ha" && "text-sky-500")} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-muted-foreground text-xs">{displayName(part)}</span>
          <span className={cn("block truncate text-[13px]", part.kind !== "ha" && "font-mono")}>{part.title}</span>
        </span>
        <span className="hidden shrink-0 sm:inline-flex">{getStatusBadge(state)}</span>
        <StatusDot state={part.state} />
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <ToolContent className="space-y-3 border-t px-3 pt-3 pb-3">
        {preview && (
          <Code
            code={preview.code}
            language={preview.language}
            label={part.kind === "command" ? "Command" : preview.language === "diff" ? "Change" : "Input"}
          />
        )}
        {part.output &&
          (isDiff ? (
            <Code code={part.output} language="diff" label="Diff" />
          ) : (
            <Terminal output={part.output} isStreaming={part.state === "running"} className={cn("text-xs", part.state === "error" && "border-destructive/50")}>
              <TerminalHeader className="py-1.5">
                <TerminalTitle>{part.state === "error" ? "Error" : "Output"}</TerminalTitle>
                <TerminalActions>
                  <TerminalCopyButton className="size-7" />
                </TerminalActions>
              </TerminalHeader>
              <TerminalContent className="max-h-72 p-3 text-xs" />
            </Terminal>
          ))}
        {part.error && <p className="text-destructive text-xs">{part.error}</p>}
      </ToolContent>
      <ApprovalBlock part={part} provider={provider} />
    </Tool>
  );
}

function StatusDot({ state }: { state: ToolPart["state"] }) {
  const cls =
    state === "completed"
      ? "bg-safe"
      : state === "error"
        ? "bg-destructive"
        : state === "denied"
          ? "bg-muted-foreground"
          : state === "awaiting-approval"
            ? "bg-warn animate-pulse"
            : "bg-codex animate-pulse";
  return <span className={cn("size-2 shrink-0 rounded-full sm:hidden", cls)} aria-label={state} />;
}

/** Approval request and outcome, shared by tool cards and plan cards. */
function ApprovalBlock({ part, provider, className }: { part: ToolPart; provider: ProviderId; className?: string }) {
  if (!part.approval) return null;
  const awaiting = part.state === "awaiting-approval" && !part.approval.decision;
  const decided = part.approval.decision;
  return (
    <Confirmation
      approval={decided ? { id: part.approval.id, approved: decided !== "deny" } : { id: part.approval.id }}
      state={awaiting ? "approval-requested" : "approval-responded"}
      className={cn("rounded-none border-0 border-t", awaiting ? "bg-warn/5 px-3 py-3" : "px-3 py-1.5")}
    >
      <ConfirmationRequest>
        <div className="flex items-start gap-2">
          <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-warn" />
          <ConfirmationTitle className="text-foreground text-sm">
            <span className={cn("font-semibold", PROVIDER_STYLE[provider].text)}>{PROVIDER_STYLE[provider].name}</span> wants to{" "}
            {part.name === "ExitPlanMode" ? "leave plan mode and carry out this plan" : (VERB[part.kind] ?? "use a tool")}.
            {part.approval.reason && <span className="mt-1 block text-muted-foreground text-xs">{part.approval.reason}</span>}
          </ConfirmationTitle>
        </div>
      </ConfirmationRequest>
      <ConfirmationAccepted>
        <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <CheckIcon className="size-3.5 text-safe" />
          {decided === "allow-session" ? "Allowed for this conversation" : "Allowed once"}
        </span>
      </ConfirmationAccepted>
      <ConfirmationRejected>
        <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <XIcon className="size-3.5" /> You denied this
        </span>
      </ConfirmationRejected>
      <ConfirmationActions className="w-full flex-wrap justify-stretch gap-2 sm:justify-end">
        <ConfirmationAction variant="outline" className="h-10 flex-1 sm:h-8 sm:flex-none" onClick={() => approve(part.approval!.id, "deny")}>
          Deny
        </ConfirmationAction>
        <ConfirmationAction variant="secondary" className="h-10 flex-1 sm:h-8 sm:flex-none" onClick={() => approve(part.approval!.id, "allow-session")}>
          Always
        </ConfirmationAction>
        <ConfirmationAction className="h-10 flex-1 sm:h-8 sm:flex-none" onClick={() => approve(part.approval!.id, "allow")}>
          Allow
        </ConfirmationAction>
      </ConfirmationActions>
    </Confirmation>
  );
}

/** Claude's ExitPlanMode: the plan in an AI Elements Plan card with the approval below. */
function PlanCard({ part, provider, plan }: { part: ToolPart; provider: ProviderId; plan: string }) {
  const awaiting = part.state === "awaiting-approval" && !part.approval?.decision;
  // The first heading becomes the card title (and is not repeated in the body).
  const heading = plan.match(/^#+\s*(.+)$/m);
  const title = heading?.[1] ?? "Plan";
  const body = heading ? plan.replace(heading[0], "").trim() : plan;
  return (
    <Plan defaultOpen className={cn(awaiting && "border-warn/60 ring-2 ring-warn/20")}>
      <PlanHeader>
        <div>
          <PlanTitle>{title}</PlanTitle>
          <PlanDescription>{`${PROVIDER_STYLE[provider].name} ${awaiting ? "proposes this plan" : "proposed this plan"}`}</PlanDescription>
        </div>
        <PlanTrigger />
      </PlanHeader>
      <PlanContent>
        <MessageResponse className="text-sm">{body}</MessageResponse>
      </PlanContent>
      {part.approval && (
        <PlanFooter className="block p-0">
          <ApprovalBlock part={part} provider={provider} />
        </PlanFooter>
      )}
    </Plan>
  );
}
