-- 0003_rate_limit_buckets.sql
--
-- Token buckets for the rate limiter that has to hold across function instances
-- (server/lib/shared-rate-limit.ts). The in-memory limiter gives every Vercel
-- instance its own buckets, which multiplies the limit on exactly the routes
-- that need one most: the unauthenticated ones that create Stripe objects or
-- send mail per call.
--
-- `key` is the SHA-256 of "<limiter name>|<caller key>". Caller keys carry IPs
-- and email addresses; none of that is stored.
--
-- `allowed` records whether the last take spent a token. The post-take balance
-- can't say on its own: 0.5 is both "held 1.5 and spent one" and "held 0.5 and
-- was refused".
--
-- No foreign keys and nothing reads it but the limiter. Rows are pruned
-- opportunistically by the limiter itself once they are two days stale.
--
-- Idempotent.

create table if not exists rate_limit_buckets (
  key        text             primary key,
  tokens     double precision not null,
  allowed    boolean          not null default true,
  updated_at timestamptz      not null default now()
);

create index if not exists rate_limit_buckets_updated_at_idx
  on rate_limit_buckets (updated_at);
