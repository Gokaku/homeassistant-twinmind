import { Attachment, AttachmentInfo, AttachmentPreview, Attachments } from "@/components/ai-elements/attachments";
import { Checkpoint, CheckpointIcon } from "@/components/ai-elements/checkpoint";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import {
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemDescription,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/components/ai-elements/queue";
import { uploadUrl } from "@/lib/api";
import type { ChatMessage, Part, ProviderId } from "@/lib/protocol";
import { toast, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  AlertTriangleIcon,
  ArrowLeftRightIcon,
  CheckIcon,
  CopyIcon,
  InfoIcon,
  ListTodoIcon,
} from "lucide-react";
import { memo, useState } from "react";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import { Badge } from "@/components/ui/badge";
import { APP_ICON, PROVIDER_LOGO, PROVIDER_NAME } from "./brand";
import { QuestionCard } from "./question-card";
import { ToolCard } from "./tool-card";

const SUGGESTIONS = [
  "What errors are in my logs today?",
  "Rename my Hue lights to match their rooms",
  "Which automations use the kitchen lights?",
  "Check my configuration for errors",
  "Write an automation: hallway light at sunset",
];

export function Thread({ onSuggestion }: { onSuggestion: (s: string) => void }) {
  const current = useStore((s) => (s.currentId ? s.details[s.currentId] : null));
  const loadingId = useStore((s) => (s.currentId && !s.details[s.currentId] ? s.currentId : null));

  if (!current) {
    return loadingId ? (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Spinner className="size-5" />
      </div>
    ) : (
      <EmptyState onSuggestion={onSuggestion} />
    );
  }

  return (
    <Conversation className="flex-1">
      <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 pt-4 pb-6">
        {current.messages.map((m, i) => (
          <MessageView key={m.id} message={m} previous={current.messages[i - 1]} />
        ))}
      </ConversationContent>
      <ConversationScrollButton aria-label="Scroll to latest message" className="bottom-3 shadow-md" />
    </Conversation>
  );
}

function EmptyState({ onSuggestion }: { onSuggestion: (s: string) => void }) {
  const user = useStore((s) => s.user);
  const provider = useStore((s) => s.provider);
  const first = user?.name?.split(" ")[0];
  return (
    // Scrolls instead of running under the composer when there is little height (phones in
    // landscape); the welcome text is dropped there so the suggestions stay visible.
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <ConversationEmptyState
        className="flex-1 [@media(max-height:480px)]:hidden"
        icon={<img src={APP_ICON} alt="" className="size-12" />}
        title={first ? `Hi ${first}` : "Twinmind"}
        description={`Ask ${PROVIDER_NAME[provider]} about your home. Switch assistants any time; the other one picks up the conversation.`}
      />
      {/* Same width as the composer below. */}
      <div className="mx-auto mt-auto w-full max-w-3xl px-3 pt-3 pb-2">
        <Suggestions>
          {SUGGESTIONS.map((s) => (
            <Suggestion key={s} suggestion={s} onClick={onSuggestion} />
          ))}
        </Suggestions>
      </div>
    </div>
  );
}

const MessageView = memo(function MessageView({ message: m, previous }: { message: ChatMessage; previous?: ChatMessage }) {
  if (m.role === "user") {
    const files = m.parts.filter((p) => p.type === "file");
    const texts = m.parts.filter((p) => p.type === "text");
    const switched = previous && previous.provider !== m.provider;
    return (
      <>
        {switched && <Handoff to={m.provider} />}
        <Message from="user">
          {files.length > 0 && (
            <div className="ml-auto flex flex-wrap justify-end gap-2">
              {files.map((f) => (f.type === "file" ? <FileChip key={f.id} part={f} /> : null))}
            </div>
          )}
          {texts.length > 0 && (
            <MessageContent>
              {texts.map((t) => (t.type === "text" ? <p key={t.id} className="whitespace-pre-wrap break-words">{t.text}</p> : null))}
            </MessageContent>
          )}
        </Message>
      </>
    );
  }
  const streaming = m.status === "streaming";
  const empty = m.parts.length === 0;
  return (
    <Message from="assistant" className="max-w-full">
      <div className="flex items-center gap-2">
        <Badge variant="secondary">
          <ModelSelectorLogo provider={PROVIDER_LOGO[m.provider]} />
          {PROVIDER_NAME[m.provider]}
          {m.model ? ` · ${m.model}` : ""}
        </Badge>
        {m.status === "interrupted" && <Badge variant="outline">stopped</Badge>}
      </div>
      <MessageContent className="w-full">
        {empty && streaming && <Shimmer className="text-sm">Thinking…</Shimmer>}
        {m.parts.map((p, i) => (
          <PartView key={p.id} part={p} provider={m.provider} streaming={streaming && i === m.parts.length - 1} />
        ))}
        {!streaming && m.parts.some((p) => p.type === "text") && (
          <MessageActions className="-ml-2 opacity-70 hover:opacity-100">
            <CopyAction text={m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n")} />
          </MessageActions>
        )}
      </MessageContent>
    </Message>
  );
});

function PartView({ part, provider, streaming }: { part: Part; provider: ProviderId; streaming: boolean }) {
  switch (part.type) {
    case "text":
      return (
        <MessageResponse className="prose-twinmind" isAnimating={streaming}>
          {part.text}
        </MessageResponse>
      );
    case "reasoning":
      return (
        <Reasoning isStreaming={streaming && !part.done} defaultOpen={false}>
          <ReasoningTrigger getThinkingMessage={thinkingMessage} />
          <ReasoningContent>{part.text}</ReasoningContent>
        </Reasoning>
      );
    case "tool":
      // AskUserQuestion is shown as a question card instead.
      if (part.name === "AskUserQuestion") return null;
      return <ToolCard part={part} provider={provider} />;
    case "question":
      return <QuestionCard part={part} />;
    case "todo": {
      const done = part.items.filter((i) => i.status === "completed").length;
      return (
        <Queue>
          <QueueSection>
            <QueueSectionTrigger>
              <QueueSectionLabel icon={<ListTodoIcon className="size-4" />} count={part.items.length} label="tasks" />
              <span className="text-xs">
                {done}/{part.items.length} done
              </span>
            </QueueSectionTrigger>
            <QueueSectionContent>
              <QueueList>
                {part.items.map((it, i) => (
                  <QueueItem key={i}>
                    <div className="flex items-center gap-2">
                      <QueueItemIndicator completed={it.status === "completed"} />
                      <QueueItemContent completed={it.status === "completed"}>{it.text}</QueueItemContent>
                    </div>
                    {it.status === "in_progress" && <QueueItemDescription>In progress</QueueItemDescription>}
                  </QueueItem>
                ))}
              </QueueList>
            </QueueSectionContent>
          </QueueSection>
        </Queue>
      );
    }
    case "notice":
      return (
        <Alert variant={part.level === "error" ? "destructive" : "default"}>
          {part.level === "info" ? <InfoIcon /> : <AlertTriangleIcon />}
          <AlertDescription className="break-words">{part.text}</AlertDescription>
        </Alert>
      );
    case "file":
      return <FileChip part={part} />;
  }
}

/** The upstream default reads "Thought for 1 seconds". */
function thinkingMessage(isStreaming: boolean, duration?: number) {
  if (isStreaming || duration === 0) return <Shimmer duration={1}>Thinking...</Shimmer>;
  if (duration === undefined) return <p>Thought for a few seconds</p>;
  return <p>Thought for {duration === 1 ? "1 second" : `${duration} seconds`}</p>;
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <MessageAction
      label="Copy answer"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => toast("Could not copy the answer."),
        );
      }}
    >
      {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
    </MessageAction>
  );
}


function FileChip({ part }: { part: Extract<Part, { type: "file" }> }) {
  const url = uploadUrl(part.uploadId);
  const isImage = part.mediaType.startsWith("image/");
  return (
    <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${part.name}`}>
      <Attachments variant={isImage ? "grid" : "inline"}>
        <Attachment data={{ id: part.id, type: "file", url, mediaType: part.mediaType, filename: part.name }} className={isImage ? "size-40" : undefined}>
          <AttachmentPreview />
          {!isImage && <AttachmentInfo />}
        </Attachment>
      </Attachments>
    </a>
  );
}

function Handoff({ to }: { to: ProviderId }) {
  return (
    <Checkpoint>
      <CheckpointIcon>
        <ArrowLeftRightIcon className="size-4 shrink-0" />
      </CheckpointIcon>
      <span className="shrink-0 text-xs">Handed over to {PROVIDER_NAME[to]}</span>
    </Checkpoint>
  );
}
