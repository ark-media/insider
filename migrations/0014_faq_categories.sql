-- 0014_faq_categories.sql
-- FAQs gain a `category` — a plain-text section heading used to group questions
-- into sections on the public /plus and /pricing FAQ accordion (see
-- src/components/FAQ.tsx). Empty string means ungrouped.
--
-- This migration also replaces the entire seeded FAQ set with the canonical
-- Ark+ FAQ content (five sections, 33 questions). Pre-launch and greenfield, so
-- a clean replace is the intended behaviour: it wipes prior FAQ rows and reseeds
-- from scratch. display_order is a global 1..N sequence; the component derives
-- section order from first appearance in that order.
--
-- Dollar-quoted literals ($A$…$A$) so apostrophes and dollar amounts don't need
-- escaping.

alter table faqs
  add column if not exists category text not null default '';

delete from faqs;

insert into faqs (display_order, category, question, answer)
values
  -- Section 1 — Being an Insider
  (
    1,
    $C$I'm an Insider as of October 4, 2026. What does this mean for me?$C$,
    $Q$What happened to Inside Call me Back?$Q$,
    $A$<p>You still get Inside Call me Back, which is now a benefit for the larger Ark+ subscription. Inside Call me Back will remain as a weekly series within the Call me Back subscriber feed, but no longer refers to our subscription offering.</p>$A$
  ),
  (
    2,
    $C$I'm an Insider as of October 4, 2026. What does this mean for me?$C$,
    $Q$I already subscribed to Inside Call Me Back. Do I need to subscribe again?$Q$,
    $A$<p>No. If you already had an active Inside Call Me Back subscription, your subscription has automatically become an Ark+ subscription. You do not need to subscribe again to continue receiving your podcast benefits. If you would like to access our Community app, you will need to upgrade your subscription to the bundle.</p>$A$
  ),

  -- Section 2 — Choosing a Subscription
  (
    3,
    $C$Choosing a Subscription$C$,
    $Q$What subscriptions does Ark Media offer?$Q$,
    $A$<p>Ark Media offers three subscription options through our website:</p><ul><li><strong>Ark+:</strong> Our premium podcast subscription, including ad-free listening, subscriber-only episodes, and early access to select content.</li><li><strong>Community:</strong> Access to the Ark Media Community App.</li><li><strong>Bundle:</strong> Combines Ark+ and Community at a discounted price, giving you access to all of our subscription benefits.</li></ul><p>All subscriptions purchased through the Ark Media website also include our paid newsletter.</p><p>If you prefer to subscribe through Apple Podcasts, you can also purchase Ark+ there. Apple subscriptions include the core Ark+ podcast benefits but do not include Community or newsletter access due to platform limitations. If you'd like access to the Community or paid newsletter, you can purchase a Community subscription through our website.</p>$A$
  ),
  (
    4,
    $C$Choosing a Subscription$C$,
    $Q$What does an Ark+ subscription include?$Q$,
    $A$<p>Ark+ is the premium podcast subscription for Ark Media's podcast network. Ark+ includes:</p><ul><li>Subscriber-only episodes, including Inside Call Me Back</li><li>Early access to select episodes, including the mid-week Call Me Back episode</li><li>Ad-free listening across all Ark Media podcasts</li></ul><p>Ark+ subscriptions purchased through the Ark Media website also include our paid newsletter.</p>$A$
  ),
  (
    5,
    $C$Choosing a Subscription$C$,
    $Q$What does a Community subscription include?$Q$,
    $A$<p>Community includes:</p><ul><li>Full access to the Ark Media Community App</li><li>Paid newsletter</li></ul><p>Community does not include Ark+ Podcast benefits.</p>$A$
  ),
  (
    6,
    $C$Choosing a Subscription$C$,
    $Q$What does the Bundle include?$Q$,
    $A$<p>Bundle includes:</p><ul><li>Ark+ podcast subscription</li><li>Community App</li><li>Paid newsletter</li></ul><p>Bundle combines everything we offer at a discounted price.</p>$A$
  ),
  (
    7,
    $C$Choosing a Subscription$C$,
    $Q$Where can I subscribe, and how much does it cost?$Q$,
    $A$<p>You can subscribe through the Ark Media website or Apple Podcasts.</p><p>On the Ark Media website, you can choose from:</p><ul><li><strong>Ark+:</strong> $8/month or $80/year</li><li><strong>Community:</strong> $8/month</li><li><strong>Bundle:</strong> $13/month or $130/year, which includes both Ark+ and Community at a discounted price</li></ul><p>Apple Podcasts offers Ark+ for $8/month or $80/year.</p><p>If you choose to subscribe through the Ark Media website, you'll also have the option to pay more to further support Ark Media.</p>$A$
  ),
  (
    8,
    $C$Choosing a Subscription$C$,
    $Q$What's the difference between subscribing to Ark+ through our website and Apple Podcasts?$Q$,
    $A$<p>Both platforms include Ark+ podcast benefits. When you subscribe to Ark+ through our website, you will also receive the paid newsletter and be able to watch ad-free videos on Spotify.</p>$A$
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
    $A$<p>The paid newsletter is included with every subscription purchased through the Ark Media website, including Ark+, Community, and Bundle subscriptions.</p><p>Apple Podcasts does not share subscriber information with us, so we can't send the newsletter to Apple subscribers.</p>$A$
  ),
  (
    11,
    $C$Benefits & Features$C$,
    $Q$Is the Community App included?$Q$,
    $A$<p>The Community App is available with either:</p><ul><li>a Community subscription</li><li>a Bundle subscription</li></ul><p>Apple subscribers can purchase Community separately without changing their existing Ark+ subscription.</p>$A$
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
    $Q$Does my subscription include members-only content on YouTube?$Q$,
    $A$<p>Ark+ subscriptions don't include access to bonus episodes on YouTube, as YouTube memberships are managed separately. Because the platforms operate independently, we recommend signing up on the platform that suits you best.</p>$A$
  ),
  (
    14,
    $C$Benefits & Features$C$,
    $Q$Is there a discount for annual subscriptions?$Q$,
    $A$<p>Yes, the annual subscription comes with a discount.</p>$A$
  ),
  (
    15,
    $C$Benefits & Features$C$,
    $Q$Can I share my Ark+ subscription with family members?$Q$,
    $A$<p>Ark+ subscriptions are tied to a single account and can't be shared across household members or multiple devices with separate logins. Each person who wants ad-free listening, subscriber-only episodes, or Community access will need their own subscription.</p>$A$
  ),

  -- Section 4 — Getting Started
  (
    16,
    $C$Getting Started$C$,
    $Q$How do I access the Community App?$Q$,
    $A$<p>If you have a Community or Bundle subscription, log in to your Ark Media account and follow the instructions to access the Community App. If you purchased your Ark+ subscription through Apple, you'll need to purchase a separate Community subscription through the Ark Media website to gain access.</p>$A$
  ),
  (
    17,
    $C$Getting Started$C$,
    $Q$Can I listen in Spotify or another podcast app?$Q$,
    $A$<p>Yes. If you subscribe through the Ark Media website, you can listen in Spotify and many other podcast apps, including Apple Podcasts, Overcast, Pocket Casts, and more, using your private subscriber feed. Once you've connected your preferred app, you'll receive new subscriber-only and ad-free episodes there.</p>$A$
  ),
  (
    18,
    $C$Getting Started$C$,
    $Q$How do I add my Ark+ subscription to Apple Podcasts, Spotify, or another podcast app?$Q$,
    $A$<p>If you subscribed through the Ark Media website, log in to your account and access your private subscriber feeds. From there, you can connect your subscription to Apple Podcasts, Spotify, or another supported podcast app by following the setup instructions provided.</p>$A$
  ),
  (
    19,
    $C$Getting Started$C$,
    $Q$I subscribed to Ark+ on the website. When I open Apple Podcasts, it says I'm not subscribed.$Q$,
    $A$<p>If you're an Ark+ member who subscribed through our website or a previous Insider, your premium content lives in a separate, private feed, not the public feeds you see in Apple Podcasts.</p><p>That's why those public show pages may say you're not subscribed, they're not connected to your paid subscription. To listen ad-free, log into your subscription on our website and add the specific ad-free or exclusive content feed to your preferred app. Once set up, add it to your favorites so it updates automatically.</p>$A$
  ),
  (
    20,
    $C$Getting Started$C$,
    $Q$Why can't I see subscriber-only episodes?$Q$,
    $A$<p>If you're an Ark+ subscriber but don't see subscriber-only or ad-free episodes, make sure you're listening through your private subscriber feed rather than the public podcast feed. If you're still having trouble, contact <a href="mailto:support@arkmedia.org">support@arkmedia.org</a>, and we'll be happy to help.</p>$A$
  ),
  (
    21,
    $C$Getting Started$C$,
    $Q$I swear I'm subscribed on Spotify/Overcast/etc.$Q$,
    $A$<p>You're probably listening there, but at the moment, there are only a few platforms where you can actually pay for and manage an Ark+ subscription: Apple Podcasts and our website.</p><p>What can be confusing is that you can listen to your private, ad-free feeds on other apps (like Spotify, Overcast, Pocket Casts, etc.) after subscribing, but those apps are not where you're being billed.</p><p>In most cases, if you're listening on a different app, your subscription is actually purchased and billed through Ark Media, then connected to your listening app via a private RSS feed. So if you're paying through a different platform but listening on Spotify, check the platforms listed above, or look for the charge on your bank statement.</p>$A$
  ),
  (
    22,
    $C$Getting Started$C$,
    $Q$I got a new phone. Do I need to set up my subscription again?$Q$,
    $A$<p>You shouldn't have to. But if you don't see it, simply log in to your Ark Media account on your new device via the website and reconnect your preferred podcast app if needed. Your subscription will remain active.</p>$A$
  ),

  -- Section 5 — Account & Billing
  (
    23,
    $C$Account & Billing$C$,
    $Q$How do I know where I'm subscribed?$Q$,
    $A$<p><strong>Ark Media website:</strong> Go to arkmedia.org, log in with your email address, and click "Manage Subscription." If you can log in and see an active plan, you're subscribed via Supporting Cast. For support, contact us or email <a href="mailto:support@arkmedia.org">support@arkmedia.org</a>.</p><p><strong>Apple Podcasts:</strong> Open the Apple Podcasts app, tap your profile icon (top right), tap "Subscriptions," and look for Ark Media / Ark+. For issues, use the Apple Podcasts subscription help form.</p><p>If you're still unsure, check your credit card statement for the charge.</p>$A$
  ),
  (
    24,
    $C$Account & Billing$C$,
    $Q$Can I log into the website if I subscribed through Apple?$Q$,
    $A$<p>Due to Apple's privacy policy, we don't have access to Apple's customer data so you won't have a log in to this website. If you'd like to access the paid newsletter and community app, please subscribe to the Community membership. For all technical issues on Apple's platform, please contact Apple Support directly.</p>$A$
  ),
  (
    25,
    $C$Account & Billing$C$,
    $Q$Can I pay through Spotify?$Q$,
    $A$<p>No, Spotify doesn't currently support purchasing Ark+ subscriptions. If you'd like to listen in Spotify, subscribe through the Ark Media website, then connect your private subscriber feed to Spotify.</p>$A$
  ),
  (
    26,
    $C$Account & Billing$C$,
    $Q$Can I switch my subscription to Apple and keep Community access?$Q$,
    $A$<p>If you switch from paying through our website to Apple Podcasts, you'll lose access to the community app and everything that comes with it. If you'd like to regain access, you'll have to purchase the separate Community subscription.</p>$A$
  ),
  (
    27,
    $C$Account & Billing$C$,
    $Q$Can I switch from monthly to annual billing?$Q$,
    $A$<p>Yes. If annual billing is available for your subscription, you can switch from a monthly to an annual plan through your subscription management page. Your new billing schedule will take effect according to your platform's billing policies.</p>$A$
  ),
  (
    28,
    $C$Account & Billing$C$,
    $Q$Can I upgrade to the Bundle?$Q$,
    $A$<p>Yes. If you already have an Ark+ or Community subscription through the Ark Media website, you can upgrade to the Bundle at any time to receive both podcast and community benefits at the bundled price.</p>$A$
  ),
  (
    29,
    $C$Account & Billing$C$,
    $Q$How do I change my payment method?$Q$,
    $A$<p><strong>Ark Media Website:</strong> Click the profile icon, select "Manage Subscription," go to "Plan and billing," then choose "Manage Subscription."</p><p><strong>Apple:</strong> Open the Apple Podcasts app, click the profile icon, select "Manage Subscriptions," then click "Ark+".</p>$A$
  ),
  (
    30,
    $C$Account & Billing$C$,
    $Q$Can I move my subscription from Apple to the Ark Media website?$Q$,
    $A$<p>Because Apple and our website manage subscriptions separately, subscriptions can't be transferred between platforms. If you'd like to switch, you'll need to cancel your Apple subscription and subscribe through the Ark Media website after your current billing period ends.</p>$A$
  ),
  (
    31,
    $C$Account & Billing$C$,
    $Q$Can I cancel my subscription at any time?$Q$,
    $A$<p>You can cancel at any time. Your access will continue until the end of your current billing period, after which your subscription will not renew.</p>$A$
  ),
  (
    32,
    $C$Account & Billing$C$,
    $Q$I forgot which email address I used to subscribe.$Q$,
    $A$<p>If you're unable to log in or aren't sure which email address you used, please contact us at <a href="mailto:support@arkmedia.org">support@arkmedia.org</a>, and we'll help you locate your subscription.</p>$A$
  ),
  (
    33,
    $C$Account & Billing$C$,
    $Q$Who do I contact for billing or technical support?$Q$,
    $A$<p><strong>Ark Media:</strong> email <a href="mailto:support@arkmedia.org">support@arkmedia.org</a></p><p><strong>Apple:</strong> for billing questions, visit <a href="https://support.apple.com/billing" target="_blank" rel="noopener noreferrer">support.apple.com/billing</a>; for tech issues, visit <a href="https://support.apple.com/en-us/106932" target="_blank" rel="noopener noreferrer">support.apple.com/en-us/106932</a>.</p>$A$
  );
