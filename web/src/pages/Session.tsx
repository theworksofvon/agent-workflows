import { ArrowLeft, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, needsAccountChoice } from "../api";
import { SessionAccountPicker } from "../components/AccountSwitcher";
import { isPopoverOpen } from "../components/Popover";
import { DiffTab } from "../components/DiffTab";
import { GuideTab } from "../components/GuideTab";
import { Header } from "../components/Header";
import { OverviewTab } from "../components/OverviewTab";
import { PublishDialog } from "../components/PublishDialog";
import { PartWarning, StatusBanner } from "../components/StatusBanner";
import { useToast } from "../components/Toast";
import {
  SessionTopBar,
  TopBarShell,
  type Progress,
} from "../components/TopBar";
import { withSkillHeader } from "../lib/discuss";
import { fileAnchor, findingAnchor, RERUN_CONFIRM } from "../lib/format";
import { isTextEntry, type KeyTarget } from "../lib/keys";
import { buildCrumbs, chapterIndexOf, type Crumb } from "../lib/orientation";
import {
  ReviewContext,
  type FocusTarget,
  type Jump,
  type ReviewActions,
} from "../lib/review-context";
import {
  navigate,
  parseRoute,
  sessionHref,
  TABS,
  type SessionTab,
} from "../lib/route";
import { useChecks } from "../lib/data";
import { useShell } from "../lib/shell";
import { repoName } from "../lib/sessions";
import { useCurrentFile } from "../lib/use-current-file";
import { useDiffSelection, useFocusReport, useLiveSession } from "../lib/live";
import type {
  ApiFinding,
  HumanComment,
  HumanState,
  SessionDetail,
} from "../types";

const POLL_MS = 2000;
/** The reading line for the current file: just under the 52px top bar. */
const READING_LINE = 64;
/** The height of the row that holds the back pill, in styles.css. */
const BACK_ROW = 36;
const FLASH_MS = 1500;

/** Where a jump from the overview started, so the reader can go back. */
interface Origin {
  label: string;
  scrollY: number;
}

export function Session({
  id,
  tab,
  chapter,
}: {
  id: string;
  tab: SessionTab;
  chapter: string | null;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [human, setHuman] = useState<HumanState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const [accountPrompt, setAccountPrompt] = useState<string | null>(null);
  const restoreScroll = useRef<number | null>(null);
  const toast = useToast();
  const shell = useShell();
  const { refreshSessions } = shell;
  const checks = useChecks(id);

  const load = useCallback(async () => {
    try {
      const d = await api.getSession(id);
      setDetail(d);
      setHuman(d.human);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);
  useLiveSession(id, load);

  const status = detail?.session.status;
  const running =
    status !== undefined && status !== "ready" && status !== "failed";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, load]);

  const session = detail?.session ?? null;
  const files = useMemo(() => session?.pr?.files ?? [], [session?.pr]);
  const guide = session?.guide.value ?? null;
  const chapters = useMemo(() => guide?.chapters ?? [], [guide]);
  const findings = useMemo(() => detail?.findings ?? [], [detail?.findings]);

  const chapterIndex = chapterIndexOf(chapters, chapter);
  const currentChapter = chapters[chapterIndex];
  const showsGuide = tab === "guide" && chapters.length > 0;

  // Writes go to the page first, then the server's answer replaces them.
  const mutate = useCallback(
    async (
      optimistic: ((h: HumanState) => HumanState) | null,
      call: () => Promise<HumanState>,
    ): Promise<boolean> => {
      if (optimistic) setHuman((h) => (h ? optimistic(h) : h));
      try {
        setHuman(await call());
        return true;
      } catch (err) {
        toast((err as Error).message, "error");
        void load();
        return false;
      }
    },
    [toast, load],
  );

  const setChapterReviewed = useCallback(
    (chapterId: string, reviewed: boolean) =>
      void mutate(
        (h) => ({ ...h, chapters: { ...h.chapters, [chapterId]: reviewed } }),
        () => api.setChapterReviewed(id, chapterId, reviewed),
      ).then((ok) => ok && refreshSessions()),
    [id, mutate, refreshSessions],
  );

  const actions = useMemo<ReviewActions | null>(() => {
    if (!human) return null;
    const findingsByPath = groupByPath(findings);
    const commentsByPath = groupByPath(human.comments);
    return {
      focus,
      clearFocus: () => setFocus(null),
      findingsFor: (path) => findingsByPath.get(path) ?? EMPTY_FINDINGS,
      commentsFor: (path) => commentsByPath.get(path) ?? EMPTY_COMMENTS,
      verdictFor: (findingId) => human.verdicts[findingId],
      isViewed: (path) => human.files[path] === true,
      setViewed: (path, viewed) =>
        void mutate(
          (h) => ({ ...h, files: { ...h.files, [path]: viewed } }),
          () => api.setFileViewed(id, path, viewed),
        ),
      setVerdict: (findingId, verdict, note) =>
        void mutate(
          (h) => {
            const verdicts = { ...h.verdicts };
            if (verdict === null) delete verdicts[findingId];
            else
              verdicts[findingId] = {
                verdict,
                note,
                updatedAt: new Date().toISOString(),
              };
            return { ...h, verdicts };
          },
          () => api.setVerdict(id, findingId, verdict, note),
        ),
      addComment: (path, line, body) =>
        mutate(null, () => api.addComment(id, path, line, body)),
      deleteComment: (commentId) =>
        void mutate(
          (h) => ({
            ...h,
            comments: h.comments.filter((c) => c.id !== commentId),
          }),
          () => api.deleteComment(id, commentId),
        ),
    };
  }, [human, findings, id, mutate, focus]);

  const goChapter = useCallback(
    (index: number) => {
      const target = chapters[index];
      if (target) navigate(sessionHref(id, "guide", target.id));
    },
    [chapters, id],
  );

  const jump = useCallback<Jump>((label, href, target) => {
    setOrigin({ label, scrollY: window.scrollY });
    setFocus(target ?? null);
    navigate(href);
  }, []);

  function goBack() {
    restoreScroll.current = origin?.scrollY ?? 0;
    navigate(sessionHref(id, "overview"));
  }

  // On a new chapter or tab, start at the top, or where the reader left the
  // overview when they come back to it.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (tab === "overview") setOrigin(null);
    const y = tab === "overview" ? restoreScroll.current : null;
    restoreScroll.current = null;
    if (y === null) window.scrollTo({ top: 0 });
    else requestAnimationFrame(() => window.scrollTo({ top: y }));
  }, [tab, currentChapter?.id]);

  // After a jump to a finding, wait for its card to render, then bring it
  // into view and highlight it.
  useEffect(() => {
    if (!focus || tab === "overview") return;
    let frames = 0;
    let raf = 0;
    let timer: number | undefined;
    const find = () => {
      if ("lines" in focus) {
        const file = document.getElementById(fileAnchor(focus.path));
        const line = file?.querySelector(".dl.is-ref");
        if (line) line.scrollIntoView({ block: "center" });
        else if (frames++ < 120) raf = requestAnimationFrame(find);
        else file?.scrollIntoView({ block: "start" });
        return;
      }
      const el = document.getElementById(findingAnchor(focus.findingId));
      if (el) {
        el.scrollIntoView({ block: "center" });
        el.classList.add("is-flash");
        timer = window.setTimeout(() => {
          el.classList.remove("is-flash");
          setFocus(null);
        }, FLASH_MS);
      } else if (frames++ < 120) {
        raf = requestAnimationFrame(find);
      }
    };
    raf = requestAnimationFrame(find);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [focus, tab]);

  const visiblePaths = useMemo(() => {
    if (tab === "overview") return [];
    if (showsGuide && currentChapter) {
      const known = new Set(files.map((f) => f.path));
      return currentChapter.files.filter((p) => known.has(p));
    }
    return files.map((f) => f.path);
  }, [tab, showsGuide, currentChapter, files]);
  const showsBack = origin !== null && tab !== "overview";
  const currentFile = useCurrentFile(
    visiblePaths,
    READING_LINE + (showsBack ? BACK_ROW : 0),
  );

  const selection = useDiffSelection();
  const lastFinding = useRef<string | null>(null);
  if (focus && "findingId" in focus) lastFinding.current = focus.findingId;
  const refLines = focus && "lines" in focus ? focus : null;
  useFocusReport(
    id,
    session?.status === "ready"
      ? {
          tab,
          chapter: tab === "guide" ? (currentChapter?.id ?? null) : null,
          finding: lastFinding.current,
          path: selection?.path ?? refLines?.path ?? currentFile,
          lines: selection?.lines ?? refLines?.lines ?? null,
        }
      : null,
  );

  const reviewedCount = chapters.filter((c) => human?.chapters[c.id]).length;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        isTextEntry(e.target as KeyTarget | null)
      )
        return;
      if (publishing || isPopoverOpen() || session?.status !== "ready") return;
      const number = Number(e.key);
      if (number >= 1 && number <= TABS.length) {
        const next = TABS[number - 1]!;
        navigate(
          sessionHref(id, next, next === "guide" ? currentChapter?.id : null),
        );
        return;
      }
      if (!chapters.length) return;
      if (e.key === "j" || e.key === "k") {
        // Read the hash, not props: a fast second key press arrives before
        // React renders the first navigation.
        const route = parseRoute(window.location.hash);
        const onGuide = route.page === "session" && route.tab === "guide";
        const from = chapterIndexOf(
          chapters,
          route.page === "session" ? route.chapter : null,
        );
        const step = e.key === "j" ? 1 : -1;
        goChapter(
          onGuide
            ? Math.min(chapters.length - 1, Math.max(0, from + step))
            : from,
        );
      } else if (e.key === "r" && tab === "guide" && currentChapter && human) {
        setChapterReviewed(
          currentChapter.id,
          human.chapters[currentChapter.id] !== true,
        );
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    id,
    tab,
    chapters,
    chapterIndex,
    currentChapter,
    human,
    publishing,
    session?.status,
    goChapter,
    setChapterReviewed,
  ]);

  async function discuss() {
    try {
      const prompt = await api.discussPrompt(id);
      await copyText(withSkillHeader(window.location.origin, id, prompt));
      toast("Prompt copied. Paste it into a new T3 thread.");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function rerun() {
    if (!window.confirm(RERUN_CONFIRM)) return;
    await startRerun();
  }

  async function startRerun() {
    try {
      navigate(sessionHref(await api.rerun(id)));
    } catch (err) {
      if (needsAccountChoice(err)) setAccountPrompt((err as Error).message);
      else toast((err as Error).message, "error");
    }
  }

  if (loadError && !detail) {
    return (
      <>
        <TopBarShell>
          <span className="crumb crumb-current">Review</span>
        </TopBarShell>
        <main className="page">
          <div className="banner banner-error">{loadError}</div>
        </main>
      </>
    );
  }
  if (!session || !human || !actions) {
    return (
      <>
        <TopBarShell>
          <span className="crumb crumb-current muted">Loading…</span>
        </TopBarShell>
        <main className="page" />
      </>
    );
  }

  const progress: Progress = {
    chapters: { done: reviewedCount, total: chapters.length },
    files: {
      done: files.filter((f) => human.files[f.path]).length,
      total: files.length,
    },
  };
  const ready = session.status === "ready";
  const crumbs = buildCrumbs({
    owner: session.repo.owner,
    repo: session.repo.repo,
    prNumber: session.prNumber,
    tab: ready ? tab : "overview",
    chapter:
      showsGuide && currentChapter
        ? { index: chapterIndex, title: currentChapter.title }
        : null,
    file: currentFile,
  });

  function onCrumb(crumb: Crumb) {
    switch (crumb.kind) {
      case "repo":
        shell.revealRepo(repoName(session!));
        return;
      case "pr":
        if (tab === "overview") window.scrollTo({ top: 0, behavior: "smooth" });
        else navigate(sessionHref(id, "overview"));
        return;
      case "tab":
      case "chapter":
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      case "file":
        if (currentFile)
          document
            .getElementById(fileAnchor(currentFile))
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  return (
    <ReviewContext.Provider value={actions}>
      <SessionTopBar
        session={session}
        crumbs={crumbs}
        onCrumb={onCrumb}
        tab={tab}
        chapterId={currentChapter?.id ?? null}
        progress={progress}
        onDiscuss={() => void discuss()}
        onPublish={() => setPublishing(true)}
        onRerun={() => void rerun()}
        below={
          showsBack ? (
            <div className="back-row">
              <div className="back-pill" role="navigation" aria-label="Back">
                <button type="button" className="back-pill-go" onClick={goBack}>
                  <ArrowLeft size={13} />
                  Back to Overview
                  <span className="back-pill-label">· {origin.label}</span>
                </button>
                <button
                  type="button"
                  className="back-pill-close"
                  aria-label="Dismiss"
                  onClick={() => setOrigin(null)}
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          ) : undefined
        }
      />
      <main className={`page session page-${ready ? tab : "status"}`}>
        <Header session={session} checks={checks} compact={ready && tab !== "overview"} />
        {accountPrompt && (
          <div className="banner banner-warn">
            <div className="banner-body">
              {accountPrompt}
              <SessionAccountPicker
                sessionId={id}
                onChosen={() => {
                  setAccountPrompt(null);
                  void load();
                  void startRerun();
                }}
              />
            </div>
          </div>
        )}
        <StatusBanner session={session} onRerun={() => void rerun()} />
        {running && (
          <p className="muted small running-note">
            The overview, guide, and agent findings appear here when the run
            finishes. This page updates by itself.
          </p>
        )}
        {ready && (
          <>
            {session.review.error && tab !== "guide" && (
              <PartWarning
                title="The agent review failed. Only the guide is available."
                error={session.review.error}
              />
            )}
            {tab === "overview" && (
              <OverviewTab
                session={session}
                guide={guide}
                findings={findings}
                human={human}
                onJump={jump}
              />
            )}
            {tab === "guide" &&
              (guide && chapters.length > 0 ? (
                <GuideTab
                  chapters={chapters}
                  index={chapterIndex}
                  files={files}
                  human={human}
                  onReviewed={setChapterReviewed}
                  onSelect={goChapter}
                />
              ) : (
                <>
                  <PartWarning
                    title="No guide for this run — showing the diff only."
                    error={
                      session.guide.error ??
                      "The triage decided this pull request does not need a guide."
                    }
                  />
                  <DiffTab files={files} />
                </>
              ))}
            {tab === "diff" && <DiffTab files={files} />}
          </>
        )}
        {publishing && (
          <PublishDialog
            sessionId={id}
            prUrl={session.pr?.url ?? null}
            publishedAt={session.publishedAt}
            onPublished={(at) =>
              setDetail((d) =>
                d ? { ...d, session: { ...d.session, publishedAt: at } } : d,
              )
            }
            onAccountChosen={() => void load()}
            onClose={() => setPublishing(false)}
          />
        )}
      </main>
    </ReviewContext.Provider>
  );
}

const EMPTY_FINDINGS: ApiFinding[] = [];
const EMPTY_COMMENTS: HumanComment[] = [];

function groupByPath<T extends { path: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const list = map.get(item.path);
    if (list) list.push(item);
    else map.set(item.path, [item]);
  }
  return map;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}
