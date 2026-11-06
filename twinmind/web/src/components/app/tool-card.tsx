import { CodeBlock } from "@/components/ai-elements/code-block";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import { Tool, ToolContent, getStatusBadge } from "@/components/ai-elements/tool";
import { MessageResponse } from "@/components/ai-elements/message";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ProviderId, ToolKind, ToolPart } from "@/lib/protocol";
import { approve } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { ToolUIPart } from "ai";
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
      return "input-available";
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

export function ToolCard({ part, provider }: { part: ToolPart; provider: ProviderId }) {
  const Icon = KIND_ICON[part.kind] ?? WrenchIcon;
  const state = uiState(part);
  const awaiting = part.state === "awaiting-approval" && !!part.approval && !part.approval.decision;
  const preview = inputPreview(part);
  const isDiff = part.kind === "file" && part.output?.includes("@@");
  const plan = part.name === "ExitPlanMode" && typeof (part.input as any)?.plan === "string" ? ((part.input as any).plan as string) : null;
  return (
    <Tool
      defaultOpen={awaiting}
      open={awaiting ? true : undefined}
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
        {plan && <MessageResponse className="text-sm">{plan}</MessageResponse>}
        {preview && (
          <div className="overflow-hidden rounded-lg text-xs [&_pre]:max-h-72">
            <CodeBlock code={preview.code} language={preview.language as any} />
          </div>
        )}
        {part.output && (
          <div className="space-y-1">
            <div className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
              {part.state === "error" ? "Error" : "Output"}
            </div>
            {isDiff ? (
              <div className="overflow-hidden rounded-lg text-xs [&_pre]:max-h-72">
                <CodeBlock code={part.output} language="diff" />
              </div>
            ) : (
              <pre
                className={cn(
                  "max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-3 font-mono text-xs",
                  part.state === "error" && "bg-destructive/10 text-destructive",
                )}
              >
                {part.output}
              </pre>
            )}
          </div>
        )}
        {part.error && <p className="text-destructive text-xs">{part.error}</p>}
      </ToolContent>
      {part.approval?.decision && (
        <div className="flex items-center gap-1.5 border-t px-3 py-1.5 text-muted-foreground text-xs">
          {part.approval.decision === "deny" ? <XIcon className="size-3.5" /> : <CheckIcon className="size-3.5 text-safe" />}
          {part.approval.decision === "deny" ? "You denied this" : part.approval.decision === "allow-session" ? "Allowed for this session" : "Allowed once"}
        </div>
      )}
      {awaiting && part.approval && (
        <Confirmation
          approval={{ id: part.approval.id }}
          state="approval-requested"
          className="rounded-none border-0 border-t bg-warn/5 px-3 py-3"
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
      )}
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
