import { Trash2 } from "lucide-react";
import { relativeTime } from "../lib/format";
import { Markdown } from "../lib/markdown";
import type { HumanComment } from "../types";

export function HumanCommentCard({
  comment,
  onDelete,
  showLocation = false,
}: {
  comment: HumanComment;
  onDelete: () => void;
  showLocation?: boolean;
}) {
  return (
    <div className="annot human">
      <div className="annot-head">
        <span className="who who-human">You</span>
        {showLocation && (
          <span className="mono muted small">
            {comment.path}:{comment.line}
          </span>
        )}
        <span className="muted small">{relativeTime(comment.createdAt)}</span>
        <span className="spacer" />
        <button type="button" className="link-btn danger" onClick={onDelete}>
          <Trash2 size={12} />
          Delete
        </button>
      </div>
      <div className="annot-body prose">
        <Markdown text={comment.body} />
      </div>
    </div>
  );
}
