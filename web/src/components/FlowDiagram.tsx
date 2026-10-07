import { useState } from "react";
import type { FocusTarget, Jump } from "../lib/review-context";
import { sessionHref } from "../lib/route";
import { jumpOnClick } from "./OverviewTab";
import type { Flow, FlowNode } from "../types";

/** A chapter as a flow step names it: its number and title. */
export interface ChapterLabel {
  number: number;
  title: string;
}

const CHANGE_MARK: Record<FlowNode["change"], string> = {
  added: "+",
  removed: "−",
  changed: "~",
  unchanged: "",
};

export function FlowDiagram({
  flow,
  sessionId,
  chapters,
  chapterOf,
  onJump,
}: {
  flow: Flow;
  sessionId: string;
  chapters: Map<string, ChapterLabel>;
  /** The chapter that holds each changed file. */
  chapterOf: Map<string, string>;
  onJump: Jump;
}) {
  const [side, setSide] = useState<"before" | "after">("after");
  const nodes = flow[side];
  const added = flow.after.filter((n) => n.change === "added").length;
  const label = flow.title || "Before / after";

  return (
    <div className="flow card">
      <div className="flow-head">
        <div className="flow-title">{label}</div>
        <span className="spacer" />
        {added > 0 && (
          <span className="add flow-count" title="Steps that this PR adds">
            +{added}
          </span>
        )}
        <div className="segmented" role="group" aria-label="Show before or after">
          {(["before", "after"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={side === s ? "is-on" : ""}
              aria-pressed={side === s}
              onClick={() => setSide(s)}
            >
              {s === "before" ? "Before" : "After"}
            </button>
          ))}
        </div>
      </div>
      {flow.caption && <div className="flow-caption">{flow.caption}</div>}
      <ol className="flow-chain">
        {nodes.length === 0 && <li className="muted small">No steps.</li>}
        {nodes.map((node, i) => (
          <li key={`${side}-${i}`} className={`flow-step flow-${node.change}`}>
            <span className="flow-dot" aria-hidden>
              {CHANGE_MARK[node.change]}
            </span>
            <FlowStep
              node={node}
              sessionId={sessionId}
              chapters={chapters}
              chapterOf={chapterOf}
              onClick={(focus) => jumpOnClick(onJump, label, focus)}
            />
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * A step opens the code it names: its chapter with the step's lines
 * highlighted, or the diff when no chapter holds the file. A step with
 * neither a location nor a chapter is plain text.
 */
function FlowStep({
  node,
  sessionId,
  chapters,
  chapterOf,
  onClick,
}: {
  node: FlowNode;
  sessionId: string;
  chapters: Map<string, ChapterLabel>;
  chapterOf: Map<string, string>;
  onClick: (focus?: FocusTarget) => ReturnType<typeof jumpOnClick>;
}) {
  const ref = node.ref ?? null;
  const chapterId = node.chapter ?? (ref ? chapterOf.get(ref.path) : undefined);
  const chapter = chapterId ? chapters.get(chapterId) : undefined;
  const lines = ref
    ? ref.end > ref.start
      ? `${ref.start}–${ref.end}`
      : `${ref.start}`
    : "";
  const where = ref
    ? `${ref.path.split("/").pop()}:${lines}`
    : chapter
      ? `Ch ${chapter.number}`
      : null;
  const tip = [
    chapter && `Chapter ${chapter.number}: ${chapter.title}`,
    ref && `${ref.path}, line${ref.end > ref.start ? "s" : ""} ${lines}`,
  ]
    .filter(Boolean)
    .join("\n");
  const content = (
    <>
      <span className="flow-label">{node.label}</span>
      {where && <span className="flow-where">{where}</span>}
    </>
  );
  if (!chapterId && !ref) return <span className="flow-node">{content}</span>;
  return (
    <a
      className="flow-node is-link"
      href={
        chapterId
          ? sessionHref(sessionId, "guide", chapterId)
          : sessionHref(sessionId, "diff")
      }
      title={`Open the code\n${tip}`}
      onClick={onClick(
        ref
          ? { path: ref.path, lines: { start: ref.start, end: ref.end } }
          : undefined,
      )}
    >
      {content}
    </a>
  );
}
