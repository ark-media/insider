-- 0001_initial_schema.sql
-- The canonical launch schema. Migrations 0001–0025 collapsed into one file.
--
-- PRE-LAUNCH SQUASH. The old sequence carried its own history — a soft-launch
-- flag added and dropped (0004/0005), the Supporting Cast mirror built and then
-- torn out when we moved to Beehiiv (0006/0009/0023/0024), gift expiry going
-- single-column and then per-axis (0010/0015), three full FAQ reseeds
-- (0014/0018/0022). None of that survives in the live shape, so none of it is
-- reproduced here: this file creates exactly the 17 tables the application
-- reads and writes today, with exactly the columns and indexes it uses.
--
-- Deliberately breaks "don't edit an applied migration" (migrations/README.md)
-- because we are pre-launch with no production data to preserve — prod holds
-- only the seed rows below. Adopting it on an already-migrated database means
-- baselining `_migrations` to this one file; see the README.
--
-- The file is re-runnable: every object is `if not exists`, and both seeds are
-- idempotent (careers on its slug, FAQs by wipe-and-reseed).
--
-- Reproducible seed data at the bottom: 2 careers, 32 FAQs.


-- ===========================================================================
-- Membership and entitlement
-- ===========================================================================

-- Neon is the single entitlement authority (tasks/entitlement-tiers.md §3):
-- the Stripe webhook writes here and every server-side gate reads a resolver
-- over it. SC / Circle / Auth0 are not entitlement authorities.
--
-- Keyed on the Auth0 `sub` (opaque user_id), never email — this table stores no
-- PII. Addresses live in the third parties that need them (Stripe, Auth0,
-- Circle, Beehiiv, Resend). On read the session's `sub` keys the row; on write,
-- checkout stamps `sub` onto the Stripe customer's metadata so the webhook
-- reads it back off the event.
--
-- Invariant: the persisted `auth0_sub` is always the post-merge PRIMARY user_id.
-- The post-login account-linking Action must resolve before any membership read
-- or write, so a secondary social identity can never mint a second row.
--
-- Entitlements ({ arkPlus, circle }) are DERIVED from `tier` plus the live gift
-- axes via server/entitlement.ts — never stored, so there is one source and no
-- drift. Absence of a row = free; no free rows are ever written.

create table if not exists membership (
  auth0_sub                text primary key,  -- Auth0 user_id (post-merge primary); opaque, no PII
  stripe_customer_id       text,              -- NULL for redeemed gifts / comp / staff (no Stripe customer)
  stripe_subscription_id   text,              -- NULL for gifts (a gift is a one-time PaymentIntent)
  tier                     text not null,     -- ark-plus | circle | bundle | free
  status                   text not null,     -- Stripe subscription status, or 'active' for redeemed gifts.
                                              --   Dunning keys on this.
  plan                     text,              -- monthly | yearly
  amount_cents             integer,
  current_period_end       timestamptz,
  cancel_at                timestamptz,

  -- Pending period-end change (the tier-switch flow). A downgrade / PWYC-
  -- lowering is a Stripe subscription schedule; these columns let the app
  -- represent "on Bundle now, dropping to Ark+ at period end" so it can display
  -- and safely mutate that state. `scheduled_tier` is what the account page
  -- reads back; the other three are the mirror of the schedule itself.
  scheduled_tier           text,
  schedule_id              text,
  pending_amount_cents     integer,
  pending_plan             text,

  updated_at               timestamptz not null default now(),

  -- Per-axis gift expiries: a gift extends only the axis/axes it covers, so an
  -- Ark+ gift and a Fold gift can run concurrently with independent end dates.
  -- The reconciler must not downgrade an axis before its date passes.
  ark_plus_gift_expires_at timestamptz,
  circle_gift_expires_at   timestamptz
);

-- The webhook and the account page both address rows by Stripe customer, before
-- (or without) an Auth0 sub in hand.
create index if not exists membership_customer_idx on membership (stripe_customer_id);

-- Gifts. A gift grants nothing until redeemed, so it needs no membership row —
-- and no recipient identity — at purchase time. Keyed on an opaque redemption
-- token that travels in the link, never on a person.
--
-- At purchase: the giver pays a one-time PaymentIntent; one row is written
-- (status = 'pending'). At redemption (no deadline — redeemable anytime): the
-- recipient signs in, we verify the token is still pending, then either write a
-- membership row with the matching axis expiry or apply the amount as Stripe
-- account credit. Either way the gift flips to 'redeemed'. An unredeemed gift
-- is a standing deferred-revenue liability (a deliberate product call).

create table if not exists gift (
  redemption_token text primary key,  -- opaque; travels in the link
  tier             text not null,     -- ark-plus | circle | bundle
  plan             text,              -- monthly | yearly, or a raw duration
  amount_cents     integer,
  giver_sub        text,              -- opaque Auth0 sub of the giver; audit / refunds
  status           text not null,     -- pending | redeemed | void ('void' = refunded or
                                      --   disputed before anyone claimed it)
  redeemed_by      text,              -- recipient's Auth0 sub, set at redemption
  created_at       timestamptz not null default now(),
  currency         text               -- lowercase ISO of the charge; amount_cents is
                                      --   denominated in it. Absent → treat as 'usd'.
);

-- Ledger of gift-expiry reminder emails, so the cron never nags the same
-- recipient twice for the same term. Keying on the term-end means a re-gift that
-- pushes an axis's expiry out is a NEW term and becomes eligible for a fresh
-- reminder, while a single term is only ever reminded once. `axis` is
-- 'ark_plus' | 'circle'. Membership stores no PII, so the recipient's email is
-- resolved from Auth0 at send time and never persisted here.

create table if not exists gift_expiry_reminder_sends (
  auth0_sub  text        not null,
  axis       text        not null,
  expires_at timestamptz not null,
  sent_at    timestamptz not null default now(),
  primary key (auth0_sub, axis, expires_at)
);


-- ===========================================================================
-- Beehiiv mirrors
-- ===========================================================================

-- Mirrors a reader's Beehiiv subscription state so the account pages render
-- current preferences without hitting Beehiiv on every load, and so the webhook
-- (subscription.deleted / .upgraded / .downgraded) has a place to land. One row
-- per email — we run a single shared publication, so a reader has at most one
-- subscription record across both newsletters; `has_premium` distinguishes which
-- tier of issues they get, and is also the reconciler's arkPlus roster.
--
-- `premium_since` stamps the has_premium false → true transition and is then
-- left alone (so it keeps meaning "when they started paying", not "when we last
-- synced"); it is cleared on a downgrade so a re-subscribe re-stamps. It is the
-- reminder crons' join clock: membership is keyed on the Auth0 sub and holds no
-- email so it cannot address a reminder, and `created_at` here is the free-
-- signup date, which would put a long-time free reader who upgrades outside the
-- reminder window forever.

create table if not exists beehiiv_subscription (
  email                   text        primary key,
  publication_id          text        not null,
  beehiiv_subscription_id text        not null,
  status                  text        not null,
  has_premium             boolean     not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  premium_since           timestamptz
);

-- Which private feeds a member has actually activated, so the setup hub can show
-- a real "3 of 6 shows set up" count and the reminder cron knows who to nudge.
--
-- Keyed by (email, show_id), NOT by the feed token: Beehiiv's private feed id
-- (`pod_feed_<uuid>`) ROTATES whenever the feed is reissued, so keying on it
-- would silently reset a member's "set up" state the first time that happened.
-- The show id is stable. Email is stored already-normalized (lowercased/trimmed)
-- by the writer so read paths can join on the session email without a functional
-- index.
--
-- `pending_at` is the optimistic marker: set the moment a member takes a setup
-- action (opens a deep link, copies the feed URL, texts themselves the link,
-- links Spotify), because the authoritative webhook can lag by minutes. The
-- setup hub treats a feed as done if it is confirmed (`activated`) OR pending,
-- while the reminder cron keys on `activated` only — so a member who clicked but
-- never actually activated still gets nudged. Access revocation flips `activated`
-- back to false rather than deleting, so we keep the history (and don't re-nudge
-- someone who deliberately lapsed).

create table if not exists beehiiv_feed_activations (
  email        text        not null,
  show_id      text        not null,
  activated    boolean     not null default true,
  activated_at timestamptz,
  revoked_at   timestamptz,
  pending_at   timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (email, show_id)
);

-- Hot read path is "all activations for this email" (/api/me, reminder cron).
-- The primary key's leading column already serves it; keep an explicit index in
-- case that column order ever changes.
create index if not exists beehiiv_feed_activations_email_idx
  on beehiiv_feed_activations (email);


-- ===========================================================================
-- Webhook idempotency ledgers
-- ===========================================================================

-- Stripe guarantees at-least-once delivery, so the same event.id can arrive more
-- than once (network retries, our own 5xx retries). Replaying an event would
-- re-run its side effects — the Beehiiv downgrade, the entitlement flip to free,
-- the gift welcome email — none of which are individually replay-safe. The
-- handler claims each event.id here before dispatch and skips any it has already
-- processed. A claim is released (deleted) if dispatch fails so Stripe's retry
-- can reprocess; it is kept once dispatch succeeds.
--
-- Rows are pruned after a retention window by /api/cron/prune-webhook-events.

create table if not exists stripe_webhook_events (
  id          text        primary key,
  type        text        not null,
  received_at timestamptz not null default now()
);

-- Same ledger for Beehiiv deliveries, with the opposite ordering: we READ this
-- before the handler and WRITE it after the handler succeeds, never before.
-- Claiming the id up front would mean a handler that throws leaves the id
-- recorded, so Beehiiv's retry gets deduped and the event is lost (a dropped
-- access_revoked would keep a lapsed member "activated").

create table if not exists beehiiv_webhook_events (
  id          text        primary key,
  type        text        not null,
  received_at timestamptz not null default now()
);


-- ===========================================================================
-- Cancellation, win-back, and feed-setup reminders
-- ===========================================================================

-- Why a member cancels or debundles (or that they accepted a retention offer
-- instead). One row per terminal outcome of the cancel flow:
--   offer_outcome='not_offered' → no retention offer shown; member cancelled.
--   offer_outcome='declined'    → offer shown, declined; member cancelled.
--   offer_outcome='accepted'    → offer shown and accepted; no cancel. reasons
--                                 is empty (we didn't ask), coupon_id is set.
--
-- `reasons` is multi-select: aggregation unnests it so a response counts toward
-- each reason it names, and filtering uses `<slug> = any(reasons)`.
--
-- Doubles as the win-back campaign's roster, which is why `canceled_tier` (what
-- they left) and `retained_product` (full-exit | kept-circle | kept-ark-plus)
-- live here. Both are null on accept rows — a stay, not a cancel. This record
-- persists whether or not the membership row is later torn down on
-- subscription.deleted, so campaigns can target by email + what/why/what-was-
-- kept without any access being implied. Keyed by email to match the rest of the
-- app (a member can map to several Stripe customers but is one email) and to
-- join beehiiv_subscription, which independently retains marketing consent.

create table if not exists cancellation_survey (
  id               bigint      generated always as identity primary key,
  email            text        not null,
  note             text,
  offer_outcome    text        not null,  -- 'accepted' | 'declined' | 'not_offered'
  coupon_id        text,                  -- set when accepted
  created_at       timestamptz not null default now(),
  canceled_tier    text,                  -- ark-plus | circle | bundle
  retained_product text,                  -- full-exit | kept-circle | kept-ark-plus
  reasons          text[]      not null default '{}'
);

create index if not exists cancellation_survey_email_idx
  on cancellation_survey (email);
create index if not exists cancellation_survey_outcome_idx
  on cancellation_survey (offer_outcome);

-- Retention eligibility is once per rolling 12 months for promotional coupons
-- (plan switches are never rate-limited). The window check lives in code
-- (server/lib/cancellation.ts hasAcceptedRetention) and reads created_at; this
-- partial index keeps that lookback a cheap index scan.
create index if not exists cancellation_survey_accept_recent_idx
  on cancellation_survey (email, created_at desc)
  where offer_outcome = 'accepted';

-- Win-back bookkeeping. The roster comes from cancellation_survey above; nothing
-- new needs recording about the cancellation itself, only about the mail.
--
--   winback_sends       one row per (email, cohort), so a nightly cron that
--                       re-selects the same person never mails them twice.
--                       `cohort` names the campaign ('ark_plus_180d'), leaving
--                       room for a second horizon without a schema change.
--   winback_suppression an opt-out. This is the one email we send to someone who
--                       is no longer a customer, so it carries a real
--                       unsubscribe link; that link writes here, and the cron
--                       excludes anyone listed regardless of cohort.
--
-- Both keyed on email rather than auth0_sub on purpose: a member who cancelled
-- may have no membership row and no Auth0 account left.

create table if not exists winback_sends (
  email   text        not null,
  cohort  text        not null,
  sent_at timestamptz not null default now(),
  primary key (email, cohort)
);

create table if not exists winback_suppression (
  email      text        primary key,
  created_at timestamptz not null default now()
);

-- Ledger of feed-setup reminder emails, so the reminder crons never nag the same
-- member twice. One row per (email, reminder_no); reminder_no lets a second-touch
-- reminder, and the separate migration check-in campaign's stages, share this
-- table without a schema change. Email is stored already-normalized to match
-- beehiiv_feed_activations.
--
-- done_count / total_count snapshot the member's setup progress at send time —
-- enough to audit "did the nudge move anyone" without a separate events log.

create table if not exists feed_reminder_sends (
  email       text        not null,
  reminder_no integer     not null default 1,
  done_count  integer     not null,
  total_count integer     not null,
  sent_at     timestamptz not null default now(),
  primary key (email, reminder_no)
);


-- ===========================================================================
-- Back-office content
-- ===========================================================================

-- Site-wide banner bar managed from the back office. The public site reads the
-- single enabled row whose window contains now(); if windows overlap, the most
-- recently started one wins.

create table if not exists announcements (
  id          uuid        primary key default gen_random_uuid(),
  body        text        not null,
  action_url  text,
  bar_color   text        not null,
  text_color  text        not null,
  dismissible boolean     not null default true,
  enabled     boolean     not null default true,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Admin-managed job postings. One row per open position with a short summary
-- (shown on the /careers list) and a long HTML description (shown on
-- /careers/<slug>). `apply_url` is the external application link — for Ark this
-- is the per-role TestGorilla assessment. The public site reads only enabled
-- rows, ordered by display_order.

create table if not exists careers (
  id              uuid        primary key default gen_random_uuid(),
  slug            text        not null unique,
  title           text        not null,
  team            text,
  location        text,
  employment_type text,
  summary         text        not null,
  description     text        not null,
  apply_url       text,
  enabled         boolean     not null default true,
  display_order   integer     not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Public listing reads enabled rows in display order; index that access path.
create index if not exists careers_enabled_order_idx
  on careers (enabled, display_order, created_at);

-- Admin-managed frequently-asked questions, shown on /plus and /pricing and
-- searched by the help widget. One row per question with a sanitized-HTML answer.
-- `category` is a plain-text section heading (empty string means ungrouped);
-- display_order is a global 1..N sequence and the component derives section order
-- from first appearance in it.
--
-- `key` is a stable short slug that code binds to (src/data/supportTopics.ts
-- routes help-widget topics at specific answers). It exists because nothing else
-- can carry that reference: `id` is regenerated by every content reseed,
-- display_order shifts on insert, and question text gets reworded. Nullable, so
-- an admin can add an FAQ without inventing one; unique (Postgres allows many
-- NULLs under a unique index) so two rows can't claim the same binding. The
-- index name is load-bearing — server/lib/faqs.ts matches on it to turn a 23505
-- into a friendly duplicate-key error rather than a generic 500.

create table if not exists faqs (
  id            uuid        primary key default gen_random_uuid(),
  question      text        not null,
  answer        text        not null,
  enabled       boolean     not null default true,
  display_order integer     not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  category      text        not null default '',
  key           text
);

-- Public listing reads enabled rows in display order; index that access path.
create index if not exists faqs_enabled_order_idx
  on faqs (enabled, display_order, created_at);

create unique index if not exists faqs_key_idx on faqs (key);

-- Maps a Beehiiv newsletter post to the companion discussion thread we opened
-- for it in Circle. The Fold highlights feed subtracts `circle_post_id` from the
-- space it reads so a companion thread doesn't show up as community content;
-- `beehiiv_body_patched` records whether we managed to append the "discuss this"
-- link to the post body.

create table if not exists discuss_threads (
  id                   uuid        primary key default gen_random_uuid(),
  newsletter_slug      text        not null,
  beehiiv_post_id      text        not null unique,
  beehiiv_post_title   text        not null,
  circle_thread_url    text        not null,
  circle_space_id      integer     not null,
  circle_post_id       text        not null,
  beehiiv_body_patched boolean     not null default false,
  created_at           timestamptz not null default now()
);

create index if not exists discuss_threads_newsletter_slug_idx
  on discuss_threads (newsletter_slug);


-- ===========================================================================
-- Help widget
-- ===========================================================================

-- One row per help-widget session, so the team can see what members actually ask
-- and which questions the FAQ corpus fails to answer. The widget is a
-- deterministic search over `faqs` plus a curated routing table; it has no way of
-- knowing when it was unhelpful. This log is that feedback loop — the valuable
-- view isn't the transcript, it's the set of queries that returned nothing, which
-- is the backlog for /admin/faqs.
--
-- `steps` is an ordered JSONB array of {at, kind, value} where kind is one of
-- topic | query | no_results | faq_opened | link | escalate. JSONB rather than a
-- child table because a session is always read whole, never queried across rows
-- by step, and the shape will move as the widget's states do.
--
-- `email` is derived server-side from the session cookie and is null for guests —
-- never taken from the request body. Tier is deliberately absent: the request
-- identity doesn't carry it, and resolving it would put a membership lookup on a
-- hot public endpoint.
--
-- Retention: rows are pruned by /api/cron/prune-webhook-events. Free-text queries
-- can carry personal details, so this must not accumulate indefinitely.

create table if not exists support_conversations (
  id         uuid        primary key default gen_random_uuid(),
  session_id text        not null unique,
  email      text,
  steps      jsonb       not null default '[]'::jsonb,
  escalated  boolean     not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The admin review page reads the most recent sessions; the prune job deletes the
-- oldest. Both are served by an index on created_at.
create index if not exists support_conversations_recent_idx
  on support_conversations (created_at desc);


-- ===========================================================================
-- Runtime settings
-- ===========================================================================

-- Generic key/value table for global runtime config the back office edits and the
-- crons read. Today: `feed_reminder_config` and `feed_migration_config`, each one
-- JSON blob rather than a column-per-field so future settings reuse the table.
-- No seed row — absence means "fall back to env, then code defaults."

create table if not exists app_settings (
  key        text        primary key,
  value      text        not null,
  updated_at timestamptz not null default now()
);


-- ===========================================================================
-- Seed data
-- ===========================================================================

-- The two live positions from arkmedia.org/careers. Dollar-quoted bodies so the
-- HTML's apostrophes don't need escaping. Idempotent on slug.
insert into careers (slug, title, team, location, employment_type, summary, apply_url, display_order, description)
values
  (
    'history-host',
    'History Podcast Co-Host',
    'Content',
    'Remote (US)',
    'Contract',
    'Co-host an upcoming Jewish history show alongside a lead historian — bring curiosity, storytelling, and a love of human-centered narrative.',
    'https://app.testgorilla.com/s/n7y6e4s3',
    1,
    $desc$
<h2>About Ark Media</h2>
<p>Ark Media is a podcast network centered on exploring significant questions affecting Jewish life and Israel's future. We produce original programming featuring conversations with prominent thought leaders, and we aim to cultivate a globally connected community grounded in curiosity and substantive dialogue.</p>
<h2>About the Role</h2>
<p>We're seeking a co-host for a supporting position on an upcoming Jewish history program. The ideal candidate has intellectual curiosity, a passion for storytelling, and a strong interest in history. Working alongside a history expert, the co-host will help examine diverse periods, events, and figures from across the broad spectrum of Jewish history.</p>
<h2>Key Responsibilities</h2>
<ul>
<li>Record and deliver engaging weekly episode performances.</li>
<li>Study research materials and episode frameworks created by the lead host and producer.</li>
<li>Contribute a unique perspective and line of inquiry to deepen storytelling and advance narrative development.</li>
<li>Collaborate with the lead host and producer on editorial strategy and long-term show direction.</li>
</ul>
<h2>Required Qualifications</h2>
<ul>
<li>A compelling and genuine on-air communication style.</li>
<li>The capacity to examine Jewish history beyond conventional or narrow ideological frameworks.</li>
<li>Authentic enthusiasm for human-centered narratives and topic exploration.</li>
<li>A collaborative approach when working with the primary host.</li>
<li>Research proficiency and rapid subject-matter mastery.</li>
<li>An entrepreneurial mindset, with comfort navigating uncertainty and building from early stages.</li>
</ul>
<h2>Preferred Qualifications</h2>
<ul>
<li>Background in podcasting, YouTube, social media, broadcasting, or streaming.</li>
<li>Understanding of sophisticated narrative approaches beyond mainstream interpretations.</li>
<li>A deep personal commitment to history or Jewish cultural identity.</li>
</ul>
    $desc$
  ),
  (
    'senior-producer',
    'Senior Producer',
    'Content',
    'Remote (US)',
    'Full-time',
    'Lead editorial and production across our podcast portfolio, develop new shows, and build the systems and team to scale them.',
    'https://app.testgorilla.com/s/6ox08cx9',
    2,
    $desc$
<h2>About Ark Media</h2>
<p>Ark Media is a podcast network focused on examining significant questions affecting Jewish communities, Israel's trajectory, and global developments. We combine original programming with conversations featuring influential leaders and analysts.</p>
<h2>Role Overview</h2>
<p>This senior position combines editorial leadership, hands-on production work, new-show development, team management, and data-driven optimization. The role requires overseeing multiple shows while building scalable systems and mentoring staff. Compensation is $110,000–$140,000 annually, based on location and experience. The schedule is non-traditional and includes Sunday hours. Remote within the United States (other countries considered); Eastern Time availability is required. Reports to the CEO.</p>
<h2>Key Responsibilities</h2>
<h3>Content Leadership</h3>
<ul>
<li>Oversee quality and performance across the podcast portfolio.</li>
<li>Make critical editorial decisions regarding show content.</li>
<li>Apply performance metrics to refine shows and audience-engagement strategies.</li>
</ul>
<h3>Production Management</h3>
<ul>
<li>Direct end-to-end production workflows across all programs.</li>
<li>Establish standards and timelines for consistency.</li>
<li>Contribute directly to scripting, editing, fact-checking, and directing.</li>
</ul>
<h3>Analytics &amp; Strategy</h3>
<ul>
<li>Monitor downloads, retention, video metrics, and subscriber trends.</li>
<li>Transform performance data into actionable editorial improvements.</li>
<li>Identify growth patterns and format-optimization opportunities.</li>
</ul>
<h3>Team Development</h3>
<ul>
<li>Manage and mentor producers, production managers, and technical staff.</li>
<li>Provide constructive feedback supporting both work quality and professional growth.</li>
<li>Assist with hiring and onboarding processes.</li>
</ul>
<h3>New Show Development</h3>
<ul>
<li>Conceptualize and develop original programming from inception through launch.</li>
<li>Recruit hosts and contributors.</li>
<li>Test formats and iterate rapidly.</li>
</ul>
<h3>Systems Building</h3>
<ul>
<li>Create efficient production and development infrastructure.</li>
<li>Establish clear processes, roles, and responsibilities.</li>
<li>Manage calendar coordination and workflow execution.</li>
</ul>
<h2>Success Metrics</h2>
<ul>
<li>Portfolio operates independently without CEO micromanagement.</li>
<li>Launch of one new program positioned for expansion.</li>
<li>A functional production system with defined workflows and team accountability.</li>
<li>Consistent, timely outputs meeting editorial standards.</li>
</ul>
<h2>Required Qualifications</h2>
<ul>
<li>Five to eight years in podcasting or audio production, preferably journalism-related.</li>
<li>Demonstrated success producing high-quality audio content.</li>
<li>Background in news, geopolitics, or current affairs.</li>
<li>Team-management experience handling concurrent projects.</li>
<li>A track record launching new shows or formats.</li>
<li>Proficient audio and video editing capabilities.</li>
<li>Understanding of podcast analytics and platform performance metrics.</li>
</ul>
<h2>Ideal Candidate Profile</h2>
<p>Candidates should combine storytelling expertise with operational strength. They work comfortably in fast-paced environments, handle multiple priorities, and demonstrate strong editorial judgment. They bring detail-oriented thinking, a commitment to accuracy, and genuine interest in Jewish affairs and international matters.</p>
<p>The application requires a resume, three work samples, and roughly 10–15 minutes to complete supplementary questions.</p>
    $desc$
  )
on conflict (slug) do nothing;

-- The FAQ corpus (five sections, 32 questions), from the Ark+ FAQ doc.
-- `delete from faqs` keeps the reseed idempotent on a re-run; on a fresh
-- database it is a no-op. Keys are assigned in a second pass, matched on question
-- text, so a reworded question fails loudly (null key) rather than silently
-- acquiring the wrong binding — src/lib/support/search.fixtures.ts parses both
-- blocks out of this file and the widget's test suite asserts every key a topic
-- references resolves.
--
-- Dollar-quoted literals so apostrophes and dollar amounts don't need escaping.

delete from faqs;

insert into faqs (display_order, category, question, answer)
values
  -- Section 1 — I am already subscribed to Inside Call Me Back
  (
    1,
    $C$I am already subscribed to Inside Call Me Back. What does this mean for me?$C$,
    $Q$Do I need to subscribe again?$Q$,
    $A$<p>No. If you already had an active Inside Call Me Back subscription, your subscription has automatically become an Ark+ subscription. You do not need to subscribe again to continue receiving your podcast benefits. If you'd like access to The Fold App, you can upgrade to the Bundle at any time.</p>$A$
  ),
  (
    2,
    $C$I am already subscribed to Inside Call Me Back. What does this mean for me?$C$,
    $Q$What happened to Inside Call Me Back?$Q$,
    $A$<p>You are not losing Inside Call Me Back. The weekly series is continuing under a new name, Call Me Back AMA, and will remain available in the Call Me Back subscriber feed as part of your Ark+ subscription.</p>$A$
  ),

  -- Section 2 — Choosing a Subscription
  (
    3,
    $C$Choosing a Subscription$C$,
    $Q$What subscriptions does Ark Media offer?$Q$,
    $A$<p>Ark Media offers three subscription options through our website:</p><ul><li><strong>Ark+:</strong> Our premium podcast subscription, including ad-free listening, subscriber-only episodes, and early access to select content.</li><li><strong>The Fold:</strong> Access to The Fold App.</li><li><strong>Bundle:</strong> Combines Ark+ and The Fold at a discounted price, giving you access to all of our subscription benefits.</li></ul><p>All subscriptions purchased through the Ark Media website also include our paid newsletter.</p><p>If you prefer to subscribe through Apple Podcasts, you can also purchase Ark+ there. Apple subscriptions include the core Ark+ podcast benefits but do not include The Fold or newsletter access due to platform limitations. If you'd like access to The Fold or the paid newsletter, you can purchase a subscription to The Fold through our website.</p>$A$
  ),
  (
    4,
    $C$Choosing a Subscription$C$,
    $Q$What does an Ark+ subscription include?$Q$,
    $A$<p>Ark+ is the premium podcast subscription for Ark Media's podcast network. Ark+ includes:</p><ul><li>Subscriber-only episodes, including Call Me Back AMA</li><li>Early access to select episodes, including the mid-week Call Me Back episode</li><li>Ad-free listening across all Ark Media podcasts</li></ul><p>Ark+ subscriptions purchased through the Ark Media website also include our paid newsletter.</p>$A$
  ),
  (
    5,
    $C$Choosing a Subscription$C$,
    $Q$What does a subscription to The Fold include?$Q$,
    $A$<p>A subscription to The Fold includes:</p><ul><li>Full access to The Fold App</li><li>Paid newsletter</li></ul><p>It does not include Ark+ Podcast benefits.</p>$A$
  ),
  (
    6,
    $C$Choosing a Subscription$C$,
    $Q$What does the Bundle include?$Q$,
    $A$<p>Bundle includes:</p><ul><li>Ark+ podcast subscription</li><li>The Fold App</li><li>Paid newsletter</li></ul><p>Bundle combines everything we offer at a discounted price.</p>$A$
  ),
  (
    7,
    $C$Choosing a Subscription$C$,
    $Q$Where can I subscribe, and how much does it cost?$Q$,
    $A$<p>You can subscribe through the Ark Media website or Apple Podcasts.</p><p>On the Ark Media website, you can choose from:</p><ul><li><strong>Ark+:</strong> $8/month or $80/year</li><li><strong>The Fold:</strong> $19/month or $190/year</li><li><strong>Bundle:</strong> $25/month or $250/year, which includes both Ark+ and The Fold at a discounted price</li></ul><p>Apple Podcasts offers Ark+ for $8/month or $80/year.</p><p>If you choose to subscribe through the Ark Media website, you'll also have the option to pay more to further support Ark Media.</p>$A$
  ),
  (
    8,
    $C$Choosing a Subscription$C$,
    $Q$What's the difference between subscribing to Ark+ through our website and Apple Podcasts?$Q$,
    $A$<p>Both platforms include Ark+ podcast benefits. When you subscribe to Ark+ through our website, you will also receive the paid newsletter and watch ad-free videos on Spotify.</p>$A$
  ),
  (
    9,
    $C$Choosing a Subscription$C$,
    $Q$Why does Apple cost the same if it includes fewer benefits?$Q$,
    $A$<p>Platforms like Apple manage subscriptions entirely within their own systems and take a larger share of each subscription. Apple Podcasts does not share subscriber information with us, so we can't send the newsletter to Apple subscribers.</p><p>Because of that, we are limited to offering an in-platform experience (like ad-free content and bonus content). Pricing is kept consistent across platforms to keep things simple, but for the full Ark Media experience, subscribing through our website is the best option.</p>$A$
  ),

  -- Section 3 — Benefits & Features
  (
    10,
    $C$Benefits & Features$C$,
    $Q$Who receives the paid newsletter?$Q$,
    $A$<p>The paid newsletter is included with every subscription purchased through the Ark Media website, including Ark+, The Fold, and Bundle subscriptions.</p><p>Apple Podcasts does not share subscriber information with us, so we can't send the newsletter to Apple subscribers.</p>$A$
  ),
  (
    11,
    $C$Benefits & Features$C$,
    $Q$Is The Fold App included?$Q$,
    $A$<p>The Fold App is available with either of these subscriptions:</p><ul><li>The Fold subscription</li><li>Bundle subscription</li></ul><p>Apple subscribers can purchase The Fold separately without changing their existing Ark+ subscription.</p>$A$
  ),
  (
    12,
    $C$Benefits & Features$C$,
    $Q$Can I get ad-free video if I'm an Apple paid subscriber?$Q$,
    $A$<p>Ad-free video is currently only available to subscribers who purchase through the Ark Media website and listen on Spotify.</p>$A$
  ),
  (
    13,
    $C$Benefits & Features$C$,
    $Q$Is there a discount for annual subscriptions?$Q$,
    $A$<p>Yes, the annual subscription comes with a discount.</p>$A$
  ),
  (
    14,
    $C$Benefits & Features$C$,
    $Q$Can I share my Ark+ subscription with family members?$Q$,
    $A$<p>Ark+ subscriptions are tied to a single account and can't be shared across household members or multiple devices with separate logins. Each person who wants subscriber-only episodes, early access, and ad-free listening, or access to The Fold will need their own subscription.</p>$A$
  ),

  -- Section 4 — Getting Started
  (
    15,
    $C$Getting Started$C$,
    $Q$How do I access The Fold App?$Q$,
    $A$<p>If your subscription includes The Fold, log in to your Ark Media account and follow the link to access The Fold App. Sign in using the same email address and login method you use for your Ark Media account, either <strong>Continue with Google</strong> or your email and password.</p><p>If you purchased Ark+ through Apple, The Fold access is not included. You'll need to purchase a separate subscription for The Fold through the Ark Media website.</p>$A$
  ),
  (
    16,
    $C$Getting Started$C$,
    $Q$Can I listen in Spotify or another podcast app?$Q$,
    $A$<p>Yes. If you purchase a subscription through the Ark Media website, you can listen in Spotify and many other podcast apps, including Apple Podcasts, Overcast, Pocket Casts, and more, using your private subscriber feed. Once you've connected your preferred app, you'll receive new subscriber-only and ad-free episodes there.</p>$A$
  ),
  (
    17,
    $C$Getting Started$C$,
    $Q$How do I add my Ark+ subscription to Apple Podcasts, Spotify, or another podcast app?$Q$,
    $A$<p>If you purchased a subscription through the Ark Media website, log in to your account and access your private subscriber feeds. From there, you can connect your subscription to Apple Podcasts, Spotify, or another supported podcast app by following the setup instructions provided.</p>$A$
  ),
  (
    18,
    $C$Getting Started$C$,
    $Q$I subscribed to Ark+ on the website. Why does Apple Podcasts say I'm not subscribed?$Q$,
    $A$<p>If you purchased an Ark+ subscription through the Ark Media website, or were previously an Inside Call Me Back subscriber, your subscription is managed through Ark Media, not through Apple Podcasts.</p><p>Because of this, Apple Podcasts won't show you as an Apple subscriber, even though your Ark+ subscription is active.</p><p>To access subscriber-only episodes and listen ad-free, sign in to your Ark Media account and go to the Podcasts page. From there, add your Ark+ feeds to your preferred podcast app. Once you've added them, follow or favorite them so new episodes appear automatically.</p>$A$
  ),
  (
    19,
    $C$Getting Started$C$,
    $Q$I swear I'm subscribed on Spotify/Overcast/etc.$Q$,
    $A$<p>You may be listening on Spotify, Overcast, or another podcast app, but those apps don't sell or manage Ark+ subscriptions.</p><p>Ark+ subscriptions can only be purchased through the Ark Media website or Apple Podcasts. After you subscribe on our website, you can connect your Ark+ account to your preferred podcast app to listen there.</p><p>If you're not sure where you subscribed, check for an Apple subscription in your Apple account or look for an Ark Media charge on your bank or credit card statement.</p>$A$
  ),
  (
    20,
    $C$Getting Started$C$,
    $Q$I got a new phone. Do I need to set up my subscription again?$Q$,
    $A$<p>No. Your Ark+ subscription remains active when you get a new phone.</p><p>If your subscriber content doesn't appear automatically, sign in to your Ark Media account on your new device and reconnect your preferred podcast app from the account page.</p>$A$
  ),

  -- Section 5 — Account & Billing
  (
    21,
    $C$Account & Billing$C$,
    $Q$How do I know where I'm subscribed?$Q$,
    $A$<p><strong>Ark Media website:</strong> Sign in to this website with your email address, and click Account. If you can log in and see an active plan, you're subscribed via our website. For support, contact us or email <a href="mailto:support@arkmedia.org">support@arkmedia.org</a>.</p><p><strong>Apple Podcasts:</strong> Open the Apple Podcasts app, tap your profile icon (top right), tap "Subscriptions," and look for Ark Media / Ark+. For issues, use the Apple Podcasts subscription help form.</p><p>If you're still unsure, check your credit card statement for the charge.</p>$A$
  ),
  (
    22,
    $C$Account & Billing$C$,
    $Q$Can I log into the website if I subscribed through Apple?$Q$,
    $A$<p>Due to Apple's privacy policy, we don't have access to Apple's customer data so you won't have a log in to this website. If you'd like to access the paid newsletter and The Fold App, please subscribe to The Fold membership. For all technical issues on Apple's platform, please contact Apple Support directly.</p>$A$
  ),
  (
    23,
    $C$Account & Billing$C$,
    $Q$Why is Spotify asking me to connect my account?$Q$,
    $A$<p>If you tapped a locked Ark+ episode in Spotify, you may see a prompt asking you to link your account. This doesn't mean you can purchase an Ark+ subscription through Spotify. Instead, Spotify is asking you to connect an existing Ark+ subscription.</p><p>If you already subscribe through the Ark Media website:</p><ol><li>Tap Link Account in Spotify.</li><li>Sign in with your Ark Media account.</li><li>Once connected, your subscriber episodes will unlock automatically.</li></ol><p>If you don't have an Ark+ subscription yet, you'll need to subscribe through the Ark Media website first. After subscribing, you can link your account and listen in Spotify.</p>$A$
  ),
  (
    24,
    $C$Account & Billing$C$,
    $Q$Can I pay through Spotify?$Q$,
    $A$<p>No. Spotify doesn't currently support purchasing Ark+ subscriptions.</p><p>If you'd like to listen in Spotify, subscribe through the Ark Media website first. Then link your Ark Media account in Spotify to unlock your private subscriber feed.</p>$A$
  ),
  (
    25,
    $C$Account & Billing$C$,
    $Q$Can I switch my subscription to Apple and keep access to The Fold?$Q$,
    $A$<p>If you switch from paying through our website to Apple Podcasts, you'll lose access to The Fold App and everything that comes with it. If you'd like to regain access, you'll have to purchase the separate subscription for The Fold.</p>$A$
  ),
  (
    26,
    $C$Account & Billing$C$,
    $Q$Can I switch from monthly to annual billing?$Q$,
    $A$<p>Yes. If annual billing is available for your subscription, you can switch from a monthly to an annual plan through your account page. Your new billing schedule will take effect according to your platform's billing policies.</p>$A$
  ),
  (
    27,
    $C$Account & Billing$C$,
    $Q$Can I upgrade to the Bundle?$Q$,
    $A$<p>Yes. If you already have a subscription for Ark+ or The Fold through the Ark Media website, you can upgrade to the Bundle at any time to receive both podcast and The Fold benefits at the bundled price.</p>$A$
  ),
  (
    28,
    $C$Account & Billing$C$,
    $Q$How do I change my payment method?$Q$,
    $A$<p><strong>Ark Media Website:</strong> From the account page, click "Manage Billing."</p><p><strong>Apple:</strong> Open the Apple Podcasts app, click the profile icon, select "Manage Subscriptions," then click "Ark+".</p>$A$
  ),
  (
    29,
    $C$Account & Billing$C$,
    $Q$Can I move my subscription from Apple to the Ark Media website?$Q$,
    $A$<p>Because Apple and our website manage subscriptions separately, subscriptions can't be transferred between platforms. If you'd like to switch, you'll need to cancel your Apple subscription and subscribe through the Ark Media website after your current billing period ends.</p>$A$
  ),
  (
    30,
    $C$Account & Billing$C$,
    $Q$Can I cancel my subscription at any time?$Q$,
    $A$<p>You can cancel at any time. Your access will continue until the end of your current billing period, after which your subscription will not renew.</p>$A$
  ),
  (
    31,
    $C$Account & Billing$C$,
    $Q$I forgot which email address I used to subscribe.$Q$,
    $A$<p>If you're unable to log in or aren't sure which email address you used, please contact us at <a href="mailto:support@arkmedia.org">support@arkmedia.org</a>, and we'll help you locate your subscription.</p>$A$
  ),
  (
    32,
    $C$Account & Billing$C$,
    $Q$Who do I contact for billing or technical support?$Q$,
    $A$<p><strong>Ark Media:</strong> email <a href="mailto:support@arkmedia.org">support@arkmedia.org</a></p><p><strong>Apple:</strong> for billing questions, visit <a href="https://support.apple.com/billing" target="_blank" rel="noopener noreferrer">support.apple.com/billing</a>; for tech issues, visit <a href="https://support.apple.com/en-us/106932" target="_blank" rel="noopener noreferrer">support.apple.com/en-us/106932</a>.</p>$A$
  );

update faqs set key = v.key
from (values
  ($Q$Do I need to subscribe again?$Q$,                                    'icmb-resubscribe'),
  ($Q$What happened to Inside Call Me Back?$Q$,                            'icmb-what-happened'),
  ($Q$What subscriptions does Ark Media offer?$Q$,                         'plans-overview'),
  ($Q$What does an Ark+ subscription include?$Q$,                          'plan-ark-plus-includes'),
  ($Q$What does a subscription to The Fold include?$Q$,                    'plan-community-includes'),
  ($Q$What does the Bundle include?$Q$,                                    'plan-bundle-includes'),
  ($Q$Where can I subscribe, and how much does it cost?$Q$,                'where-to-subscribe-and-cost'),
  ($Q$What's the difference between subscribing to Ark+ through our website and Apple Podcasts?$Q$,
                                                                           'website-vs-apple'),
  ($Q$Why does Apple cost the same if it includes fewer benefits?$Q$,      'apple-same-price'),
  ($Q$Who receives the paid newsletter?$Q$,                                'paid-newsletter-who'),
  ($Q$Is The Fold App included?$Q$,                                        'community-app-included'),
  ($Q$Can I get ad-free video if I'm an Apple paid subscriber?$Q$,         'apple-ad-free-video'),
  ($Q$Is there a discount for annual subscriptions?$Q$,                    'annual-discount'),
  ($Q$Can I share my Ark+ subscription with family members?$Q$,            'family-sharing'),
  ($Q$How do I access The Fold App?$Q$,                                    'community-app-access'),
  ($Q$Can I listen in Spotify or another podcast app?$Q$,                  'listen-other-apps'),
  ($Q$How do I add my Ark+ subscription to Apple Podcasts, Spotify, or another podcast app?$Q$,
                                                                           'add-feed-to-app'),
  ($Q$I subscribed to Ark+ on the website. Why does Apple Podcasts say I'm not subscribed?$Q$,
                                                                           'apple-says-not-subscribed'),
  ($Q$I swear I'm subscribed on Spotify/Overcast/etc.$Q$,                  'spotify-overcast-not-showing'),
  ($Q$I got a new phone. Do I need to set up my subscription again?$Q$,    'new-phone-setup'),
  ($Q$How do I know where I'm subscribed?$Q$,                              'where-am-i-subscribed'),
  ($Q$Can I log into the website if I subscribed through Apple?$Q$,        'apple-website-login'),
  ($Q$Why is Spotify asking me to connect my account?$Q$,                  'spotify-connect-account'),
  ($Q$Can I pay through Spotify?$Q$,                                       'spotify-payment'),
  ($Q$Can I switch my subscription to Apple and keep access to The Fold?$Q$,
                                                                           'switch-to-apple-keep-community'),
  ($Q$Can I switch from monthly to annual billing?$Q$,                     'switch-monthly-to-annual'),
  ($Q$Can I upgrade to the Bundle?$Q$,                                     'upgrade-to-bundle'),
  ($Q$How do I change my payment method?$Q$,                               'change-payment-method'),
  ($Q$Can I move my subscription from Apple to the Ark Media website?$Q$,  'move-apple-to-website'),
  ($Q$Can I cancel my subscription at any time?$Q$,                        'cancel-anytime'),
  ($Q$I forgot which email address I used to subscribe.$Q$,                'forgot-subscribe-email'),
  ($Q$Who do I contact for billing or technical support?$Q$,               'contact-support')
) as v(question, key)
where faqs.question = v.question
  and faqs.key is null;
