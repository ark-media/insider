-- 0002_faq_drop_password_signin.sql
--
-- The Fold-access answer told members to sign in "either Continue with Google
-- or your email and password". Password sign-in was removed from the Auth0
-- login page on 2026-09-16 (auth0/README.md): the login page now offers Google
-- and an emailed one-time code, and nothing else. The answer as written sends a
-- member hunting for a credential that no longer exists — and names one they
-- may never have had, which the rest of the product's copy is careful not to do.
--
-- Addressed BY KEY rather than by display_order or question text. `faqs.key` is
-- the stable handle (0001 backfills it, faqs_key_idx makes it unique); an admin
-- reordering the corpus from the back office changes display_order underneath
-- us, and matching on the question means an edit to the question silently turns
-- this into a no-op that reports success.
--
-- The `update … from (values …)` shape is load-bearing beyond SQL: it is what
-- src/lib/support/search.fixtures.ts recognises as a key-addressed rewrite and
-- replays on top of 0001's seed, so the support-search golden set keeps testing
-- the corpus the database actually holds. Keep the shape if you edit this.
--
-- Idempotent: re-running rewrites the same row to the same text.

update faqs set question = v.question, answer = v.answer, updated_at = now()
from (values
  (
    'community-app-access',
    $Q$How do I access The Fold App?$Q$,
    $A$<p>If your subscription includes The Fold, log in to your Ark Media account and follow the link to access The Fold App. Sign in using the same email address you use for your Ark Media account, either <strong>Continue with Google</strong> or <strong>Email me a code</strong>, which sends a one-time code to your inbox.</p><p>If you purchased Ark+ through Apple, The Fold access is not included. You'll need to purchase a separate subscription for The Fold through the Ark Media website.</p>$A$
  )
) as v(key, question, answer)
where faqs.key = v.key;
