import {
  Question,
  QuestionActions,
  QuestionDescription,
  QuestionInput,
  QuestionOption,
  QuestionOptions,
  QuestionPrompt,
  QuestionSubmit,
  type QuestionResponse,
} from "@/components/ai-elements/question";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import type { QuestionPart } from "@/lib/protocol";
import { answerQuestion } from "@/lib/store";
import { useState } from "react";

/** Questions from the assistant, one AI Elements Question at a time. */
export function QuestionCard({ part }: { part: QuestionPart }) {
  const [step, setStep] = useState(0);
  const [collected, setCollected] = useState<Record<string, string[]>>({});

  if (part.state !== "pending") {
    return (
      <ItemGroup className="gap-2">
        {part.state === "dismissed" && <p className="text-muted-foreground text-sm">Question dismissed.</p>}
        {part.state === "answered" &&
          part.questions.map((q) => (
            <Item key={q.id} variant="outline" size="sm">
              <ItemContent>
                <ItemDescription>{q.question}</ItemDescription>
                <ItemTitle>{(part.answers?.[q.id] ?? []).join(", ") || "—"}</ItemTitle>
              </ItemContent>
            </Item>
          ))}
      </ItemGroup>
    );
  }

  const q = part.questions[step];
  if (!q) return null;
  const last = step === part.questions.length - 1;

  const submit = (r: QuestionResponse) => {
    const values = [...r.selectedValues, ...(r.text ? [r.text] : [])];
    const next = { ...collected, [q.id]: values };
    setCollected(next);
    if (last) answerQuestion(part.id, next);
    else setStep(step + 1);
  };

  return (
    <Question key={q.id} onSubmit={submit} selectionMode={q.multiSelect ? "multiple" : "single"}>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          {q.header && <Badge variant="secondary">{q.header}</Badge>}
          {part.questions.length > 1 && (
            <span className="text-muted-foreground text-xs">
              {step + 1} of {part.questions.length}
            </span>
          )}
        </div>
        <QuestionPrompt>{q.question}</QuestionPrompt>
        {q.multiSelect && <QuestionDescription>Choose all that apply.</QuestionDescription>}
      </div>
      {q.options.length > 0 && (
        <QuestionOptions aria-label={q.header || q.question}>
          {q.options.map((o) => (
            <QuestionOption key={o.label} value={o.label} title={o.description}>
              {o.label}
            </QuestionOption>
          ))}
        </QuestionOptions>
      )}
      {(q.allowOther || q.options.length === 0) && (
        <QuestionInput aria-label="Your answer" placeholder={q.options.length ? "Or type your own answer…" : "Type your answer…"} />
      )}
      <QuestionActions>
        <Button type="button" variant="ghost" onClick={() => answerQuestion(part.id, null)}>
          Skip
        </Button>
        <QuestionSubmit>{last ? "Answer" : "Next"}</QuestionSubmit>
      </QuestionActions>
    </Question>
  );
}
