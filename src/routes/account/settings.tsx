import { createFileRoute } from "@tanstack/react-router";
import { useSubscriberAuth } from "../../lib/subscriberAuth";
import { EmailPreferences } from "../../components/account/EmailPreferences";
import { ProfileNameCard } from "../../components/account/ProfileNameCard";

export const Route = createFileRoute("/account/settings")({
  component: SettingsTab,
});

// The Settings tab: the two things a member comes here to change that aren't
// their membership — what we email them, and who we think they are.
//
// This replaces /account/newsletters, which was a page of its own for a single
// toggle.
function SettingsTab() {
  const { state, refresh } = useSubscriberAuth();
  if (state.kind !== "member") return null;
  const { me } = state;

  return (
    <section>
      <div className="page-section max-w-3xl">
        <h2 className="text-h2">Settings</h2>

        <div className="mt-10">
          <EmailPreferences email={me.email} />
        </div>

        <div className="mt-12">
          <h3 className="label text-cyan">Profile &amp; sign-in</h3>
          <div className="mt-4 divide-y divide-rule border border-rule bg-navy-800/40">
            <ProfileNameCard onSaved={refresh} rowClassName="p-6" />

            {/* Read-only on purpose. The address is the Auth0 identity, the
                Stripe customer, and the Beehiiv subscriber all at once, so
                changing it here would silently mean changing it in three
                systems — support does it deliberately instead. */}
            <div className="p-6">
              <div className="eyebrow text-fg-muted">Email</div>
              <p className="mt-2 text-body text-fg-strong">{me.email}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

