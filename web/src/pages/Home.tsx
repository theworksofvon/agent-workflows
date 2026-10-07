import { GitPullRequest } from "lucide-react";
import { NewReview } from "../components/NewReview";
import { TopBarShell } from "../components/TopBar";

/** The main area when no session is open. */
export function Home() {
  return (
    <>
      <TopBarShell>
        <span className="crumb crumb-current">Guided review</span>
      </TopBarShell>
      <main className="empty-state">
        <div className="empty-card">
          <div className="empty-icon" aria-hidden>
            <GitPullRequest size={18} />
          </div>
          <h1>Start a guided review</h1>
          <p className="muted">
            Paste a pull request or browse a repository. The agents triage it,
            split it into chapters, and flag findings. You confirm what gets
            published. Open past reviews from the sidebar.
          </p>
          <NewReview />
          <p className="muted small empty-keys">
            <kbd>⌘</kbd> <kbd>K</kbd> search reviews · <kbd>1</kbd> <kbd>2</kbd>{" "}
            <kbd>3</kbd> tabs · <kbd>j</kbd> <kbd>k</kbd> chapters ·{" "}
            <kbd>r</kbd> mark reviewed
          </p>
        </div>
      </main>
    </>
  );
}
