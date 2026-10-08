import type { PullRequestFile } from "../types";
import { FileDiff } from "./FileDiff";

export function DiffTab({ files }: { files: PullRequestFile[] }) {
  return (
    <div className="diff-tab">
      {files.map((f) => (
        <FileDiff key={f.path} file={f} />
      ))}
    </div>
  );
}
