import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminShell } from "../../components/AdminShell";
import {
  createDiscussThread,
  deleteDiscussThread,
  listBeehiivDrafts,
  listDiscussThreads,
  type BeehiivDraft,
  type DiscussThread,
} from "../../lib/admin";
import {
  newsletters,
  type NewsletterSlug,
} from "../../data/newsletters";
import {
  adminField,
  adminFieldLabel,
  adminPrimaryButton,
} from "../../lib/admin-styles";
import { errMessage } from "../../lib/errMessage";

export const Route = createFileRoute("/admin/discuss-threads")({
  component: DiscussThreadsAdmin,
});

const DEFAULT_NEWSLETTER: NewsletterSlug = "members-letter";

type FlashKind = "success" | "warn" | "error";
type Flash = { kind: FlashKind; message: string };

function DiscussThreadsAdmin() {
  const [threads, setThreads] = useState<DiscussThread[]>([]);
  const [drafts, setDrafts] = useState<BeehiivDraft[]>([]);
  const [selectedNewsletter, setSelectedNewsletter] =
    useState<NewsletterSlug>(DEFAULT_NEWSLETTER);
  const [selectedDraftId, setSelectedDraftId] = useState<string>("");
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  // Map of Beehiiv post id → existing thread, so the dropdown can mark drafts
  // that already have a thread minted and the submit button can short-circuit
  // to "already exists" rather than re-running the orchestration.
  const threadByPostId = useMemo(
    () => new Map(threads.map((t) => [t.beehiivPostId, t])),
    [threads],
  );

  // Fetch and apply, guarded so a response arriving after unmount is dropped.
  // State moves only in the settled callbacks, never synchronously.
  const loadThreadsInto = useCallback(
    (isLive: () => boolean) =>
      listDiscussThreads().then(
        (next) => {
          if (!isLive()) return;
          setThreads(next);
          setListError(null);
          setLoadingThreads(false);
        },
        (err: unknown) => {
          if (!isLive()) return;
          setListError(errMessage(err, "Failed to load threads."));
          setLoadingThreads(false);
        },
      ),
    [],
  );

  const refreshThreads = useCallback(async () => {
    setLoadingThreads(true);
    await loadThreadsInto(() => true);
  }, [loadThreadsInto]);

  useEffect(() => {
    let live = true;
    void loadThreadsInto(() => live);
    return () => {
      live = false;
    };
  }, [loadThreadsInto]);

  // Derived: drafts are "loading" until a response for the currently selected
  // newsletter lands, so switching newsletters shows the spinner immediately
  // without the effect setting state synchronously.
  const [loadedDraftsFor, setLoadedDraftsFor] = useState<NewsletterSlug | null>(
    null,
  );
  const loadingDrafts = loadedDraftsFor !== selectedNewsletter;

  useEffect(() => {
    let live = true;
    listBeehiivDrafts(selectedNewsletter).then(
      (next) => {
        if (!live) return;
        setDrafts(next);
        setSelectedDraftId((curr) => {
          if (curr && next.some((d) => d.id === curr)) return curr;
          return next[0]?.id ?? "";
        });
        setLoadedDraftsFor(selectedNewsletter);
      },
      (err: unknown) => {
        if (!live) return;
        setFlash({
          kind: "error",
          message: errMessage(err, "Failed to load Beehiiv drafts."),
        });
        setLoadedDraftsFor(selectedNewsletter);
      },
    );
    return () => {
      live = false;
    };
  }, [selectedNewsletter]);

  const selectedDraft = useMemo(
    () => drafts.find((d) => d.id === selectedDraftId) ?? null,
    [drafts, selectedDraftId],
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDraft) return;
    setSubmitting(true);
    setFlash(null);
    try {
      const { thread, alreadyExisted } = await createDiscussThread({
        newsletterSlug: selectedNewsletter,
        beehiivPostId: selectedDraft.id,
        beehiivPostTitle: selectedDraft.title,
      });
      const note = alreadyExisted
        ? "This post already had a companion thread — showing the existing one."
        : thread.beehiivBodyPatched
          ? "Circle thread created and Beehiiv draft updated with the link."
          : "Circle thread created. Beehiiv didn't accept the body update — copy the URL into the draft by hand before publishing.";
      setFlash({
        kind: thread.beehiivBodyPatched || alreadyExisted ? "success" : "warn",
        message: note,
      });
      await refreshThreads();
    } catch (err) {
      setFlash({
        kind: "error",
        message: errMessage(err, "Failed to create thread."),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (t: DiscussThread) => {
    if (
      !confirm(
        "Delete this mapping row? The Circle thread and Beehiiv post are left alone — only the link on the article page goes away.",
      )
    )
      return;
    try {
      await deleteDiscussThread(t.id);
      await refreshThreads();
    } catch (err) {
      setListError(errMessage(err, "Failed to delete."));
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setFlash({ kind: "success", message: "Copied to clipboard." });
    } catch {
      setFlash({ kind: "error", message: "Copy failed — select the URL manually." });
    }
  };

  const field = adminField;
  const labelClass = adminFieldLabel;

  return (
    <AdminShell active="discuss-threads" title="Discuss threads">
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
        <section aria-label="Create discussion thread">
          <h2 className="font-display text-lg text-fg-strong">
            Create discussion thread
          </h2>
          <p className="mt-2 text-body-sm">
            Pick a Beehiiv draft and we&rsquo;ll mint a Circle thread in the matching
            community space, then patch the draft body with a &ldquo;Discuss on
            forum&rdquo; link. The article&rsquo;s &ldquo;Discuss on forum &rarr;&rdquo;
            button on the site picks it up automatically once the post is published.
          </p>

          <form onSubmit={submit} className="mt-6 space-y-5">
            <div>
              <label htmlFor="dt-newsletter" className={labelClass}>
                Newsletter
              </label>
              <select
                id="dt-newsletter"
                value={selectedNewsletter}
                onChange={(e) =>
                  setSelectedNewsletter(e.target.value as NewsletterSlug)
                }
                className={`mt-2 ${field}`}
              >
                {newsletters.map((n) => (
                  <option key={n.slug} value={n.slug}>
                    {n.title}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="dt-draft" className={labelClass}>
                Beehiiv draft
              </label>
              <select
                id="dt-draft"
                value={selectedDraftId}
                onChange={(e) => setSelectedDraftId(e.target.value)}
                disabled={loadingDrafts || drafts.length === 0}
                className={`mt-2 ${field}`}
              >
                {drafts.length === 0 ? (
                  <option value="">
                    {loadingDrafts ? "Loading…" : "No drafts found"}
                  </option>
                ) : (
                  drafts.map((d) => {
                    const exists = threadByPostId.has(d.id);
                    return (
                      <option key={d.id} value={d.id}>
                        {d.title}
                        {d.audience !== "unknown" ? ` · ${d.audience}` : ""}
                        {exists ? " · thread exists" : ""}
                      </option>
                    );
                  })
                )}
              </select>
              <p className="mt-1 text-body-sm">
                Only Beehiiv drafts are listed — confirmed posts can&rsquo;t reliably
                have their body updated, so create the thread before publishing.
              </p>
            </div>

            {flash ? (
              <p
                className={`text-body-sm ${
                  flash.kind === "success"
                    ? "text-cyan"
                    : flash.kind === "warn"
                      ? "text-amber-300"
                      : "text-red-400"
                }`}
              >
                {flash.message}
              </p>
            ) : null}

            <div>
              <button
                type="submit"
                disabled={submitting || !selectedDraft}
                className={adminPrimaryButton}
              >
                {submitting ? "Creating…" : "Create companion thread"}
              </button>
            </div>
          </form>
        </section>

        <section aria-label="Existing discussion threads">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg text-fg-strong">All threads</h2>
          </div>

          {loadingThreads ? (
            <p className="mt-6 text-body-sm">Loading…</p>
          ) : listError ? (
            <p className="mt-6 text-body-sm text-red-400">{listError}</p>
          ) : threads.length === 0 ? (
            <p className="mt-6 text-body-sm">
              No threads yet. Create one with the form.
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {threads.map((t) => (
                <li key={t.id} className="border border-rule p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-center border border-rule-strong px-2 py-0.5 label font-bold text-fg-muted">
                      {t.newsletterSlug}
                    </span>
                    <span className="flex gap-3 button-text font-bold">
                      <button
                        type="button"
                        onClick={() => void copy(t.circleThreadUrl)}
                        className="text-fg-strong hover:text-cyan"
                      >
                        Copy URL
                      </button>
                      <a
                        href={t.circleThreadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-fg-strong hover:text-cyan"
                      >
                        Open
                      </a>
                      <button
                        type="button"
                        onClick={() => void remove(t)}
                        className="text-red-400 hover:text-red-300"
                      >
                        Delete
                      </button>
                    </span>
                  </div>

                  <div className="mt-3 text-body text-fg-strong">
                    {t.beehiivPostTitle}
                  </div>
                  <div className="mt-1 truncate text-body-sm">
                    {t.circleThreadUrl}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-body-sm">
                    <span>Created {new Date(t.createdAt).toLocaleString()}</span>
                    {t.beehiivBodyPatched ? (
                      <span className="text-cyan">Beehiiv body patched</span>
                    ) : (
                      <span className="text-amber-300">
                        Beehiiv body NOT patched — copy URL manually
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AdminShell>
  );
}
