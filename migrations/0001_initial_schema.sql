-- Squashed launch schema — migrations 0001–0005 collapsed into one canonical
-- initial schema for a fresh database.
--
-- PRE-LAUNCH RESET. This supersedes the former 0001–0005 sequence. Apply to a
-- NEW/empty database with `bun run migrate`. The already-migrated dev and prod
-- databases still carry the old 0001–0005 rows in `_migrations`; against them a
-- plain `migrate` is a no-op (0001 is already recorded by name), so adopting
-- this squash there means recreating the schema fresh (or baselining the
-- ledger). Intentionally breaks the "don't edit applied migrations" rule
-- because we are pre-launch with no production data to preserve.
--
-- Reproducible seed data (2 careers, 7 FAQs) is included below; the only
-- non-seed prod row today is a single test announcement, which is not carried.

-- announcements: site-wide banner bar managed from the back office.
create table if not exists announcements (
  id           uuid          primary key default gen_random_uuid(),
  body         text          not null,
  action_url   text,
  bar_color    text          not null,
  text_color   text          not null,
  dismissible  boolean       not null default true,
  enabled      boolean       not null default true,
  starts_at    timestamptz   not null,
  ends_at      timestamptz   not null,
  created_at   timestamptz   not null default now(),
  updated_at   timestamptz   not null default now()
);

create table if not exists discuss_threads (
  id                    uuid         primary key default gen_random_uuid(),
  newsletter_slug       text         not null,
  beehiiv_post_id       text         not null unique,
  beehiiv_post_title    text         not null,
  circle_thread_url     text         not null,
  circle_space_id       integer      not null,
  circle_post_id        text         not null,
  beehiiv_body_patched  boolean      not null default false,
  created_at            timestamptz  not null default now()
);

create index if not exists discuss_threads_newsletter_slug_idx
  on discuss_threads (newsletter_slug);
-- Mirrors a reader's Beehiiv subscription state so /account/newsletters can
-- render the current preferences without hitting Beehiiv on every page load,
-- and so the webhook (subscription.deleted, .upgraded, .downgraded, etc.) has
-- a place to land its updates. One row per email — we run a single shared
-- publication, so a reader has at most one subscription record across both
-- newsletters; `has_premium` distinguishes which tier of issues they get.

create table if not exists beehiiv_subscription (
  email                   text         primary key,
  publication_id          text         not null,
  beehiiv_subscription_id text         not null,
  status                  text         not null,
  has_premium             boolean      not null default false,
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now()
);
-- Careers: admin-managed job postings. Each row is one open position with a
-- short summary (shown on the /careers list) and a long HTML description (shown
-- on /careers/<slug>). `apply_url` is the external application link — for Ark
-- this is the per-role TestGorilla assessment. The back office owns this table;
-- the public site reads only enabled rows, ordered by display_order.

create table if not exists careers (
  id               uuid          primary key default gen_random_uuid(),
  slug             text          not null unique,
  title            text          not null,
  team             text,
  location         text,
  employment_type  text,
  summary          text          not null,
  description      text          not null,
  apply_url        text,
  enabled          boolean       not null default true,
  display_order    integer       not null default 0,
  created_at       timestamptz   not null default now(),
  updated_at       timestamptz   not null default now()
);

-- Public listing reads enabled rows in display order; index that access path.
create index if not exists careers_enabled_order_idx
  on careers (enabled, display_order, created_at);

-- Seed the two live positions from arkmedia.org/careers. Dollar-quoted bodies
-- so the HTML's apostrophes don't need escaping. Idempotent on slug.
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
-- FAQs: admin-managed frequently-asked questions, shown on /plus. Each row is
-- one question with a sanitized-HTML answer (paragraphs + inline formatting and
-- links). The back office owns this table; the public site reads only enabled
-- rows, ordered by display_order. Mirrors the careers table, minus the slug and
-- detail page (an FAQ has no standalone URL).

create table if not exists faqs (
  id            uuid          primary key default gen_random_uuid(),
  question      text          not null,
  answer        text          not null,
  enabled       boolean       not null default true,
  display_order integer       not null default 0,
  created_at    timestamptz   not null default now(),
  updated_at    timestamptz   not null default now()
);

-- Public listing reads enabled rows in display order; index that access path.
create index if not exists faqs_enabled_order_idx
  on faqs (enabled, display_order, created_at);

-- Seed the live FAQ list currently hardcoded in src/components/FAQ.tsx, so the
-- /plus page looks identical the moment this table becomes the source of truth.
-- Dollar-quoted bodies so apostrophes don't need escaping.
insert into faqs (display_order, question, answer)
values
  (
    1,
    'Can I still listen to Call Me Back for free, or do I need a paid subscription?',
    $a$<p>Yes! The Call Me Back feed is free. New episodes drop every Monday and Thursday.</p><p>Inside Call Me Back grants you access to an extra episode every Friday, featuring Dan, Nadav Eyal, and Amit Segal answering listener questions.</p>$a$
  ),
  (
    2,
    'Can I listen to Inside Call Me Back on my favorite podcasting app?',
    $a$<p>Yes! You can listen to the members-only Inside Call Me Back extra episodes on a variety of podcast apps including Spotify, Apple Podcasts, YouTube Music, Overcast, Pocket Casts, and Downcast. Once you subscribe, you'll be able to choose your favorite podcasting app to listen on.</p>$a$
  ),
  (
    3,
    'What do I need to do to join Inside Call Me Back?',
    $a$<p>At the top of this page, first choose whether you'd like to get a monthly or annual subscription (which saves 16%).</p><p>Second, select the amount you'd like to pay each billing period. The baseline payment is $8/month or $80/year — but we welcome additional support.</p><p>Third, select your payment method (credit card, Apple Pay, or Google Pay) and enter the required information.</p><p>That's it! You should get an email confirming your new subscription (make sure to check your spam folder if you don't see it immediately).</p><p>Once you've subscribed, you'll be taken to a setup page to choose which platform you'd like to listen on.</p><p>You're all set! Welcome aboard and happy listening!</p>$a$
  ),
  (
    4,
    'What are my payment options?',
    $a$<p>You can choose between a monthly and annual billing cadence. The baseline payment is $8/month or $80/year (saves 16%).</p><p>If you'd like to support Ark Media's mission further, you can choose to pay more by selecting one of the suggested amounts, or entering any amount higher than the starting price. No matter what you choose to pay, you will become an insider and gain access to Inside Call Me Back's members-only episodes.</p>$a$
  ),
  (
    5,
    'What types of payment do you accept?',
    $a$<p>You can pay with any major credit cards, as well as Apple Pay and Google Pay.</p>$a$
  ),
  (
    6,
    'How do I cancel my Inside Call Me Back subscription?',
    $a$<p>At the top of this page, click Login. Sign into your account with the email address you used to subscribe. Once you're signed in, you can access the account page to update your payment method, cancel your subscription, or change your contact information.</p>$a$
  ),
  (
    7,
    'Who do I reach out to for additional support?',
    $a$<p>Contact <a href="mailto:help@supportingcast.fm">help@supportingcast.fm</a> for support.</p>$a$
  );
-- Idempotency ledger for Stripe webhook delivery. Stripe guarantees
-- at-least-once delivery, so the same event.id can arrive more than once
-- (network retries, our own 5xx retries). Replaying an event would re-run its
-- side effects — Simplecast DELETE on subscription.deleted, the Beehiiv
-- downgrade, the entitlement flip to free, and the gift welcome email — none of
-- which are individually replay-safe. The webhook handler claims each event.id
-- here before dispatch and skips any it has already processed.
--
-- A claim is released (deleted) if dispatch fails so Stripe's retry can
-- reprocess; it is kept once dispatch succeeds (or hits a terminal, retry-won't-
-- help state) so the side effects never run twice.

create table if not exists stripe_webhook_events (
  id           text         primary key,
  type         text         not null,
  received_at  timestamptz  not null default now()
);
