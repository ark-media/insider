-- 0022_faq_content_refresh.sql
-- Replaces the FAQ corpus with the revised copy from the Ark+ FAQ doc
-- (2026-09-10). Same shape as 0018 — five sections, a global 1..N
-- display_order, the component derives section order from first appearance —
-- so this is a content-only refresh, and like 0014/0018 it wipes and reseeds.
-- Pre-launch and greenfield, so a clean replace is the intended behaviour; any
-- edits made in the admin back office since 0018 are discarded.
--
-- What changed vs 0018 + 0021:
--   * PRICES corrected to match the Stripe catalog (scripts/stripe-catalog.ts):
--     the Fold is $19/month or $190/year and Bundle $25/month or $250/year.
--     0018 quoted $8 and $13/$130, and 0021 carried those forward verbatim.
--   * The Fold is now written "The Fold" / "The Fold App" throughout, per the
--     doc — 0021 used the lowercase-article "the Fold" form.
--   * REMOVED: "Does my subscription include members-only content on YouTube?"
--     (key `youtube-members-only`). No topic in src/data/supportTopics.ts binds
--     to it; its two entries in the search golden set go with it.
--   * Reworded questions: "What does a Fold subscription include?" ->
--     "What does a subscription to The Fold include?"; "Is the Fold included?"
--     -> "Is The Fold App included?"; "How do I access the Fold?" -> "How do I
--     access The Fold App?"; "...keep access to the Fold?" -> "...keep access
--     to The Fold?".
--   * Rewritten answers: how to access the Fold (now names the sign-in method),
--     where am I subscribed (drops the stale "subscribed via Supporting Cast"
--     and the arkmedia.org detour), change payment method (account page ->
--     "Manage Billing", per the /account tabs redesign), monthly-to-annual
--     (account page, not "subscription management page"). "Set Up Feed page"
--     becomes the Podcasts page / the account page, matching the real routes.
--
-- Keys are re-established at the bottom rather than carried, because the reseed
-- drops every row: src/data/supportTopics.ts binds topics to these keys, and
-- src/lib/support/search.fixtures.ts parses both blocks out of this file. The
-- keys themselves are deliberately unchanged (`plan-community-includes`,
-- `community-app-access`, ... still say "community") — renaming them would be
-- a second, unrelated breaking change.
--
-- Dollar-quoted literals ($C$/$Q$/$A$) so apostrophes and dollar amounts don't
-- need escaping.

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
