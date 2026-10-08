import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sidebar, type RevealRequest } from "./components/Sidebar";
import { T3SignInNotice } from "./components/T3Dialog";
import { ToastProvider } from "./components/Toast";
import { DataContext, useAppData } from "./lib/data";
import { parseRoute } from "./lib/route";
import { pullKey } from "./lib/sessions";
import { ShellContext, type Shell } from "./lib/shell";
import { readStorage, useTheme, writeStorage } from "./lib/theme";
import { Home } from "./pages/Home";
import { PullPreview } from "./pages/PullPreview";
import { Session } from "./pages/Session";

const SIDEBAR_KEY = "guided-review:sidebar";
const NARROW_QUERY = "(max-width: 900px)";

export function App() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const [theme, setTheme] = useTheme();
  const sidebar = useSidebar();
  const searchRef = useRef<HTMLInputElement>(null);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const { open: sidebarOpen, setOpen: setSidebarOpen } = sidebar;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSidebarOpen(true);
        // The input mounts with the sidebar; focus once it is on screen.
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSidebarOpen]);

  const activeId = route.page === "session" ? route.id : null;
  const data = useAppData(activeId);
  const { refreshSessions } = data;

  const shell = useMemo<Shell>(
    () => ({
      sidebarOpen,
      toggleSidebar: () => setSidebarOpen(!sidebarOpen),
      revealRepo: (repo) => {
        setSidebarOpen(true);
        setReveal({ repo });
      },
      refreshSessions,
    }),
    [sidebarOpen, setSidebarOpen, refreshSessions],
  );

  const activeSession =
    activeId === null ? null : data.sessions?.find((s) => s.id === activeId);
  const activePull =
    route.page === "pull"
      ? pullKey({
          repo: { owner: route.owner, repo: route.repo },
          number: route.number,
        })
      : activeSession
        ? pullKey(activeSession)
        : null;

  return (
    <ShellContext.Provider value={shell}>
      <DataContext.Provider value={data}>
      <ToastProvider>
        <T3SignInNotice />
        <div
          className={`shell ${sidebarOpen ? "has-sidebar" : ""} ${sidebar.narrow ? "is-narrow" : ""}`}
        >
          {sidebarOpen && (
            <Sidebar
              activePull={activePull}
              theme={theme}
              onTheme={setTheme}
              searchRef={searchRef}
              reveal={reveal}
              onRevealed={() => setReveal(null)}
              onNavigate={() => sidebar.narrow && setSidebarOpen(false)}
            />
          )}
          {sidebarOpen && sidebar.narrow && (
            <div
              className="sidebar-scrim"
              aria-hidden
              onClick={() => setSidebarOpen(false)}
            />
          )}
          <div className="main">
            {route.page === "home" ? (
              <Home />
            ) : route.page === "pull" ? (
              <PullPreview
                key={`${route.owner}/${route.repo}#${route.number}`}
                owner={route.owner}
                repo={route.repo}
                number={route.number}
              />
            ) : (
              <Session
                key={route.id}
                id={route.id}
                tab={route.tab}
                chapter={route.chapter}
              />
            )}
          </div>
        </div>
      </ToastProvider>
      </DataContext.Provider>
    </ShellContext.Provider>
  );
}

/**
 * Sidebar visibility. On a wide window the choice persists; below 900px the
 * sidebar starts closed and opens over the page.
 */
function useSidebar() {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia(NARROW_QUERY).matches,
  );
  const [wideOpen, setWideOpen] = useState(
    () => readStorage(SIDEBAR_KEY) !== "closed",
  );
  const [narrowOpen, setNarrowOpen] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    const onChange = () => {
      setNarrow(media.matches);
      setNarrowOpen(false);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const setOpen = useCallback(
    (open: boolean) => {
      if (narrow) {
        setNarrowOpen(open);
        return;
      }
      writeStorage(SIDEBAR_KEY, open ? "open" : "closed");
      setWideOpen(open);
    },
    [narrow],
  );

  return { narrow, open: narrow ? narrowOpen : wideOpen, setOpen };
}
