import { useState } from "react";
import { pad2 } from "../lib/format";
import type { Jump } from "../lib/review-context";
import { sessionHref } from "../lib/route";
import { jumpOnClick } from "./OverviewTab";
import type { Flow, FlowNode } from "../types";

const CHANGE_MARK: Record<FlowNode["change"], string> = {
  added: "+",
  removed: "−",
  changed: "~",
  unchanged: "",
};

export function FlowDiagram({
  flow,
  sessionId,
  chapterNumbers,
  onJump,
}: {
  flow: Flow;
  sessionId: string;
  chapterNumbers: Map<string, number>;
  onJump: Jump;
}) {
  const [side, setSide] = useState<"before" | "after">("after");
  const nodes = flow[side];
  const added = flow.after.filter((n) => n.change === "added").length;

  return (
    <div className="flow card">
      <div className="flow-head">
        <div className="flow-title">{flow.title || "Before / after"}</div>
        <span className="spacer" />
        {added > 0 && <span className="add flow-count">+{added}</span>}
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
        {nodes.map((node, i) => {
          const number = node.chapter ? chapterNumbers.get(node.chapter) : undefined;
          return (
            <li key={`${side}-${i}`} className={`flow-step flow-${node.change}`}>
              <span className="flow-dot" aria-hidden>
                {CHANGE_MARK[node.change]}
              </span>
              <span className="flow-node">
                <span className="flow-label">{node.label}</span>
              </span>
              {number !== undefined && node.chapter ? (
                <a
                  className="flow-chapter"
                  href={sessionHref(sessionId, "guide", node.chapter)}
                  title="Open this chapter"
                  onClick={jumpOnClick(onJump, flow.title || "Before / after")}
                >
                  {pad2(number)}
                </a>
              ) : (
                <span />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
