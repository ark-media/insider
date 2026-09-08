# Privacy policy edits — ready-to-paste copy

**Status:** drafted 2026-07-23, alongside BI plan P0.
**Applies to:** <https://arkmedia.org/privacy-policy/> (last updated 2025-07-29).
**Not legal advice.** These close the four gaps identified in
[`bi-analytics-plan.md` §8](./bi-analytics-plan.md). Three are corrections to
generated boilerplate that is inaccurate about this business; one discloses
something the site already does.

These live outside this repo — the policy is a WordPress page on arkmedia.org,
so this file is the copy to paste, not a code change. **Gap 3 is the one to do
first:** it is the only item that currently asserts something untrue *and*
creates a legal obligation the site does not meet.

---

## Gap 1 — Disclose session replay

PostHog session recording is live (`src/lib/observability.ts`) and the policy
does not mention recording, replay, or heatmaps. Non-disclosure is the
aggravating factor in the CIPA §631/632 "wiretapping" suits currently being
brought over session replay, so this sentence is close to free insurance.

**Add to the "Usage Data" or "Tracking Technologies and Cookies" section:**

> **Session recording.** We use a product-analytics service (PostHog) to record
> how visitors move through our website — pages viewed, clicks, scrolling, and
> similar interactions — so we can find and fix usability problems. These
> recordings are configured to mask all on-screen text and all information typed
> into form fields, so the recording does not capture what you read or what you
> type. Payment details are entered in a secure frame hosted by Stripe and are
> never visible to the recording. Recordings are retained by PostHog on our
> behalf and are not sold or shared with advertisers.

**Keep the masking defaults on.** `mask_all_text: true` and `maskAllInputs: true`
are what make the paragraph above true. Un-masking any field with
`data-ph-mask="false"` should be a deliberate, reviewed decision — it changes
what this disclosure has to say.

---

## Gap 2 — Name the processors that actually handle user data

The policy names two vendors (Google Analytics, Stripe). The stack processes
user data through roughly a dozen. The generic "Service Providers" clause is
thin cover, and this is the disclosure most easily checked against reality.

**Replace the vendor list in "Service Providers" with:**

> We share personal information with the following categories of service
> providers, who process it only on our instructions and only to provide their
> service to us:
>
> - **Payments and billing** — Stripe (payment processing), Supporting Cast
>   (private podcast feed subscriptions)
> - **Accounts and sign-in** — Auth0 by Okta
> - **Email** — Beehiiv (newsletters), Resend (transactional email such as
>   sign-in links and receipts)
> - **The Fold** — Circle (the Fold, our members' app)
> - **Podcast hosting and delivery** — Simplecast
> - **Analytics and product measurement** — PostHog (product analytics and
>   session recording), Vercel (web analytics and performance)
> - **Error monitoring** — Sentry
> - **Hosting and infrastructure** — Vercel, Neon (database)

Note this list drops Google Analytics, which the current policy names — confirm
whether it is still deployed on arkmedia.org before publishing. Naming a vendor
that is not in use is the same category of error as omitting one that is.

---

## Gap 3 — Correct the "we sell personal information" claim (do this first)

The policy currently states, verbatim, that we *may "sell"* Categories A, B, D
and F. This is the TermsFeed generator's default text and is very probably not
true of the business — nothing in this codebase sells or shares personal
information for advertising purposes.

It matters because asserting it triggers obligations: under CCPA/CPRA a business
that sells or shares must post a **"Do Not Sell or Share My Personal
Information"** link and honor opt-outs. Today the only mechanism offered is an
email address, so the policy describes a practice we do not have *and* commits
us to a control we do not provide.

**Delete the "sale of personal information" paragraph and its category list, and
replace with:**

> **We do not sell or share your personal information.** We do not sell personal
> information as that term is defined by the California Consumer Privacy Act, and
> we do not share it for cross-context behavioral advertising. We have not done
> so in the preceding twelve months. We use analytics providers to understand how
> our own website and products are used; those providers act as our service
> providers and are not permitted to use the information for their own purposes.

### Forward-looking caveat — read before adding ad pixels

CPRA defines *"sharing"* to include cross-context behavioral advertising.
Everything shipped in P0 is first-party and stays clear of that line: attribution
is captured in the visitor's own browser and forwarded only to our own server and
to Stripe.

But the moment a **Meta or Google Ads conversion pixel** goes on the checkout page
— a natural next step once attribution starts showing which channels convert —
the statement above becomes false, and the opt-out link plus GPC handling become
mandatory. That is a decision to make *before* the pixel ships, not after. It is
open question #6 in the BI plan.

---

## Gap 4 — Global Privacy Control

The policy says the service does not respond to Do Not Track signals. Ignoring
DNT is fine and standard. **GPC is a different signal and is legally binding** in
California, Colorado, and Connecticut — and the policy does not mention it.

Fixing Gap 3 largely resolves this: GPC is an opt-out of sale/sharing, and there
is nothing to opt out of if we do not sell or share. Add one sentence so the
position is stated rather than inferred.

**Add after the Do Not Track paragraph:**

> **Global Privacy Control.** Some browsers and extensions send a Global Privacy
> Control (GPC) signal, which is treated in some states as a request to opt out
> of the sale or sharing of personal information. Because we do not sell or share
> personal information, there is no such processing for a GPC signal to opt out
> of. If that ever changes, we will honor GPC signals and will update this policy
> before doing so.

---

## One note on the hashing design

`email_sha256` is good practice and is now the universal join key across the
browser, the Stripe webhook, and every planned third-party ingest. **It should
not be described internally or externally as *anonymization*.** A hashed email is
pseudonymous: it is still an identifier under CCPA and still personal
information, because it is deterministic and can be matched back the moment
anyone holds the address. It reduces blast radius; it does not take the data out
of scope. Describe it as "hashed" or "pseudonymized", never "anonymous".

---

## Adjacent, for counsel — not part of this work

Surfaced while reading the same two documents; flagged, not actioned.

- **The ToS is scoped to one podcast.** It describes Ark Media Podcast LLC as the
  producer of *Inside Call Me Back* and covers subscriptions and recurring
  billing, but says nothing about user-generated content, community conduct, or
  moderation. Circle launches a UGC surface the current terms do not contemplate.
- **No arbitration clause or class-action waiver** in a consumer subscription
  business with auto-renewing billing.
- **Auto-renewal disclosure.** California's Automatic Renewal Law and the FTC's
  negative-option rule impose specific disclosure and cancellation-path
  requirements. The cancel flow is already built and instrumented (flows A–E), so
  this is likely a copy question rather than an engineering one.
