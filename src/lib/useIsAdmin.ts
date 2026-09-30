import { useEffect, useState } from "react";
import { fetchAdminMe } from "./admin";

// Whether the signed-in member holds the admin role. UX only — every admin
// endpoint re-verifies the role server-side.
//
// The answer is kept with the email it was asked for, and `loading` is derived
// from that rather than set in the effect: a member whose check hasn't come
// back is loading from their very first render (no frame of "not an admin"),
// and one member's answer never carries over to the next account signed in on
// the same tab.
export function useIsAdmin(memberEmail: string | null): {
  loading: boolean;
  isAdmin: boolean;
} {
  const [check, setCheck] = useState<{ email: string; isAdmin: boolean } | null>(
    null,
  );

  useEffect(() => {
    if (!memberEmail) return;
    let cancelled = false;
    void fetchAdminMe().then((result) => {
      if (!cancelled) setCheck({ email: memberEmail, isAdmin: result.isAdmin });
    });
    return () => {
      cancelled = true;
    };
  }, [memberEmail]);

  const loading = memberEmail !== null && check?.email !== memberEmail;
  return { loading, isAdmin: !loading && check?.isAdmin === true };
}
