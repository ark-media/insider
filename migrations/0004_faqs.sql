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
