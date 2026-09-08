-- 0021_faq_fold_rename.sql
-- "The community" / "the Community App" is now "the Fold" everywhere a member
-- reads it. The FAQ corpus lives in this table, so the rename has to happen
-- here rather than in code.
--
-- Addressed by `key` (0019), not by question text or display_order: two of
-- these rows have their QUESTION reworded by this migration, so matching on the
-- old text would work exactly once and then silently no-op on a re-run. Keys
-- are unchanged on purpose — src/data/supportTopics.ts binds topics to them,
-- and a key rename would be a second, unrelated breaking change.
--
-- Only rows that actually mention the community are touched; the other 21 FAQs
-- are left alone. Prices quoted below are carried over verbatim from 0018 —
-- this migration renames a product, it does not restate what it costs.
--
-- Dollar-quoted literals ($Q$…$Q$ / $A$…$A$) so apostrophes don't need escaping.

update faqs set question = v.question, answer = v.answer
from (values
  (
    'icmb-resubscribe',
    $Q$Do I need to subscribe again?$Q$,
    $A$<p>No. If you already had an active Inside Call Me Back subscription, your subscription has automatically become an Ark+ subscription. You do not need to subscribe again to continue receiving your podcast benefits. If you'd like access to the Fold, you can upgrade to the Bundle at any time.</p>$A$
  ),
  (
    'plans-overview',
    $Q$What subscriptions does Ark Media offer?$Q$,
    $A$<p>Ark Media offers three subscription options through our website:</p><ul><li><strong>Ark+:</strong> Our premium podcast subscription, including ad-free listening, subscriber-only episodes, and early access to select content.</li><li><strong>The Fold:</strong> Access to the Fold, the Ark Media members' app.</li><li><strong>Bundle:</strong> Combines Ark+ and the Fold at a discounted price, giving you access to all of our subscription benefits.</li></ul><p>All subscriptions purchased through the Ark Media website also include our paid newsletter.</p><p>If you prefer to subscribe through Apple Podcasts, you can also purchase Ark+ there. Apple subscriptions include the core Ark+ podcast benefits but do not include the Fold or newsletter access due to platform limitations. If you'd like access to the Fold or paid newsletter, you can purchase a Fold subscription through our website.</p>$A$
  ),
  (
    'plan-community-includes',
    $Q$What does a Fold subscription include?$Q$,
    $A$<p>The Fold includes:</p><ul><li>Full access to the Fold, the Ark Media members' app</li><li>Paid newsletter</li></ul><p>The Fold does not include Ark+ Podcast benefits.</p>$A$
  ),
  (
    'plan-bundle-includes',
    $Q$What does the Bundle include?$Q$,
    $A$<p>Bundle includes:</p><ul><li>Ark+ podcast subscription</li><li>The Fold</li><li>Paid newsletter</li></ul><p>Bundle combines everything we offer at a discounted price.</p>$A$
  ),
  (
    'where-to-subscribe-and-cost',
    $Q$Where can I subscribe, and how much does it cost?$Q$,
    $A$<p>You can subscribe through the Ark Media website or Apple Podcasts.</p><p>On the Ark Media website, you can choose from:</p><ul><li><strong>Ark+:</strong> $8/month or $80/year</li><li><strong>The Fold:</strong> $8/month</li><li><strong>Bundle:</strong> $13/month or $130/year, which includes both Ark+ and the Fold at a discounted price</li></ul><p>Apple Podcasts offers Ark+ for $8/month or $80/year.</p><p>If you choose to subscribe through the Ark Media website, you'll also have the option to pay more to further support Ark Media.</p>$A$
  ),
  (
    'paid-newsletter-who',
    $Q$Who receives the paid newsletter?$Q$,
    $A$<p>The paid newsletter is included with every subscription purchased through the Ark Media website, including Ark+, the Fold, and Bundle subscriptions.</p><p>Apple Podcasts does not share subscriber information with us, so we can't send the newsletter to Apple subscribers.</p>$A$
  ),
  (
    'community-app-included',
    $Q$Is the Fold included?$Q$,
    $A$<p>The Fold is available with either:</p><ul><li>a Fold subscription</li><li>a Bundle subscription</li></ul><p>Apple subscribers can purchase the Fold separately without changing their existing Ark+ subscription.</p>$A$
  ),
  (
    'family-sharing',
    $Q$Can I share my Ark+ subscription with family members?$Q$,
    $A$<p>Ark+ subscriptions are tied to a single account and can't be shared across household members or multiple devices with separate logins. Each person who wants subscriber-only episodes, early access, and ad-free listening, or access to the Fold will need their own subscription.</p>$A$
  ),
  (
    'community-app-access',
    $Q$How do I access the Fold?$Q$,
    $A$<p>If you have a Fold or Bundle subscription, log in to your Ark Media account and follow the instructions to access the Fold. If you purchased your Ark+ subscription through Apple, you'll need to purchase a separate Fold subscription through the Ark Media website to gain access.</p>$A$
  ),
  (
    'apple-website-login',
    $Q$Can I log into the website if I subscribed through Apple?$Q$,
    $A$<p>Due to Apple's privacy policy, we don't have access to Apple's customer data so you won't have a log in to this website. If you'd like to access the paid newsletter and the Fold, please subscribe to the Fold membership. For all technical issues on Apple's platform, please contact Apple Support directly.</p>$A$
  ),
  (
    'switch-to-apple-keep-community',
    $Q$Can I switch my subscription to Apple and keep access to the Fold?$Q$,
    $A$<p>If you switch from paying through our website to Apple Podcasts, you'll lose access to the Fold and everything that comes with it. If you'd like to regain access, you'll have to purchase the separate Fold subscription.</p>$A$
  ),
  (
    'upgrade-to-bundle',
    $Q$Can I upgrade to the Bundle?$Q$,
    $A$<p>Yes. If you already have an Ark+ or Fold subscription through the Ark Media website, you can upgrade to the Bundle at any time to receive both podcast and Fold benefits at the bundled price.</p>$A$
  )
) as v(key, question, answer)
where faqs.key = v.key;
