-- 0009_faq_call_me_back_ark_plus.sql
--
-- Two renames in the FAQ copy:
--   * The members-only show formerly Inside Call Me Back is now called
--     "Call me Back | Ark+", not "Call me Back AMA" (the interim title).
--   * The show is written "Call me Back" (lower-case "me") everywhere, to
--     match the team's Airtable and the old site. That touches every answer
--     that names it, and the category heading of the two Inside Call me Back
--     questions.
--
-- Addressed BY KEY, in the `update … from (values …)` shape that
-- src/lib/support/search.fixtures.ts replays — see 0002 for why both matter.
-- The category is a separate statement: the fixtures replay question/answer
-- rewrites only, and search matches case-insensitively, so the heading's
-- casing makes no difference to them.
-- Checked before writing: none of these rows had been edited from the back
-- office in dev or prod, so this overwrites nothing but the seed text.
--
-- Idempotent: re-running rewrites the same rows to the same text.

update faqs set question = v.question, answer = v.answer, updated_at = now()
from (values
  (
    'icmb-what-happened',
    $Q$What happened to Inside Call me Back?$Q$,
    $A$<p>You are not losing Inside Call me Back. The weekly series is continuing under a new name, Call me Back | Ark+, and will remain available in the Call me Back subscriber feed as part of your Ark+ subscription.</p>$A$
  ),
  (
    'plan-ark-plus-includes',
    $Q$What does an Ark+ subscription include?$Q$,
    $A$<p>Ark+ is the premium podcast subscription for Ark Media's podcast network. Ark+ includes:</p><ul><li>Subscriber-only episodes, including Call me Back | Ark+</li><li>Early access to select episodes, including the mid-week Call me Back episode</li><li>Ad-free listening across all Ark Media podcasts</li></ul><p>Ark+ subscriptions purchased through the Ark Media website also include our paid newsletter.</p>$A$
  ),
  (
    'icmb-resubscribe',
    $Q$Do I need to subscribe again?$Q$,
    $A$<p>No. If you already had an active Inside Call me Back subscription, your subscription has automatically become an Ark+ subscription. You do not need to subscribe again to continue receiving your podcast benefits. If you'd like access to The Fold App, you can upgrade to the Bundle at any time.</p>$A$
  ),
  (
    'apple-says-not-subscribed',
    $Q$I subscribed to Ark+ on the website. Why does Apple Podcasts say I'm not subscribed?$Q$,
    $A$<p>If you purchased an Ark+ subscription through the Ark Media website, or were previously an Inside Call me Back subscriber, your subscription is managed through Ark Media, not through Apple Podcasts.</p><p>Because of this, Apple Podcasts won't show you as an Apple subscriber, even though your Ark+ subscription is active.</p><p>To access subscriber-only episodes and listen ad-free, sign in to your Ark Media account and go to the Podcasts page. From there, add your Ark+ feeds to your preferred podcast app. Once you've added them, follow or favorite them so new episodes appear automatically.</p>$A$
  )
) as v(key, question, answer)
where faqs.key = v.key;

update faqs
set category = replace(category, 'Call Me Back', 'Call me Back'), updated_at = now()
where category like '%Call Me Back%';
