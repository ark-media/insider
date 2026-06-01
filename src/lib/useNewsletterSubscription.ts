import { useEffect, useState } from "react";
import {
  fetchNewsletterPrefs,
  type NewsletterPrefs,
} from "./newsletterPrefs";
import { useSubscriberAuth } from "./subscriberAuth";

export function useNewsletterSubscription() {
  const { state } = useSubscriberAuth();
  const [prefs, setPrefs] = useState<NewsletterPrefs | null | undefined>(
    undefined,
  );
  const [prefsError, setPrefsError] = useState(false);

  const email = state.kind === "member" ? state.me.email : "";

  useEffect(() => {
    if (state.kind !== "member") return;
    let live = true;
    // Reset to the loading state when the account/email changes before refetch;
    // this is a deliberate sync reset, not a cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPrefs(undefined);
    setPrefsError(false);
    void fetchNewsletterPrefs()
      .then((result) => {
        if (!live) return;
        if (result.ok) {
          setPrefs(result.prefs);
          return;
        }
        setPrefs(null);
        setPrefsError(true);
      })
      .catch(() => {
        if (!live) return;
        setPrefs(null);
        setPrefsError(true);
      });
    return () => {
      live = false;
    };
  }, [state.kind, email]);

  const isMember = state.kind === "member";
  const isSubscriber = isMember && state.me.tier === "subscriber";
  const prefsLoading = isMember && prefs === undefined && !prefsError;

  const isSubscribedToFree =
    isMember && prefs !== undefined && prefs !== null && prefs.free;
  const isSubscribedToPremium =
    isMember && prefs !== undefined && prefs !== null && prefs.premium;

  // Hide subscribe UI for Ark+ members (entitlement, not Beehiiv prefs) and for
  // logged-in readers on the free newsletter list.
  const isSubscribed = isSubscriber || isSubscribedToFree;

  return {
    isSubscribed,
    isSubscribedToFree,
    isSubscribedToPremium,
    prefsLoading,
    prefsError,
    isMember,
    isSubscriber,
    prefs: isMember ? (prefs ?? null) : null,
  };
}
