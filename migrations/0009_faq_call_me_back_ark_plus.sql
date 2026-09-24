-- 0009_faq_call_me_back_ark_plus.sql
--
-- The members-only show formerly Inside Call Me Back is now called Call Me
-- Back Ark+, not Call Me Back AMA. Two answers named the interim title.
--
-- Addressed BY KEY, in the `update … from (values …)` shape that
-- src/lib/support/search.fixtures.ts replays — see 0002 for why both matter.
-- Checked before writing: neither row had been edited from the back office in
-- dev or prod, so this overwrites nothing but the seed text.
--
-- Idempotent: re-running rewrites the same rows to the same text.

update faqs set question = v.question, answer = v.answer, updated_at = now()
from (values
  (
    'icmb-what-happened',
    $Q$What happened to Inside Call Me Back?$Q$,
    $A$<p>You are not losing Inside Call Me Back. The weekly series is continuing under a new name, Call Me Back Ark+, and will remain available in the Call Me Back subscriber feed as part of your Ark+ subscription.</p>$A$
  ),
  (
    'plan-ark-plus-includes',
    $Q$What does an Ark+ subscription include?$Q$,
    $A$<p>Ark+ is the premium podcast subscription for Ark Media's podcast network. Ark+ includes:</p><ul><li>Subscriber-only episodes, including Call Me Back Ark+</li><li>Early access to select episodes, including the mid-week Call Me Back episode</li><li>Ad-free listening across all Ark Media podcasts</li></ul><p>Ark+ subscriptions purchased through the Ark Media website also include our paid newsletter.</p>$A$
  )
) as v(key, question, answer)
where faqs.key = v.key;
