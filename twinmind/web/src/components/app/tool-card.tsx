import { CodeBlock } from "@/components/ai-elements/code-block";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import { Terminal } from "@/components/ai-elements/terminal";
import { Plan, PlanContent, PlanDescription, PlanFooter, PlanHeader, PlanTitle, PlanTrigger } from "@/components/ai-elements/plan";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { MessageResponse } from "@/components/ai-elements/message";
import type { ProviderId, ToolKind, ToolPart } from "@/lib/protocol";
import { approve } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { ToolUIPart } from "ai";
import { useEffect, useState } from "react";
import { CheckIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { PROVIDER_STYLE } from "./brand";

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

/** "mcp__homeassistant__ha_update_entity" / "homeassistant.ha_update_entity" -> "Home Assistant". */
function displayName(p: ToolPart): string {
  if (p.kind === "ha") return "Home Assistant";
  return p.name.replace(/^mcp__([^_]+)__/, "$1 · ");
}

export function ToolCard({ part, provider }: { part: ToolPart; provider: ProviderId }) {
  const state = uiState(part);
  const awaiting = part.state === "awaiting-approval" && !!part.approval && !part.approval.decision;
  const plan = part.name === "ExitPlanMode" && typeof (part.input as any)?.plan === "string" ? ((part.input as any).plan as string) : null;
  // Opens by itself when an approval is needed, otherwise the user decides.
  const [open, setOpen] = useState(awaiting);
  useEffect(() => {
    if (awaiting) setOpen(true);
  }, [awaiting]);
  if (plan) return <PlanCard part={part} provider={provider} plan={plan} />;

  const isDiff = part.kind === "file" && !!part.output?.includes("@@");
  const output = !part.output ? undefined : isDiff ? (
    <CodeBlock code={part.output} language="diff" />
  ) : part.kind === "command" ? (
    <Terminal output={part.output} isStreaming={part.state === "running"} />
  ) : (
    part.output
  );

  return (
    <Tool open={open} onOpenChange={setOpen}>
      <ToolHeader type="dynamic-tool" toolName={displayName(part)} title={`${displayName(part)}: ${part.title}`} state={state} />
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput output={output} errorText={part.state === "error" ? (part.error ?? "The tool failed.") : undefined} />
      </ToolContent>
      <ApprovalBlock part={part} provider={provider} />
    </Tool>
  );
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
