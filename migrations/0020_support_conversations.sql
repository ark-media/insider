-- 0020_support_conversations.sql
-- One row per help-widget session, so the team can see what members actually
-- ask and which questions the FAQ corpus fails to answer.
--
-- The widget is a deterministic search over `faqs` plus a curated routing
-- table; it has no way of knowing when it was unhelpful. This log is that
-- feedback loop. The valuable view isn't the transcript — it's the set of
-- queries that returned nothing, which is the backlog for /admin/faqs.
--
-- `steps` is an ordered JSONB array of {at, kind, value} where kind is one of
-- topic | query | no_results | faq_opened | link | escalate. JSONB rather than
-- a child table because a session is always read whole, never queried across
-- rows by step, and the shape will move as the widget's states do.
--
-- `email` is derived server-side from the session cookie and is null for
-- guests — never taken from the request body. Tier is deliberately absent: the
-- request identity doesn't carry it, and resolving it would put a membership
-- lookup on a hot public endpoint. /admin/members answers that by email.
--
-- Retention: rows are pruned after 180 days by the monthly
-- /api/cron/prune-webhook-events job. Free-text queries can carry personal
-- details, so this must not accumulate indefinitely.

create table if not exists support_conversations (
  id          uuid          primary key default gen_random_uuid(),
  session_id  text          not null unique,
  email       text,
  steps       jsonb         not null default '[]'::jsonb,
  escalated   boolean       not null default false,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now()
);

-- The admin review page reads the most recent sessions; the prune job deletes
-- the oldest. Both are served by an index on created_at.
create index if not exists support_conversations_recent_idx
  on support_conversations (created_at desc);
