import { createContext, useContext } from "react";

/** What pages need from the app shell around them. */
export interface Shell {
  sidebarOpen: boolean;
  toggleSidebar(): void;
  /** Open the sidebar and scroll its list to one repository. */
  revealRepo(repo: string): void;
  /** Read the session list again, after a change that its rows show. */
  refreshSessions(): void;
}

export const ShellContext = createContext<Shell>({
  sidebarOpen: true,
  toggleSidebar: () => {},
  revealRepo: () => {},
  refreshSessions: () => {},
});

export function useShell(): Shell {
  return useContext(ShellContext);
}

export function repoGroupId(repo: string): string {
  return `repo-${repo.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}
