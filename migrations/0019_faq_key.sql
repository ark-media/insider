-- 0019_faq_key.sql
-- FAQs gain a stable `key` — a short slug that code can bind to.
--
-- Why: the help widget's curated topic table needs to point at specific FAQs
-- ("cancel or change my plan" surfaces the cancellation answer). None of the
-- existing columns can carry that reference:
--   * `id` is a gen_random_uuid() that both content migrations (0014, 0018)
--     threw away with `delete from faqs`, so it has already changed once.
--   * `display_order` is editable from the back office and shifts on insert.
--   * The question text is editable too — "Call me Back" became "Call Me Back"
--     between 0014 and 0018.
-- A key is the one thing an editor can leave alone while rewording everything
-- around it. Nullable, so an admin can add an FAQ without inventing one; unique
-- (Postgres allows many NULLs under a unique index) so two rows can't claim the
-- same binding.
--
-- Backfilled by matching the question text seeded in 0018 rather than by
-- display_order: if a question has since been reworded, that row simply keeps a
-- null key instead of silently acquiring the wrong one. The widget's test suite
-- asserts every key a topic references resolves, so a miss is caught there.
--
-- Dollar-quoted literals ($Q$…$Q$) so apostrophes don't need escaping.

alter table faqs
  add column if not exists key text;

create unique index if not exists faqs_key_idx on faqs (key);

update faqs set key = v.key
from (values
  ($Q$Do I need to subscribe again?$Q$,                                    'icmb-resubscribe'),
  ($Q$What happened to Inside Call Me Back?$Q$,                            'icmb-what-happened'),
  ($Q$What subscriptions does Ark Media offer?$Q$,                         'plans-overview'),
  ($Q$What does an Ark+ subscription include?$Q$,                          'plan-ark-plus-includes'),
  ($Q$What does a Community subscription include?$Q$,                      'plan-community-includes'),
  ($Q$What does the Bundle include?$Q$,                                    'plan-bundle-includes'),
  ($Q$Where can I subscribe, and how much does it cost?$Q$,                'where-to-subscribe-and-cost'),
  ($Q$What's the difference between subscribing to Ark+ through our website and Apple Podcasts?$Q$,
                                                                           'website-vs-apple'),
  ($Q$Why does Apple cost the same if it includes fewer benefits?$Q$,      'apple-same-price'),
  ($Q$Who receives the paid newsletter?$Q$,                                'paid-newsletter-who'),
  ($Q$Is the Community App included?$Q$,                                   'community-app-included'),
  ($Q$Can I get ad-free video if I'm an Apple paid subscriber?$Q$,         'apple-ad-free-video'),
  ($Q$Does my subscription include members-only content on YouTube?$Q$,    'youtube-members-only'),
  ($Q$Is there a discount for annual subscriptions?$Q$,                    'annual-discount'),
  ($Q$Can I share my Ark+ subscription with family members?$Q$,            'family-sharing'),
  ($Q$How do I access the Community App?$Q$,                               'community-app-access'),
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
  ($Q$Can I switch my subscription to Apple and keep Community access?$Q$, 'switch-to-apple-keep-community'),
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
