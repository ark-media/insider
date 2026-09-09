<!-- Source of truth for Ark-Media-Website-Copy.docx (repo root). Extracted from the live code on 2026-07-30.
     Conventions: '# ' = page group (purple tab heading in the docx), '## Page   /route' = page,
     '### ' = on-page section, '- **LABEL**: copy' = one editable string, '> ' = context note.
     {curly braces} are runtime values. Excludes external content: Simplecast episodes, Circle feed,
     FAQ answers, job listings, and newsletter posts. -->

# Home & Shared Site Elements

## Home   /
### Hero (home)
- **HEADLINE (LINE 1)**: Connecting Jewish Voices, ("Voices" rendered in the cyan accent color)
- **HEADLINE (LINE 2)**: Near and Far.
- **BODY**: Ark Media is a podcast network that explores the big questions shaping Jewish life, Israel's future, and our rapidly changing world. Through conversations with leading Jewish thinkers from around the world, Ark Media aims to build a global community driven by curiosity and meaningful dialogue.
- **PRIMARY CTA (NON-SUBSCRIBER)**: Become an Ark+ member →
- **PRIMARY CTA (SUBSCRIBER)**: Explore the Fold →

### Latest Episodes (home section)
- **SECTION HEADING**: Latest episodes
- **LOADING**: Loading episodes…
- **ERROR MESSAGE**: We couldn't load the latest episodes. Refresh to try again.
- **NEW ROW BADGE**: New
- **CARD CTA**: Play episode
> Episode dates, show names, and episode titles come from Simplecast at runtime.

### Podcasts row
- **EYEBROW**: Podcasts
- **HEADING**: Four shows.
- **LINK (DESKTOP ONLY)**: All podcasts →
- **CARD CTA (EACH SHOW CARD)**: Visit show →
> Card titles and taglines come from the show data (see Podcasts & Shows); descriptions are fetched at runtime.

### Feature band — Newsletter
- **EYEBROW**: Newsletter
- **TITLE**: In your inbox.
- **BODY**: Subscribe to our newsletter and get new episodes every Friday.
- **CTA (MEMBER ALREADY SUBSCRIBED)**: Read newsletters →
> Guests / non-subscribers see the inline newsletter signup form instead (see Newsletter signup form below).

### Newsletter visual (illustrative mock)
- **MASTHEAD EYEBROW**: The Ark Media Newsletter
- **MASTHEAD TITLE**: Ark Media
- **ISSUE DATE FALLBACK**: Weekly dispatch
- **ISSUE TITLE FALLBACK**: This week from Ark Media
- **ISSUE EXCERPT FALLBACK**: The through-lines from this week's interviews — and what they tell us about the week ahead.
- **READ CTA**: Read the issue →
- **EMAIL FOOTER**: You're reading the free weekly edition · Unsubscribe

### Feature band — The Fold
- **EYEBROW**: The Fold
- **TITLE**: In the room.
- **BODY**: Nadav, Amit and Tal in conversation with members — in the Fold.
- **CTA**: Learn more →

### Fold visual (illustrative mock)
- **APP EYEBROW**: The Fold
- **APP TITLE**: In the room
- **SECTION LABEL**: Live & upcoming
- **FORMAT LABEL FALLBACK**: Live room
- **FORMAT LABEL (PER EVENT TYPE)**: Audio room / Video AMA / Watch party / In person
- **BADGE (LIVE EVENT)**: Live
- **BADGE (UPCOMING EVENT)**: Upcoming
- **EVENT TITLE FALLBACK**: Live Q&A with the hosts
- **EVENT TIME FALLBACK**: This week
- **EVENT CTA (LIVE)**: Join now
- **EVENT CTA (UPCOMING)**: RSVP
- **SECTION LABEL**: From the Fold
- **SAMPLE POST AUTHOR**: Dan Senor
- **SAMPLE POST BODY**: Thanks for all the questions on tonight's vote — recording the bonus segment now.

### Feature band — Ark+
- **EYEBROW**: Ark+
- **TITLE**: All in.
- **BODY**: The paid feed and members-only newsletters. Add the Fold, or get both in the bundle.
- **CTA**: Explore Ark+ →

### Ark+ visual (illustrative mock)
- **EYEBROW**: Ark+ membership
- **HEADING**: Everything, included.
- **CHECKLIST ITEM**: The ad-free paid feed
- **CHECKLIST ITEM**: Members-only newsletters
- **CHECKLIST ITEM**: The full network, ad-free

### Gift confirmation toast (after a gift purchase)
- **TOAST MESSAGE**: Gift sent — we emailed your recipient a link to start their membership.

## Public Masthead (shared site header & nav)
### Primary nav (desktop and mobile drawer)
- **NAV ITEM**: Podcasts
- **NAV DROPDOWN ITEM (PODCASTS)**: All
> The rest of the Podcasts dropdown lists show titles and cadence lines from the show data.
- **BADGE (PAID SHOWS IN PODCASTS DROPDOWN)**: Ark+
- **NAV ITEM**: The Fold
- **NAV ITEM**: Newsletters
- **NAV ITEM**: Book Club
- **NAV ITEM (HIDDEN FOR FULL-BUNDLE MEMBERS)**: Subscribe
- **NAV DROPDOWN ITEM (SUBSCRIBE)**: Membership
- **NAV DROPDOWN ITEM (SUBSCRIBE)**: Gift
- **NAV ITEM (FULL-BUNDLE MEMBERS ONLY)**: Gift
- **NAV ITEM**: About
- **NAV DROPDOWN ITEM (ABOUT)**: Careers
- **NAV DROPDOWN ITEM (ABOUT)**: Get in touch
- **NAV ITEM (ADMINS ONLY)**: Admin

### Auth / account controls
- **BUTTON (SIGNED-IN, DESKTOP)**: Account
- **BUTTON (SIGNED-OUT, DESKTOP)**: Sign in
- **CTA (SIGNED-OUT/FREE, MOBILE TOP BAR + DRAWER)**: Join Ark+
- **DRAWER HEADER EYEBROW (MOBILE)**: Menu
- **LINK (SIGNED-IN, MOBILE DRAWER)**: Account
- **BUTTON (SIGNED-OUT, MOBILE DRAWER)**: Sign up
- **BUTTON (SIGNED-OUT, MOBILE DRAWER)**: Sign in

### Account dropdown (signed-in)
- **EYEBROW**: Signed in
- **TEXT**: {email} (the member's email address)
- **LINK**: Account settings
- **LINK (PAID SUBSCRIBER)**: Set up your feed
- **LINK (ADMIN)**: Admin
- **BUTTON**: Sign out

## Footer (shared)
### Tagline
- **TAGLINE (LINE 1)**: Connecting Jewish Voices, ("Voices" rendered in the cyan accent color)
- **TAGLINE (LINE 2)**: Near and Far.

### Link columns
- **COLUMN TITLE**: Podcasts
- **LINKS**: Call Me Back / Ark News Daily / For Heaven's Sake / Chosen People Problems / All podcasts
- **COLUMN TITLE**: Read
- **LINKS**: Newsletters / Hosts / About / Israel Votes
- **COLUMN TITLE**: Connect
- **LINKS**: The Fold / Contact / Careers
- **COLUMN TITLE**: Ark+
- **LINKS**: Become a member / Pricing / Gift Ark+ / FAQ

### Legal row
- **COPYRIGHT**: © {year} Ark Media LLC (year = current year)
- **AFFILIATE DISCLOSURE**: As an Amazon Associate, Ark Media earns from qualifying purchases.

## Help widget (floating, shared)
Floating launcher on every public page (hidden in the back office). Not an AI
chatbot — it searches the published FAQs and routes to the right place, and the
destinations change with what the member owns. Topic copy lives in
`src/data/supportTopics.ts`; the answers themselves are the FAQ entries, edited
in the back office, not here.

### Launcher & panel chrome
- **LAUNCHER (CLOSED)**: Help
- **LAUNCHER (OPEN)**: Close
- **PANEL TITLE**: Help.
- **PANEL SUBTITLE**: Answers to the usual questions.
- **CLOSE BUTTON (ARIA)**: Close help
- **SEARCH LABEL (SCREEN READER)**: Search the help answers
- **PLACEHOLDER (SEARCH)**: Ask a question
- **PLACEHOLDER (LOADING)**: Loading answers…
- **BACK BUTTON**: ← All topics
- **ESCALATION BUTTON**: Talk to a person

### Result states
- **PROMPT (NOTHING TYPED)**: Search the answers, or pick a topic.
- **HEADING (CONFIDENT MATCH)**: This should answer it
- **HEADING (WEAK MATCH)**: These might help
- **HEADING (RELATED TOPICS)**: Go straight to
- **HEADING (TOPIC'S OWN FAQS)**: Related answers
- **NO MATCH**: I couldn't find an answer for that.
- **KNOWN GAP**: falls back to the matched topic's blurb, or — **That one needs a person.**
- **TOPIC RETIRED**: That topic has moved.
- **ERROR (ANSWERS DIDN'T LOAD)**: The answers didn't load. Browse the topics below, or try again.
- **RETRY BUTTON**: Try again

### Handoff to /contact
Escalating preselects the **Membership and technical support** desk and prefills
the message with a short summary — never a verbatim log. The member edits it
before sending.
- **TRANSCRIPT HEADER**: — From the help widget —
- **TRANSCRIPT LINE**: Looking at: “{topic}”
- **TRANSCRIPT LINE**: Looked for: “{query}”
- **TRANSCRIPT LINE**: Read: “{question}”
- **TRANSCRIPT LINE**: Found no answer for: “{query}”
- **TRANSCRIPT OVERFLOW**: (+{n} more)

### Topics
Each is a chip on the panel's home screen unless marked otherwise; the rest are
reachable by typing. Buttons are listed across every membership state, so a
single member only ever sees some of them.
#### What's included, and what it costs
- **CHIP**: What's included, and what it costs
- **BLURB**: The three subscriptions, what each one gets you, and the price.
- **BUTTON**: Compare the plans
- **BUTTON**: See your membership

#### How much it costs *(search only — not a chip)*
- **CHIP**: How much it costs
- **BLURB**: Prices for each subscription, monthly and annual.
- **BUTTON**: See the prices

#### Set up my podcast feed
- **CHIP**: Set up my podcast feed
- **BLURB**: Get subscriber episodes into Apple Podcasts, Spotify, or wherever you listen.
- **BUTTON**: Sign in to set up your feed
- **BUTTON**: See what Ark+ includes
- **BUTTON**: Open feed setup
- *(shown only to: signed out, Ark+, Bundle)*

#### Episodes aren't showing up
- **CHIP**: Episodes aren't showing up
- **BLURB**: Subscriber episodes missing, still hearing ads, or a locked episode.
- **NOTE**: If you subscribed through Apple Podcasts, you won't have a login here — Apple keeps those subscriptions entirely on their side, and you manage them in Apple's Settings. If you subscribed on our website, sign in and it'll all be on your account page.
- **BUTTON**: See what Ark+ includes
- **NOTE**: Almost always one of three things: you're signed in with a different email than you subscribed with, the private feed hasn't been added to your podcast app yet, or the app hasn't refreshed. Feed setup walks through all three.
- **BUTTON**: Open feed setup
- *(shown only to: signed out, Ark+, Bundle)*

#### Listening on Spotify
- **CHIP**: Listening on Spotify
- **BLURB**: Linking your Spotify account, and why it asks.
- **BUTTON**: See what Ark+ includes
- **BUTTON**: Link Spotify

#### I subscribed through Apple
- **CHIP**: I subscribed through Apple
- **BLURB**: What's different, and where to manage an Apple subscription.
- **BUTTON**: Manage an Apple subscription
- **BUTTON**: Send us a message

#### The Fold
- **CHIP**: The Fold
- **BLURB**: Getting in, and what's inside.
- **BUTTON**: See what's inside
- **BUTTON**: Add the Fold
- **BUTTON**: Open the Fold
- **BUTTON**: Open in the app

#### Newsletters & emails
- **CHIP**: Newsletters & emails
- **BLURB**: Which newsletters you get, and how to change that.
- **BUTTON**: See the newsletters
- **BUTTON**: Manage your newsletters

#### Billing & payment
- **CHIP**: Billing & payment
- **BLURB**: Where you're subscribed, and what you're paying.
- **NOTE**: If you subscribed through Apple Podcasts, you won't have a login here — Apple keeps those subscriptions entirely on their side, and you manage them in Apple's Settings. If you subscribed on our website, sign in and it'll all be on your account page.
- **BUTTON**: Sign in
- **BUTTON**: See the plans
- **BUTTON**: Open billing
- *(shown only to: signed out, Ark+, the Fold, Bundle)*

#### Cancel or change my plan
- **CHIP**: Cancel or change my plan
- **BLURB**: Cancel, switch billing period, or move between plans.
- **NOTE**: If you subscribed through Apple Podcasts, you won't have a login here — Apple keeps those subscriptions entirely on their side, and you manage them in Apple's Settings. If you subscribed on our website, sign in and it'll all be on your account page.
- **BUTTON**: Send us a message
- **BUTTON**: Manage your membership
- *(shown only to: signed out, Ark+, the Fold, Bundle)*

#### Add the other half of the Bundle
- **CHIP**: Add the other half of the Bundle
- **BLURB**: You have one side — here's how to add the other.
- **BUTTON**: Change your plan
- **BUTTON**: Compare the plans
- *(shown only to: Ark+, the Fold)*

#### I can't log in
- **CHIP**: I can't log in
- **BLURB**: Sign-in trouble, or you're not sure which email you used.
- **BUTTON**: Try signing in
- **NOTE**: If you subscribed through Apple Podcasts, you won't have a login here — Apple keeps those subscriptions entirely on their side, and you manage them in Apple's Settings. If you subscribed on our website, sign in and it'll all be on your account page.
- **BUTTON**: Email support instead
- *(shown only to: signed out)*

#### I subscribed to Inside Call Me Back
- **CHIP**: I subscribed to Inside Call Me Back
- **BLURB**: What changed when Inside Call Me Back became Ark+.
- **BUTTON**: Sign in to check
- **BUTTON**: Send us a message
- **BUTTON**: Check your feed setup

#### Gift a subscription
- **CHIP**: Gift a subscription
- **BLURB**: Buy Ark+, the Fold, or the Bundle for someone else.
- **BUTTON**: Gift a subscription

#### I received a gift *(search only — not a chip)*
- **CHIP**: I received a gift
- **BLURB**: Claim a gifted subscription.
- **NOTE**: Your gift email has a link that signs you in and sets everything up. If you can't find it, check spam — and if it's expired, send us a message and we'll reissue it.
- **BUTTON**: Claim a gift
- **BUTTON**: Send us a message

#### A refund or a charge I don't recognise *(search only — not a chip)*
- **CHIP**: A refund or a charge I don't recognise
- **BLURB**: We'll need to look at your account for this one.
- **BUTTON**: Send us a message

#### A receipt or invoice *(search only — not a chip)*
- **CHIP**: A receipt or invoice
- **BLURB**: We can send one over.
- **BUTTON**: Send us a message

#### Change the email on my subscription *(search only — not a chip)*
- **CHIP**: Change the email on my subscription
- **BLURB**: We'll move it for you.
- **BUTTON**: Send us a message

#### A promo or discount code *(search only — not a chip)*
- **CHIP**: A promo or discount code
- **BLURB**: Codes go in at checkout.
- **NOTE**: There's a box for it on the payment step when you subscribe.
- **BUTTON**: Go to checkout
- **BUTTON**: The code isn't working

#### A free trial *(search only — not a chip)*
- **CHIP**: A free trial
- **BLURB**: There isn't one — but you can cancel any time.
- **NOTE**: We don't run free trials, but nothing is locked in — you can cancel whenever and keep access to the end of what you've paid for.
- **BUTTON**: See the plans

#### Delete my account or data *(search only — not a chip)*
- **CHIP**: Delete my account or data
- **BLURB**: A person handles this one.
- **BUTTON**: Read the privacy policy
- **BUTTON**: Send us a message

## Newsletter signup form (shared)
- **INPUT PLACEHOLDER**: Email
- **SUBMIT CTA**: Subscribe
- **SUBMIT CTA (SUCCESS)**: Subscribed
- **SUCCESS MESSAGE**: You're on the list.
- **ERROR MESSAGE (FALLBACK)**: Could not subscribe. (the server may supply a more specific error instead)

## Shared UI states & small screens
### Skip link (root layout, visible on keyboard focus)
- **SKIP LINK**: Skip to main content

### Content error card (shared)
- **EYEBROW**: Something went wrong
- **MESSAGE (DEFAULT)**: We couldn't load this right now.
- **BUTTON**: ↻ Refresh

### Status page (404 / not-authorized shell)
- **DEFAULT ACTION LINK**: ← Back to homepage
> The eyebrow, title, and message are supplied by each page that uses this shell.

### Toast (shared)
- **LABEL**: Confirmed
> The toast body message is supplied by the caller.

### Auth error banner
- **ERROR (SESSION EXPIRED)**: Your sign-in session expired. Please try signing in again.
- **ERROR (SIGN-IN DIDN'T COMPLETE)**: Sign-in didn't complete. Please try again.
- **ERROR (PROFILE)**: We couldn't verify your account. Please try again.
- **ERROR (ACCOUNT DENIED)**: This account isn't authorized to sign in to Ark+. If you think this is a mistake, contact support@arkmedia.org.
- **DISMISS BUTTON**: ×

### Page shell placeholder
- **PLACEHOLDER SECTION BODY (DEFAULT)**: Content for this section is on the way.

### Logout   /logout
- **STATUS TEXT**: Signing out…

### Preview password gate (preview builds only)
- **EYEBROW**: Preview access
- **HEADING**: Insider is in testing
- **BODY**: Enter the team password to continue.
- **INPUT PLACEHOLDER**: Password
- **ERROR**: Incorrect password.
- **BUTTON**: Continue
# Podcasts & Shows

## Podcasts (index)   /podcasts
### Page header
- **TITLE**: Four shows. One newsroom.
- **LEDE**: Long-form interviews, fast briefs, and ongoing conversations on the questions that matter.

### Show grid (one card per show)
- **BADGE (PAID SHOW ONLY)**: Ark+
- **CARD LINK**: Visit show →
> Card titles come from the show data below; descriptions are the live Simplecast descriptions, falling back to the taglines below.

### Ark+ callout under the grid (non-members / signed-out only)
- **LABEL**: Ark+
- **BODY**: Ad-free episodes, extended interviews, members-only Q&As, and the members letter — across every show above.
- **CTA**: Become an Ark+ member →

## Show page (template)   /podcasts/call-me-back etc.
### Show hero
- **BREADCRUMBS**: Home / Podcasts / {show short title}
- **HOSTS LINE**: with {host names, joined by " · "}
> The show title and description come from the show data below (description falls back to the tagline).

### Ark+ upsell in hero (free shows, non-members only)
- **LABEL**: Want more?
- **BODY**: Ark+ members get the members-only newsletter and the ad-free Call Me Back Ark+ feed — add the Fold, or get both in the bundle.
- **CTA**: Join Ark+ →

### Ark+ members-only gate (paid shows, non-members — replaces the episode browser)
- **LABEL**: Ark+ members only
- **HEADING**: Join Ark+ to listen to {show title}.
- **BODY**: Members get extended interviews, ad-free episodes, members-only Q&As, the Ark+ newsletter, and the Fold.
- **CARD LABEL**: Get Ark+
- **CARD BODY**: Full access to {show title} plus everything else in Ark+.
- **CARD BUTTON**: See Ark+ membership →

### Paid-show member header link (paid shows, members)
- **LINK**: Set up private feed →

### In-page player (top of episode browser)
- **LABEL (LATEST EPISODE SELECTED)**: Latest episode
- **LABEL (OTHER EPISODE SELECTED)**: Now playing
- **BADGE (LATEST EPISODE)**: New
- **META LINE**: {date} · {duration}
- **LINK**: View episode →

### Episode browser
- **SECTION LABEL (PLAYER PRESENT)**: More episodes
- **SECTION LABEL (NO PLAYABLE EPISODE)**: Latest episodes
- **SEARCH PLACEHOLDER**: Search episodes
- **ERROR**: We couldn't load episodes. Refresh to try again.
- **LOADING**: Loading episodes…
- **EMPTY (ONE EPISODE EXISTS)**: That's the only episode so far — more coming soon.
- **EMPTY (NO EPISODES)**: No episodes yet — check back soon.

### Episode search results
- **RESULTS LABEL**: {count} result for “{query}” / {count} results for “{query}” (singular/plural)
- **EMPTY**: No episodes match “{query}”.

### Episode cards (latest three)
- **BADGE (CURRENTLY PLAYING)**: Now playing
- **GUESTS LINE**: With {guest names, joined by ", "}
- **BUTTON**: Play
- **LINK**: View episode →

### Episode archive list
- **LIST LABEL**: All episodes
- **EMPTY**: No episodes.
- **SHOW MORE BUTTON**: Show more episodes ↓

### People sections
- **SECTION LABEL (HOSTS)**: Hosts
- **SECTION LABEL (CONTRIBUTORS)**: Contributors
> Names, roles, and bios come from the host data (see About, Hosts & Company Pages).

### Show-not-found fallback (unknown show link)
- **TITLE**: Show not found
- **LEDE**: We couldn't find that show.
- **PLACEHOLDER TITLE**: Looking for a show?
- **PLACEHOLDER BODY**: Browse all of our podcasts from the hub.

## Episode page   /podcasts/{show}/{episode}
### Player area
- **PLAYER FALLBACK LABEL (NO EMBEDDED PLAYER)**: Listen
- **PLAYER FALLBACK BODY**: This episode isn't available in our embedded player yet. Listen through your podcast app of choice.

### Ark+ members-only gate (paid episodes, replaces the player)
- **LABEL**: Ark+ members only
- **BODY**: This episode is part of Call Me Back AMA. Join Ark+ to listen.
- **CTA**: Become an Ark+ member →

### Show notes
- **HEADING**: Show notes
- **EMPTY STATE**: Show notes for this episode aren't published yet. The summary above is the full description for now.

### Episode sidebar
- **LABEL**: From the show
- **LABEL**: New episodes
- **HEADING (IF SHOW HAS LISTEN LINKS)**: Subscribe
> Sidebar show title, tagline, and cadence come from the show data below.

### Back link (bottom of page)
- **LINK**: ← All {show short title} episodes

### Episode not found
- **HEADLINE**: We couldn't find that episode.
- **BODY**: The link may have changed, or the episode hasn't been published yet. Head back to the show for the full archive.
- **CTA**: ← Back to {show title}

## Show data (src/data/shows.ts — used site-wide)
### Call Me Back
- **TITLE**: Call Me Back
- **TAGLINE / DESCRIPTION**: Call Me Back un-breaks the news affecting the Jewish world, focusing on the structural forces shaping life in Israel and the diaspora.
- **HOSTS**: Dan Senor
- **CADENCE**: New episodes Sundays and Thursdays

### For Heaven's Sake
- **TITLE**: For Heaven's Sake
- **TAGLINE / DESCRIPTION**: Donniel Hartman and Yossi Klein Halevi engage in the Jewish tradition of constructive disagreement about Israel, world Jewry, and the future of Zionism.
- **HOSTS**: Donniel Hartman, Yossi Klein Halevi
- **CADENCE**: Weekly

### Ark News Daily
- **TITLE**: Ark News Daily
- **TAGLINE / DESCRIPTION**: Every morning, Ark Media gives you the latest updates on the war in Iran and how they impact the Middle East, geopolitics, and Jews around the world.
- **HOSTS**: Ark Media newsroom
- **CADENCE**: Weekdays

### Call Me Back AMA (currently commented out in code — not live)
- **TITLE**: Call Me Back AMA
- **SHORT TITLE**: CMB AMA
- **TAGLINE**: Presenting the challenges and dilemmas facing Israelis to a global audience.
- **DESCRIPTION**: Long-form interviews, unedited extras, and Q&As reserved for Ark+ members. Delivered as a private, ad-free feed in the podcast app you already use.
- **HOSTS**: Dan Senor
- **CADENCE**: New episodes weekly

### Listen-platform chip labels
- **LABELS**: Apple Podcasts / Spotify / Overcast / Pocket Casts / YouTube

### Next-drop labels (masthead live-status strip)
- **RELATIVE (WITHIN ~1 HOUR)**: Today
- **RELATIVE (LATER TODAY)**: Today · {hour}am ET
- **RELATIVE (NEXT DAY)**: Tomorrow
- **RELATIVE (2+ DAYS OUT)**: {weekday name}

## Generated artwork (fallback covers)
### Show cover fallback (shows without uploaded art)
- **EYEBROW**: {show short title}
- **DISPLAY TITLE**: {show title}

### Ark News Daily generated cover
- **WORDMARK LINE 1**: Ark NEWS
- **WORDMARK LINE 2**: DAILY
- **ENDORSEMENT LABEL**: Ark Media

## Date & duration formats (shared helpers)
- **DATE (SHORT)**: {Mon D, YYYY} (e.g. "Jul 30, 2026")
- **DATE (LONG)**: {Month D, YYYY} (e.g. "July 30, 2026")
- **DURATION (UNDER AN HOUR)**: {minutes} min
- **DURATION (WHOLE HOURS)**: {h} hr
- **DURATION (HOURS + MINUTES)**: {h} hr {m} min
# Ark+ Membership, Pricing & Checkout

## Ark+ (membership)   /plus
### Hero — guest / free member
- **EYEBROW**: Ark+
- **HEADLINE**: The full Ark Media experience. ("experience." in the cyan accent)
- **LEAD**: Ark+ is our premium membership, offering ad-free podcasts, unlimited access to all written content, and full access to the Fold.
- **BULLET**: Call Me Back AMA — extended interviews, ad-free
- **BULLET**: Members-only newsletters — sharper analysis, weekly
- **BULLET**: The Fold — join the hosts and other members in the room
- **BULLET**: Live events and Q&As
- **BULLET**: Early access to new shows
- **PRIMARY CTA**: Become a member
- **GIFT LINK**: Gift Ark+
- **LOGO MARK SUBTITLE**: Membership
- **MEMBER BADGE LABEL**: Ark+ Member
- **MEMBER BADGE NUMBER**: No. 00214

### Hero — Ark+ member without the Fold ("add the Fold")
- **EYEBROW**: The Fold
- **HEADLINE**: You have the feed. Now join the Fold. ("the Fold." in the cyan accent)
- **LEAD**: You already get Call Me Back AMA ad-free and the members-only newsletters. Add the Fold — conversations with the hosts, live member events, and Dan's book club.
- **BULLET**: The Fold — talk with the hosts and fellow members
- **BULLET**: Live member events and Q&As
- **BULLET**: Dan's book club
- **BULLET**: Exclusive members-only spaces
- **PRIMARY CTA**: Add the Fold
- **GIFT LINK**: Gift a membership
- **LOGO MARK SUBTITLE**: The Fold
- **MEMBER BADGE LABEL**: Ark+ Member
- **MEMBER BADGE VALUE**: Add the Fold

### Hero — Fold member without Ark+ ("add Ark+")
- **EYEBROW**: Ark+
- **HEADLINE**: You're in the room. Now go ad-free. ("ad-free." in the cyan accent)
- **LEAD**: You're already part of the Fold. Add Ark+ — Call Me Back AMA as a private, ad-free feed, the full network ad-free, and the members-only newsletters.
- **BULLET**: Call Me Back AMA — private, ad-free feed
- **BULLET**: The full Ark Media network, ad-free
- **BULLET**: Members-only newsletters — sharper analysis, weekly
- **BULLET**: Early access to new shows
- **PRIMARY CTA**: Add Ark+
- **GIFT LINK**: Gift a membership
- **LOGO MARK SUBTITLE**: Membership
- **MEMBER BADGE LABEL**: Fold Member
- **MEMBER BADGE VALUE**: Add Ark+

### Hero — full bundle member
- **EYEBROW**: Membership
- **HEADLINE**: You have the full Ark Media experience. ("experience." in the cyan accent)
- **LEAD**: You have Ark+ and the Fold — the private, ad-free feed, the members-only newsletters, and the Fold in full. Thank you for being a member.
- **BULLET**: Call Me Back AMA — private, ad-free feed
- **BULLET**: Members-only newsletters
- **BULLET**: The Fold, live events, and Dan's book club
- **PRIMARY CTA**: Manage your membership
- **GIFT LINK**: Gift a membership
- **LOGO MARK SUBTITLE**: Full member
- **MEMBER BADGE LABEL**: Full Member
- **MEMBER BADGE NUMBER**: No. 00214

### Pricing section intro
- **HEADING**: Pick your own terms. ("terms." in the cyan accent)
- **BODY**: Every plan is pay-what-you-choose — name the suggested amount or give more to help sustain independent Jewish media.

### Pricing cards (three-tier grid)
- **FEATURED BADGE (BUNDLE CARD)**: Best value
- **PRICE LINE (ANNUAL)**: From {price} / year (price from Stripe)
- **PRICE LINE (MONTHLY)**: From {price} / month
- **BILLING NOTE (ANNUAL)**: Billed annually
- **BILLING NOTE (MONTHLY)**: Billed monthly
- **SAVINGS NOTE (ANNUAL)**: · Save {percent}%
- **PWYC NOTE**: Pay what you choose at checkout — give more to sustain independent Jewish media.
- **CTA (ANNUAL)**: Subscribe annually →
- **CTA (MONTHLY)**: Subscribe monthly →
- **ERROR MESSAGE**: We couldn't load pricing right now. Refresh to try again.
- **COMPARE LINK**: Compare all plans →
- **FULL-ACCESS BODY (MEMBER OWNS EVERYTHING)**: You already have full access — Ark+ and the Fold.
- **FULL-ACCESS LINK**: Manage your membership →

### Billing period toggle
- **OPTION**: Monthly
- **OPTION**: Annual
- **SAVINGS BADGE (ANNUAL)**: −{percent}%

### Tier copy (shared by cards and comparison table)
- **TIER NAME (ARK+)**: Ark+
- **TIER BLURB (ARK+)**: Every Ark Media podcast, ad-free, plus the members-only newsletters.
- **TIER FEATURES (ARK+)**: Call Me Back AMA — private, ad-free feed / The full network, ad-free / Members-only newsletters
- **TIER NAME (BUNDLE, FEATURED)**: Ark+ & The Fold
- **TIER BLURB (BUNDLE)**: Both — the private feed and the Fold, one membership.
- **TIER FEATURES (BUNDLE)**: Call Me Back AMA — private, ad-free feed / The full network, ad-free / Members-only newsletters / The Fold / Live member events & Q&As
- **TIER NAME (FOLD)**: The Fold
- **TIER BLURB (FOLD)**: The Fold — conversations, member events, and Dan's book club.
- **TIER FEATURES (FOLD)**: The Fold / Live member events & Q&As / Dan's book club

### Why subscribe (mission pitch)
- **EYEBROW**: Why subscribe
- **HEADING**: Independent journalism, sustained by you. ("you." in the cyan accent)
- **BODY 1**: Ark Media is a dedicated place for curious minds to follow hard questions about Jewish life, Israel, and a rapidly changing world — and to fund the journalism that asks them. Your membership keeps the work free from the pressures that reshape most newsrooms: advertisers chasing clicks, platforms optimizing for outrage, owners with agendas.
- **BODY 2**: This isn’t another media brand built for the algorithm. It’s a small independent network — podcasts, writing, and community — organized around shared curiosity and the assumption that serious conversation still matters. Subscribe to get the full Ark+ experience, and to keep that work answering to its audience.

### FAQ (static heading/intro only — questions & answers come from the database)
- **HEADING**: Frequently asked. ("asked." in the cyan accent)
- **INTRO**: Everything you need to know before joining Ark+. Still stuck? Drop us a line. ("Drop us a line." links to /contact)

## Pricing (comparison)   /pricing
### Page hero
- **EYEBROW**: Membership
- **HEADLINE**: Choose your plan. ("plan." in the cyan accent)
- **BODY**: Three ways in — the private feed, the Fold, or both. Every plan is pay-what-you-choose, and you can cancel anytime.

### Comparison table
- **EYEBROW**: Compare plans
- **HEADING**: What you get with each tier
- **COLUMN HEADERS**: Ark+ / Ark+ & The Fold / The Fold
- **COLUMN BADGE (BUNDLE)**: Best value
- **PRICE LINE (ANNUAL)**: From {price} / yr
- **PRICE LINE (MONTHLY)**: From {price} / mo
- **GROUP HEADING**: Podcasts & video
- **ROW**: Ad-free podcasts
- **ROW**: Subscriber-exclusive content
- **ROW**: Early access
- **ROW**: Ad-free video episodes
- **GROUP HEADING**: The Fold & newsletters
- **ROW**: Premium access to the Fold
- **ROW**: Full access to Ark Media newsletters
- **COLUMN CTA**: Choose →

### Details (below the comparison table — expands each row)
- **EYEBROW**: Details
- **ENTRY**: Ad-free podcasts
- **ENTRY SUMMARY**: Every Ark Media show in a private feed, with the ads cut.
- **ENTRY BULLETS**: Call Me Back / Ark News Daily / For Heaven's Sake / Chosen People Problems
- **ENTRY**: Subscriber-exclusive content
- **ENTRY SUMMARY**: Episodes only members hear.
- **ENTRY BULLETS**: Call Me Back AMA — in your Call Me Back feed / Chosen People Problems AMA / Ark News Daily 6th episode
- **ENTRY**: Early access
- **ENTRY SUMMARY**: Hear it before everyone else.
- **ENTRY BULLETS**: Mid-week Call Me Back episode — Wednesdays, not Fridays / History show
- **ENTRY**: Ad-free video episodes
- **ENTRY SUMMARY**: The video editions of the shows, without the ad breaks.
- **ENTRY**: Premium access to the Fold
- **ENTRY SUMMARY**: The Fold, in full.
- **ENTRY BULLETS**: Conversations with the hosts and fellow members / Live member events & Q&As / Dan's book club / Members-only spaces
- **ENTRY**: Full access to Ark Media newsletters
- **ENTRY SUMMARY**: Both member newsletters, in your inbox.
- **ENTRY BULLETS**: Weekly roundup / Ark+ paid newsletter with Nadav's column

## Checkout modal
### Modal chrome
- **EYEBROW**: {tier label} · Annual / {tier label} · Monthly
- **TIER LABEL (ARK+)**: Ark+ Membership
- **TIER LABEL (FOLD)**: The Fold
- **TIER LABEL (BUNDLE)**: Ark+ & The Fold

### Promo banner (when a promo auto-applies)
- **BANNER**: {discount} applied automatically — {promo name}. (e.g. "20% off applied automatically — Launch promo."; without the promo name when it has none)
- **DISCOUNT TEXT (PERCENT COUPON)**: {percent}% off
- **DISCOUNT TEXT (AMOUNT COUPON)**: {amount} off
- **DISCOUNT TEXT (FALLBACK)**: a discount

### Email & amount step
- **TITLE**: Complete your membership
- **SUBHEAD (ANNUAL)**: Billed yearly. We'll send your sign-in link here.
- **SUBHEAD (MONTHLY)**: Billed monthly. We'll send your sign-in link here.
- **AMOUNT LABEL**: Choose your amount
- **AMOUNT SUFFIX**: /yr (annual) · /mo (monthly)
- **SLIDER FLOOR LABEL**: {floor price} minimum
- **PWYC HELPER**: Give more to sustain independent Jewish media.
- **PWYC HELPER (LOADING)**: Loading price…
- **FIELD LABEL**: Email
- **EMAIL PLACEHOLDER**: you@example.com
- **VALIDATION ERROR**: Please enter a valid email.
- **CTA**: Continue to payment
- **CTA (WORKING)**: Loading…
- **HELPER BELOW CTA**: You'll receive a sign-in link by email once your membership is active.

### Payment step
- **LOADING LABEL (PREPARING)**: Preparing checkout…
- **LOADING LABEL (STRIPE LOADING)**: Loading secure checkout…
- **TITLE (ANNUAL)**: {subtotal} / year
- **TITLE (MONTHLY)**: {subtotal} / month
- **WALLET DIVIDER (APPLE/GOOGLE PAY AVAILABLE)**: Or pay with card
- **TOTALS ROWS**: Subtotal / Discount / Tax / Total due today
- **PAY CTA**: Pay {total}
- **PAY CTA (WORKING)**: Processing…
- **PAYMENT ERROR (FALLBACK)**: Payment failed. Please try again.

### Activating step
- **LOADING LABEL**: Payment received — signing you in…

### Already-subscribed step
- **TITLE**: You're already a member
- **MESSAGE**: This email already has an active membership.
- **CTA**: Sign in
- **CTA**: Close

### Processing step (bank still processing)
- **TITLE**: Almost there
- **BODY**: Your payment is being processed by your bank. We'll email {email} a sign-in link as soon as it clears (usually within a few minutes).
- **CTA**: Close

### Error step
- **TITLE**: Something went wrong
- **ERROR (SESSION CREATION)**: Could not start checkout.
- **ERROR (NETWORK)**: Network error. Please try again.
- **ERROR (POLL FAILURE)**: Could not finish checkout (status {status}).
- **CTA**: Try again

## Gift Ark+   /plus/gift
### Left pitch column
- **EYEBROW**: Give a membership
- **HEADLINE**: Give the full Ark Media experience. ("experience." in the cyan accent)
- **LEAD**: Pick Ark+ for the private, ad-free feed and members-only newsletters, the Fold, or the Bundle of both. It's a one-time gift — no renewals, no surprise charges — and they'll get an email with everything they need to start.
- **BULLET**: A one-time gift — it never renews or charges again
- **BULLET**: Lands in their inbox within minutes
- **BULLET**: Encrypted, secure checkout

### Gift form — tier picker
- **SECTION LABEL**: Choose a membership
- **TIER OPTION (ARK+)**: Ark+ — Private, ad-free podcast feed
- **TIER OPTION (FOLD)**: The Fold — Access to the Fold
- **TIER OPTION (BUNDLE)**: Bundle — The private feed plus the Fold

### Gift form — length picker
- **SECTION LABEL**: Choose a length
- **TERM LABEL**: 6 months
- **TERM LABEL**: 1 year
- **PRICE (PER OPTION)**: ${price} (Ark+ $48 / $80 · The Fold $48 / $80 · Bundle $75 / $130)

### Gift form — from / to
- **SECTION LABEL**: From
- **PLACEHOLDER**: Your name (optional)
- **PLACEHOLDER**: Your email
- **SECTION LABEL**: To
- **PLACEHOLDER**: Recipient's name (optional)
- **PLACEHOLDER**: Recipient's email
- **FIELD LABEL**: Message (optional)
- **PLACEHOLDER**: Add a note for the recipient
- **CHARACTER COUNTER**: {length} / 500

### Gift form — submit
- **CTA**: Continue to payment · ${price} →
- **HELPER**: As soon as you check out, we'll email them a link to start their membership.

## Gift checkout modal
### Modal chrome
- **EYEBROW**: Gift · {tier label} · {term} (e.g. "Gift · Bundle · 1 year")
- **RECIPIENT LINE**: For {recipient name or email} (with " · {recipient email}" when a name was given)

### Steps
- **TITLE (CREATING)**: Gift membership
- **LOADING LABEL (CREATING)**: Preparing checkout…
- **CURRENCY LABEL**: Pay in
- **LOADING LABEL (STRIPE LOADING)**: Loading secure checkout…
- **TITLE (PAYMENT)**: {subtotal} · {term}
- **TOTALS ROWS**: Subtotal / Discount / Tax / Total due today
- **PAY CTA**: Pay {total} & send gift
- **PAY CTA (WORKING)**: Processing…
- **PAYMENT ERROR (FALLBACK)**: Payment failed. Please try again.
- **TITLE (ACTIVATING)**: Almost there
- **LOADING LABEL (ACTIVATING)**: Payment received — wrapping up your gift…
- **BODY (STILL PROCESSING)**: Your payment is going through. We'll email {recipient email} a link to start their membership the moment it's confirmed.
- **TITLE (ERROR)**: Something went wrong
- **ERROR (CHECKOUT UNAVAILABLE)**: Checkout is temporarily unavailable. Please try again in a moment.
- **ERROR (CREATE CHECKOUT)**: Could not start gift checkout.
- **ERROR (NETWORK)**: Network error. Please try again.
- **CTA**: Close

## Redeem a gift   /redeem
### Page hero
- **EYEBROW**: A gift for you
- **HEADLINE**: Claim your Ark+ gift. ("Ark+" in the cyan accent)

### Magic-link path (normal path from the gift email)
- **BODY**: You're one click away. Start your membership — you'll be signed in automatically, and your access runs from today and won't auto-renew.
- **CTA**: Start your Ark+ membership →
- **CTA (CLAIMING)**: Starting… →
- **CTA (RETRYABLE ERROR)**: Try again →
- **CTA (TERMINAL ERROR)**: Go to your account

### Fallback path (older token links)
- **BODY (MISSING TOKEN)**: This link is missing its gift code. Open the Start your membership button in your gift email, or reply to that email and we'll help.
- **BODY (LOADING)**: Checking your account…
- **BODY (SIGNED OUT)**: Sign in to claim your gift, then come back to this page.
- **CTA (SIGNED OUT)**: Sign in to claim →
- **BODY (SIGNED IN)**: You're signed in. Claim your gift to start your membership — your access runs from today and won't auto-renew.
- **CTA (SIGNED IN)**: Claim your gift →
- **CTA (CLAIMING)**: Claiming… →

### Success states
- **EYEBROW**: You're all set
- **BODY (GIFT ADDED AS CREDIT)**: You already have an active membership, so your gift has been added as account credit toward your future renewals.
- **BODY (SUBSCRIPTION EXTENDED)**: You already have an active subscription, so your gift has extended it — your next paid renewal is deferred by the length of the gift.
- **BODY (NEW MEMBERSHIP)**: Your Ark+ membership is active. Set up your private podcast feed and join the Fold from your welcome page.
- **CTA (CREDIT / EXTENDED)**: Go to your account →
- **CTA (NEW MEMBERSHIP)**: Get started →

### Error messages
- **ERROR (ALREADY REDEEMED)**: This gift has already been claimed.
- **ERROR (EXPIRED LINK)**: This gift link has expired. Reply to your gift email and we'll send you a fresh one.
- **ERROR (INVALID GIFT)**: We couldn't find this gift. Use the link from your gift email, or reply to it and we'll help.
- **ERROR (DEFAULT)**: Something went wrong claiming your gift. Please try again.
- **ERROR (REDEEM FALLBACK)**: Could not redeem this gift.
# About, Hosts & Company Pages

## About   /about
### Page header
- **TITLE**: Ark Media.
- **LEDE**: Ark Media is a podcast network focused on spirited debate and learning about Jewish life, Israel, the Middle East, and our larger geopolitics.

### What Ark Media does
- **SECTION HEADING**: What Ark Media does
- **BODY (MAIN COLUMN)**: Ark Media is a podcast network that explores the big questions shaping Jewish life, Israel's future, and our rapidly changing world. Through conversations with leading Jewish thinkers from around the world, Ark Media aims to build a global community driven by curiosity and meaningful dialogue.
- **BODY (SIDE COLUMN)**: The company sits behind Call Me Back with Dan Senor, For Heaven's Sake with Donniel Hartman and Yossi Klein Halevi, Ark News Daily, and an Ark+ membership that funds the work. (show names in italics)

### Link cards
- **CARD 1 EYEBROW**: Careers
- **CARD 1 TITLE**: Build Ark Media.
- **CARD 1 BODY**: We're a small team building independent journalism for an audience that wants more than a hot take. Open roles and speculative notes welcome.
- **CARD 1 CTA**: Open roles →
- **CARD 2 EYEBROW**: Get in touch
- **CARD 2 TITLE**: Press, partnerships, listener mail.
- **CARD 2 BODY**: Different addresses for different conversations — press inquiries, sponsorships, listener feedback, and member support.
- **CARD 2 CTA**: Contact us →

## Network   /about/network
### Page header
- **BREADCRUMBS**: Home / About / Network
- **TITLE**: The Ark Media network.
- **LEDE**: Every property we run, one page. Connecting Jewish voices, near and far.

### Properties cards
- **SECTION HEADING**: Properties
- **CARD 1 EYEBROW / TITLE**: Podcast network — Ark Media podcasts
- **CARD 1 BODY**: Four free shows and one members-only feed — Call Me Back, For Heaven's Sake, Ark News Daily, Chosen People Problems, and Call Me Back AMA.
- **CARD 2 EYEBROW / TITLE**: Newsroom — Newsletters
- **CARD 2 BODY**: Curated dispatches from the Ark Media newsroom. Free editions ship to anyone with an email; members-only editions ship to Ark+ subscribers.
- **CARD 3 EYEBROW / TITLE**: Members' app — The Fold
- **CARD 3 BODY**: The Fold lives in the Fold. Episode threads, live audio rooms, member meetups, and long-form posts.
- **CARD 4 EYEBROW / TITLE**: Membership — Ark+ membership
- **CARD 4 BODY**: Call Me Back AMA and members-only newsletters with Ark+; the Fold and live events with Circle. Get both in the bundle.
- **CARD CTA (ALL CARDS)**: Visit →

### Shows by name
- **SECTION HEADING**: Shows by name
- **ROW TEXT**: {show title} · {show cadence} (from the show data)
- **ROW SUFFIX (PAID SHOWS ONLY)**: · Ark+ only

## Hosts (index)   /hosts
### Page header
- **TITLE**: The bylines.
- **LEDE**: The hosts and contributors behind Ark Media.

### People grids
- **GROUP EYEBROW**: Hosts
- **GROUP EYEBROW (IF CONTRIBUTORS EXIST)**: Contributors
> Names and short bios come from the host data below.

## Host detail (template)   /hosts/{slug}
- **BREADCRUMBS**: Home / Hosts / {host name}
- **TITLE / LEDE**: {host name} / {host role}
- **SECTION EYEBROW**: Bio
- **SECTION EYEBROW (IF HOST HAS SHOWS)**: Shows
- **SHOW CARD CTA**: Visit show →

## Host data (src/data/hosts.ts)
### Dan Senor
- **ROLE**: Host, Call Me Back
- **SHORT BIO**: Author of The Genius of Israel and Start-Up Nation. Former foreign policy advisor.
- **LONG BIO**: Dan Senor is the host of Call Me Back and Call Me Back AMA. He is the co-author of The Genius of Israel (2023) and Start-Up Nation (2009), and previously served as a senior foreign policy advisor in two White Houses. He writes and speaks regularly on the structural forces shaping Israel and the diaspora.

### Donniel Hartman
- **ROLE**: Host, For Heaven's Sake
- **SHORT BIO**: President of the Shalom Hartman Institute. Modern Orthodox rabbi, philosopher, author.
- **LONG BIO**: Rabbi Donniel Hartman is the President of the Shalom Hartman Institute and the founder of its iEngage Project. His books include Putting God Second and Who Are the Jews — and Who Can We Become. He co-hosts For Heaven's Sake with Yossi Klein Halevi.

### Yossi Klein Halevi
- **ROLE**: Host, For Heaven's Sake
- **SHORT BIO**: Senior Fellow at the Shalom Hartman Institute. Author of Letters to My Palestinian Neighbor.
- **LONG BIO**: Yossi Klein Halevi is the author of Letters to My Palestinian Neighbor and Like Dreamers. A Senior Fellow at the Shalom Hartman Institute in Jerusalem, he co-hosts For Heaven's Sake with Donniel Hartman.

### Nadav Eyal
- **ROLE**: Call Me Back Contributor
- **SHORT BIO**: Columnist at Yedioth Ahronoth. Author of Revolt. One of Israel's most read journalists.
- **LONG BIO**: Nadav Eyal is one of Israel's leading journalists and a columnist at Yedioth Ahronoth. His book Revolt (Ecco, 2021) won the Bernstein Prize. He appears regularly on Call Me Back for analysis on Israeli politics and security.

### Amit Segal
- **ROLE**: Call Me Back Contributor
- **SHORT BIO**: Chief political analyst for Channel 12 News. The most quoted political voice in Israel.
- **LONG BIO**: Amit Segal is the chief political analyst for Channel 12 News in Israel and a columnist at Yedioth Ahronoth. He is widely regarded as one of the most influential political journalists in Israel.

### Tal Becker (marked placeholder in code)
- **ROLE**: Call Me Back Contributor
- **SHORT BIO**: Vice President at the Shalom Hartman Institute. Former Legal Adviser to Israel's Ministry of Foreign Affairs.
- **LONG BIO**: Dr. Tal Becker is Vice President at the Shalom Hartman Institute, where he directs its educational initiatives on Israel and the Jewish world and is a lead faculty member of the iEngage Project. Previously, he served as Legal Adviser of the Israeli Ministry of Foreign Affairs and was a senior member of Israel's peace negotiation team, including a key role in negotiating the Abraham Accords with the UAE, Bahrain, and Morocco. He holds a doctorate from Columbia University and is the author of Terrorism and the State.

### Deborah Pardes
- **ROLE**: Host, Ark News Daily
- **SHORT BIO**: Founder of The Play Full Society. Former VP of Stories & Voices at Swell; founded Artists for Literacy, recognized by The New York Times, NPR, and Rolling Stone.
- **LONG BIO**: Deborah Pardes is a visionary executive, storyteller, and founder of The Play Full Society, a new membership-based club reimagining how adults connect—through play, creativity, and authentic human interaction. With decades of leadership in content, community, and culture, she has shaped transformative experiences across media, education, and technology. Previously, as VP of Stories & Voices at Swell, Deborah championed accessibility in podcasting and helped thousands of creators find their voice. Her earlier work includes founding Artists for Literacy, a national arts and education movement recognized by The New York Times, Rolling Stone, and NPR. A Barnard College alum and lifelong creator, Deborah continues to build spaces and stories that inspire joy, empathy, and connection.

## Careers (index)   /careers
### Page header
- **TITLE**: Build Ark Media.
- **LEDE**: We're a small team building independent journalism for an audience that wants more than a hot take. Roles below; speculative notes welcome.

### Open roles list (roles themselves come from the database)
- **SECTION HEADING**: Open roles
- **EMPTY STATE**: No open roles right now. Check back in the future — we post new positions here as they open up.
- **ROW BUTTON**: Apply →

## Career detail (template)   /careers/{slug}
- **BREADCRUMBS**: Home / Careers / {job title}
- **APPLY RAIL HEADING**: Interested?
- **APPLY CTA**: Apply to this job →
- **HELPER (EXTERNAL APPLICATION LINK)**: Opens our application in a new tab.
- **HELPER (EMAIL FALLBACK)**: Opens your email to send an application.
- **EMAIL SUBJECT (PRE-FILLED)**: Application: {job title}

## Contact   /contact
### Page header
- **TITLE**: Get in touch.
- **LEDE**: Send us a note and it'll reach the right desk. Pick a topic, tell us what's on your mind, and we'll follow up by email.

### Form
- **FIELD LABEL**: Name
- **PLACEHOLDER (NAME)**: Your name
- **FIELD LABEL**: Email
- **PLACEHOLDER (EMAIL)**: you@example.com
- **FIELD LABEL**: Topic
- **TOPIC OPTION**: Show ideas, feedback & corrections
- **TOPIC OPTION**: Listener questions
- **TOPIC OPTION**: Press, interviews & media
- **TOPIC OPTION**: Sponsorships & partnerships
- **TOPIC OPTION**: Ark+ membership support
- **FIELD LABEL**: Message
- **PLACEHOLDER (MESSAGE)**: What's on your mind?
- **SUBMIT BUTTON**: Send message
- **SUBMIT BUTTON (SENDING)**: Sending…
- **SUCCESS MESSAGE**: Thanks — your message is on its way. We'll be in touch.

### Validation & error messages
- **ERROR (EMPTY NAME)**: Please add your name.
- **ERROR (INVALID EMAIL)**: That doesn't look like a valid email.
- **ERROR (NO TOPIC)**: Please choose a topic.
- **ERROR (EMPTY MESSAGE)**: Please add a message.
- **ERROR (TOO MANY ATTEMPTS)**: Too many attempts. Please wait a moment.
- **ERROR (SEND FAILED)**: Could not send. Please try again.
- **ERROR (NETWORK)**: Network error. Please try again.

## FAQ   /faq
> The page normally renders the shared FAQ section (heading and intro listed under Ark+ Membership, Pricing & Checkout); questions and answers come from the database.
- **PAGE TITLE (ERROR STATE)**: Frequently asked.
- **ERROR MESSAGE**: We couldn't load the FAQs right now. Try again, or get in touch and we'll answer directly.

## Book Club   /book-club
### Hero
- **EYEBROW**: Dan's Book Club
- **HEADING**: A book club worth showing up for. ("showing up" in a highlighted display span)
- **LEDE**: One standout book a month, handpicked by Dan — and the Fold reading along, digging in, and arguing it out. Big ideas, sharp debate, and a conversation you'll actually want to be part of.

### Current pick
- **EYEBROW**: {Month 'YY} Pick (e.g. "July '26 Pick")
- **BUTTON**: Buy on Amazon →
- **LINK**: Discuss it in the Fold →

### Past picks
- **EYEBROW**: The shelf
- **HEADING**: Every pick so far.
- **COVER RIBBON**: {Month 'YY} Pick

### Books by Dan
- **HEADING**: Books by Dan
- **BUTTON**: Buy on Amazon →

### Pick detail modal
- **BUTTON**: Buy on Amazon →
- **BUTTON**: Discuss it in the Fold →

### Placeholder book cover (books without cover art)
- **EYEBROW**: Ark Book Club

## Book Club data (src/data/bookClub.ts)
### Dan's notes on monthly picks (all marked PLACEHOLDER in source)
- **THE POWER BROKER — ROBERT A. CARO (JULY '26, FEATURED)**: PLACEHOLDER — Caro's study of how power actually accrues and gets spent. I keep coming back to it whenever I want to understand the machinery behind the headlines. We'll take it slow.
- **THINKING, FAST AND SLOW — DANIEL KAHNEMAN (JUNE '26)**: PLACEHOLDER — the book that reframed how I read every poll, every forecast, every gut call. A useful antidote to a news cycle built on snap judgments.
- **THE LOOMING TOWER — LAWRENCE WRIGHT (MAY '26)**: PLACEHOLDER — narrative history at its best, and essential context for so much of what we talk about on the show.
- **TEAM OF RIVALS — DORIS KEARNS GOODWIN (APRIL '26)**: PLACEHOLDER — leadership under impossible pressure. Worth reading for the temperament alone.
- **SAPIENS — YUVAL NOAH HARARI (MARCH '26)**: PLACEHOLDER — a big, argumentative sweep of a book. The Fold had plenty to disagree with, which is exactly the point.

### Books by Dan
- **BOOK 1 TITLE / SUBTITLE**: The Genius of Israel — The Surprising Resilience of a Divided Nation in a Turbulent World
- **BOOK 1 AUTHOR**: Dan Senor & Saul Singer
- **BOOK 1 NOTE**: How has a small nation of 9 million people, forced to fight for its existence and security since its founding and riven by ethnic, religious, and economic divides, proven resistant to so many of the societal ills plaguing other wealthy democracies?
- **BOOK 2 TITLE / SUBTITLE**: Start-Up Nation — The Story of Israel's Economic Miracle
- **BOOK 2 AUTHOR**: Dan Senor & Saul Singer
- **BOOK 2 NOTE**: Start-Up Nation addresses the trillion dollar question: How is it that Israel — a country of 7.1 million, only 60 years old, surrounded by enemies, in a constant state of war since its founding, with no natural resources — produces more start-up companies than large, peaceful, and stable nations like Japan, China, India, Korea, Canada and the UK?

## Israel Votes   /israel-votes
### Page header
- **TITLE**: Tracking the next Israeli election.
- **LEDE**: Polls, parties, and the politics behind the headlines (no closing period in source)

### Watch the latest
- **SECTION HEADING**: Watch the latest

### Explainers
- **SECTION HEADING**: Explainers
- **INTRO**: Background on the camps, the coalitions, and the constituencies shaping Israel's next vote — in video and audio.
- **CARD 1 (FOR HEAVEN'S SAKE)**: The State of the Israeli Right
- **CARD 2 (CALL ME BACK · WITH ARI SHAVIT)**: The Only-Bibi Camp vs Never-Bibi Camp
- **CARD 3 (FOR HEAVEN'S SAKE)**: The State of the Israeli Center

### Israel Votes playlist
- **SECTION EYEBROW**: Israel Votes playlist
- **HEADING**: The full collection.
- **INTRO**: Episodes from across the Ark Media network covering the campaign, the coalitions, and the questions on the ballot.
- **EPISODE COUNT (DESKTOP ONLY)**: {count} episodes
- **TRACK 01 (CALL ME BACK)**: A Political Shakeup in Israel? — with Amit Segal and Nadav Eyal
- **TRACK 02 (CALL ME BACK)**: The Political Landscape — with Nadav Eyal and Amit Segal
- **TRACK 03 (FOR HEAVEN'S SAKE)**: Election Currents
- **TRACK 04 (FOR HEAVEN'S SAKE)**: Bennett 2026
- **TRACK 05 (FOR HEAVEN'S SAKE)**: The State of the Israeli Center
- **TRACK 06 (CALL ME BACK)**: The Only-Bibi Camp vs Never-Bibi Camp
- **TRACK 07 (FOR HEAVEN'S SAKE)**: The State of the Israeli Right
- **TRACK 08 (CALL ME BACK)**: Netanyahu Seeks Pardon
- **TRACK 09 (FOR HEAVEN'S SAKE)**: Coming Apart
# The Fold & Newsletters

## The Fold (members)   /fold
### Page header
- **TITLE**: Welcome back to the room.
- **LEDE**: What's live, what's happening, and what the Fold is talking about right now. Jump in — every conversation continues in the app.

### Sections & states
- **SECTION LABEL**: Live & upcoming
- **SECTION LABEL**: From the Fold
- **FEED ERROR**: We couldn't load your Fold feed. Refresh to try again.
- **FEED LOADING**: Loading your feed…
- **FEED CARD CTA**: Read & reply in the app →

### Feed empty state
- **HEADING**: Your feed is quiet — join a space to fill it.
- **BODY**: Your feed comes alive once you've joined a few spaces. Here's where the Fold is most active right now.
- **LOADING (SPACES)**: Loading spaces…
- **MEMBER COUNT (PER SUGGESTED SPACE)**: {count} members
- **CTA (PER SUGGESTED SPACE)**: Join in the app →

### Live events strip
- **LOADING**: Loading events…
- **EMPTY STATE**: No live or upcoming events right now — we'll surface the next one here.
- **BADGE (LIVE)**: Live now
- **FORMAT LABELS**: Audio room / Video AMA / Watch party / In person
- **META SUFFIX (HAS VENUE)**: · {venue}
- **CTA (LIVE)**: Join in the app →
- **CTA (UPCOMING)**: Open in the app →

## The Fold (marketing showcase)   /fold
### Page header (non-members)
- **TITLE**: The room behind the show — in the app.
- **LEDE**: Our The Fold puts your hosts and other Ark+ members in the room with you: weekly Q&As, live conversations, and thousands of members talking through the day's news. On iOS, Android, and the web.

### Feature block 01
- **TITLE**: Call Me Back AMA
- **KICKER**: Weekly Q&As with your favorite Ark Media hosts.
- **BODY**: Ask questions. Get actual answers - not a comments section, not a bot. Bring what's on your mind to the people making the show.

### Feature block 02
- **TITLE**: Connection in the Fold
- **KICKER**: Join conversations with thousands of other members.
- **BODY**: The room keeps going between episodes - members debating the news, sharing what they're reading, and starting meetups in their own cities.

### Feature blocks 03 & 04 (placeholders — lineup not settled)
- **BADGE**: Coming soon
- **TITLE**: Placeholder feature
- **KICKER (03)**: Another Fold feature will live here.
- **BODY (03)**: We're still settling the lineup. This slot is reserved for the next app feature once it's confirmed.
- **KICKER (04)**: And one more, to be decided.
- **BODY (04)**: A second reserved slot. Same pattern as the blocks above — headline, supporting line, and an app screen.
- **MOCK SCREEN LABELS**: Feature 03 / Feature 04 — Screen TBD

### Phone mockup — Q&A screen (illustrative)
- **SHOW NAME**: Call Me Back
- **SUBHEAD**: Live Q&A · with Dan Senor
- **BADGE**: Live
- **SAMPLE POST (RACHEL B.)**: What are you watching for in tonight's coalition vote?
- **SAMPLE REPLY (DAN SENOR · HOST)**: Great question. Watch the smaller parties — that's where this actually gets decided. I'll break it down on Thursday's show.
- **SAMPLE POST (YOSSI M.)**: Any chance of a guest from the negotiating room?
- **COMPOSER PLACEHOLDER**: Ask a question…

### Phone mockup — feed screen (illustrative)
- **HEADER**: The Fold
- **ONLINE COUNT**: 2,847 online
- **SAMPLE POST (MAYA L. · TEL AVIV · 12M)**: Just finished today's episode. The point about the budget timeline reframed the whole thing for me.
- **SAMPLE POST (DAVID R. · NEW YORK · 1H)**: Anyone going to the listener meetup next week? Trying to coordinate a group from the Upper West Side.
- **SAMPLE POST (SARAH K. · LONDON · 3H)**: Sharing the long-read Nadav mentioned — worth every minute.
- **TAB BAR**: Feed / Events / Rooms / Profile

## The Fold section (on /plus and /pricing)
### Section header
- **EYEBROW**: The Fold
- **HEADING**: Somewhere to argue properly. ("argue" in the cyan accent)
- **BODY**: Join the Fold. Conversations, member events, and Dan's book club — in an app built for talking rather than for going viral.

### Pricing + CTA
- **PRICE UNIT (AFTER LIVE PRICE)**: / month
- **PRICE ERROR**: We couldn't load the Fold price just now.
- **CTA**: Join the Fold →
- **BUNDLE NOTE**: Want the private feed too? The Ark+ & The Fold bundle covers both — see the plans above.

### Pillars
- **PILLAR 01 TITLE**: The conversation, all week
- **PILLAR 01 BODY**: The arguments the episodes start, carried on by the people who listen to them — analysts, veterans, students, and the hosts themselves, in the thread with everyone else.
- **PILLAR 02 TITLE**: Member events, live
- **PILLAR 02 BODY**: Live discussions and Q&As held in the Fold — the room where questions get asked out loud instead of shouted into a comments section.
- **PILLAR 03 TITLE**: Dan's book club
- **PILLAR 03 BODY**: One book at a time, read together, with Dan running the discussion. Slow, serious reading in the middle of a very fast news cycle.

### App links footer
- **EYEBROW**: Get the app
- **BUTTON**: Open in browser

## Newsletters   /newsletters
### Page header
- **BREADCRUMBS**: Home / Newsletters
- **TITLE (LOADING / ERROR)**: Newsletters
- **LOADING**: Loading…
- **ERROR**: We couldn’t load the newsletter right now. Please refresh to try again.
> The normal title and lede are the newsletter title and description from the newsletter data below.

### Recent issues list
- **SECTION LABEL**: Recent issues
- **EMPTY STATE**: No recent issues yet.
- **POST META SUFFIX (ARK+ POST)**: · Ark+ (appended after the date)

### Subscribe card (guests / not yet subscribed)
- **LABEL**: Subscribe
- **BODY**: {cadence}. Written by {author name}. (from the newsletter data below)
- **BODY SUFFIX (ARK+ NEWSLETTER)**: Members-only — included with Ark+.
- **BODY SUFFIX (FREE NEWSLETTER)**: Free in your inbox.
- **CTA (ARK+ NEWSLETTER)**: Become an Ark+ member →
- **EMAIL PLACEHOLDER**: you@example.com
- **SUBMIT BUTTON**: Subscribe
- **SUBMIT BUTTON (SUCCESS)**: Subscribed
- **SUCCESS MESSAGE**: You're on the list.

### Ark+ upsell card (free newsletter, non-subscriber)
- **LABEL**: Ark+
- **BODY**: Get the members-only newsletter, ad-free episodes, and the full archive when you join Ark+.
- **CTA**: Join Ark+ →

### Subscribe error messages (shared with all newsletter forms)
- **ERROR (INVALID EMAIL)**: That doesn't look like a valid email.
- **ERROR (UNKNOWN NEWSLETTER)**: Unknown newsletter.
- **ERROR (ALREADY SUBSCRIBED)**: Looks like you're already on the list.
- **ERROR (TOO MANY ATTEMPTS)**: Too many attempts. Please wait a moment.
- **ERROR (GENERIC)**: Could not subscribe. Please try again.
- **ERROR (NETWORK)**: Network error. Please try again.

## Newsletter post (template)   /newsletters/{post}
### Post masthead
- **BREADCRUMBS**: Home / Newsletters / {post title}
- **ISSUE LABEL**: Issue (above the large date lockup)
- **EYEBROW**: {newsletter short title} · Ark+ (Ark+ posts) / {newsletter short title} · Newsletter (free posts)

### Discussion footer
- **LABEL (POST HAS FORUM THREAD)**: Discuss this piece
- **BODY (POST HAS FORUM THREAD)**: There's an open thread on this post in the Fold.
- **CTA (POST HAS FORUM THREAD)**: Discuss on forum →
- **LABEL (NO FORUM THREAD)**: Keep the conversation going
- **BODY (NO FORUM THREAD)**: Comments and replies live in the Fold. Sign in once and they open straight to the thread.
- **CTA (NO FORUM THREAD)**: Comment in the app →

### Members-only gate (Ark+ posts, non-members)
- **LABEL**: Members only
- **HEADING**: The rest of this post is for Ark+ members.
- **BODY**: Ark+ includes the paid feed, members-only newsletters, and the Fold.
- **CTA**: Become an Ark+ member →

### Post not found
- **TITLE**: Post not found.
- **LEDE**: We couldn't find that post.
- **CTA**: ← Back to {newsletter title}

### In-post episode & promo cards (chrome only — post content comes from Beehiiv)
- **EPISODE NUMBER CHIP**: № {NN} (zero-padded)
- **EPISODE CTA**: Listen →

## Newsletter data (src/data/newsletters.ts)
### The free newsletter
- **TITLE**: The Ark Media Newsletter
- **SHORT TITLE**: Ark Media
- **DESCRIPTION**: Our free dispatch — the through-lines from this week's interviews and what they tell us about the week ahead.
- **CADENCE**: Weekly
- **AUTHOR**: Ark Media newsroom

### The members newsletter
- **TITLE**: The Ark+ Members Letter
- **SHORT TITLE**: Members Letter
- **DESCRIPTION**: A members-only letter from the Ark Media editorial team — sharper analysis, source notes, and what we're reading.
- **CADENCE**: Weekly
- **AUTHOR**: Ark Media editorial

## Fold broadcasts (mock member highlights, src/data/communityBroadcasts.ts)
### Broadcast — Sarah K. (Member, Tel Aviv)
- **EXCERPT**: What it actually feels like to be a member of the Fold in week 82.
- **BODY**: I joined Ark+ for the podcast feed and stayed for the room. There's a thread running right now about the Cairo readout that has three people I'd never have met otherwise, all sharper than I am, and one of them is in the room with me on a watch party tonight. This is what I was looking for and didn't know how to ask for.

### Broadcast — Daniel R. (Member, Toronto)
- **EXCERPT**: Three things the show didn't say, that the room is saying.
- **BODY**: After the episode dropped on Sunday, the discussion thread filled up with three things that didn't make the cut — and one of them turned out to be the most useful read of the week. The Fold sometimes does the work the show can't.

### Broadcast — Lior B. (Member, Jerusalem)
- **EXCERPT**: An invitation to the Friday-morning members' coffee in Jerusalem.
- **BODY**: Friday morning, 9am, same coffee shop as last month. Five members from the Fold have started meeting in person. If you're an Ark+ member and you're in the city, the invitation is open.

## Mock / fallback events (src/data/events.ts)
### Call Me Back Live — Coalition Roundtable
- **HOSTS**: Dan Senor, Amit Segal, Nadav Eyal
- **DESCRIPTION**: An audio roundtable in the Fold on the latest coalition geometry. Members can submit questions live.

### For Heaven's Sake — Members AMA
- **HOSTS**: Donniel Hartman, Yossi Klein Halevi
- **DESCRIPTION**: A monthly video AMA with Donniel and Yossi. Bring the questions you'd have asked them after a podcast.

### Knesset session watch party
- **HOSTS**: Ark Media newsroom
- **DESCRIPTION**: We watch the Knesset session together with live commentary in the Fold.

### Open conversation: a year of Ark Media
- **HOSTS**: Dan Senor, Donniel Hartman
- **DESCRIPTION**: An open audio conversation marking a year of Ark Media. Open to everyone — RSVP in the Fold.

### Ark Media in New York — a live recording
- **HOSTS**: Dan Senor
- **VENUE**: 92NY, New York
- **DESCRIPTION**: A live recording of Call Me Back in New York. Ark+ members get first access to tickets.
# Onboarding & Account

## Welcome   /welcome
### Hero
- **HEADLINE (ARK+ + FOLD / BUNDLE)**: Welcome to Ark+ & The Fold.
- **HEADLINE (FOLD ONLY)**: Welcome to the Fold.
- **HEADLINE (ARK+ ONLY / DEFAULT)**: Welcome to Ark+.
- **INTRO**: {count word} to do, and then you're set. Your membership is active now — provisioning happens in the background and may take a minute or two to land in every place. (count word = "One thing" / "Two things" / "Three things" / "{n} things")
- **LOADING**: Loading…

### Step cards
- **STEP LABEL**: Step {n} (zero-padded: 01, 02, …)
- **STEP TITLE (FOLD)**: Download the Fold app
- **STEP BODY (FOLD)**: Nadav, Amit and Tal are in the Fold — alongside everyone else who joined this month. Install the app and you'll be signed in automatically.
- **STEP TITLE (FEEDS)**: Set up your private podcast feeds
- **STEP BODY (FEEDS)**: Your members-only shows live in the podcast app you already use. One-tap setup for Apple Podcasts, Overcast, Pocket Casts, Spotify, and more.
- **STEP CTA (FEEDS)**: Set up your feeds →
- **STEP TITLE (NOTIFICATIONS)**: Confirm your notification preferences
- **STEP BODY (NOTIFICATIONS)**: New post, podcast, and members-only newsletter alerts are on by default. Confirm your preferences so you never miss an update.
- **STEP CTA (NOTIFICATIONS)**: Newsletter preferences →

### Gift-claimed extra step (arriving from a claimed gift)
- **STEP TITLE**: Set a password (optional)
- **STEP BODY**: You're signed in — no password needed. Prefer one? Set a password so you can sign in without Google or your gift link next time.
- **BUTTON**: Set a password →
- **BUTTON (BUSY)**: Opening… →
- **ERROR (SETUP FAILED)**: Couldn't start password setup. Please try again.
- **ERROR (NETWORK)**: Network error. Please try again.

### Footer
- **HELP LINE**: A welcome email is on its way. Need help? Contact us. ("Contact us." links to /contact)

## Account — Overview   /account
### States
- **LOAD ERROR**: We couldn't load your account. Refresh to try again.
- **LOADING**: Loading…

### Subscriber dashboard (paid members)
- **PAGE TITLE**: Welcome back.
- **LEDE**: Signed in as {email}. Everything in your membership, in one place.
- **ROW (PODCAST) LABEL / TITLE**: Podcast — Your private podcast feeds
- **ROW (PODCAST) BODY**: Your members-only shows live in the podcast app you already use. One-tap setup for Apple Podcasts, Overcast, Pocket Casts, Spotify, and more.
- **ROW (PODCAST) CTA**: Set up your feeds →
- **ROW (FOLD) LABEL / TITLE**: The Fold — The Fold, in the app
- **ROW (FOLD) BODY**: The Fold is the main event. Open it in the app — you're signed in here, so you'll be signed in there too.
- **ROW (NEWSLETTER) LABEL / TITLE**: Newsletter — Newsletter preferences
- **ROW (NEWSLETTER) BODY**: The members-only newsletter is on by default. Adjust which emails you want — or which you don't — at any time.
- **ROW (NEWSLETTER) CTA**: Manage newsletters →
- **FOOTER LINE**: Signed in as {email} · Billing & cancel ("Billing & cancel" is a link)
- **BUTTON**: Sign out

### Free-account dashboard
- **PAGE TITLE**: You're signed in.
- **LEDE**: Signed in as {email}. Manage what lands in your inbox, or join Ark+ for the private feed and the Fold.
- **UPSELL CARD EYEBROW**: Become an Ark+ member
- **UPSELL CARD HEADING**: Go deeper with Ark+.
- **UPSELL LIST ITEM**: — Call Me Back AMA, the members-only show
- **UPSELL LIST ITEM**: — Private podcast feed, ad-free
- **UPSELL LIST ITEM**: — Members-only newsletter
- **UPSELL LIST ITEM**: — The Fold in the app
- **UPSELL CTA**: Become a member →
- **ACCOUNT CARD EYEBROW**: Your account
- **LINK**: Newsletter preferences →
- **BUTTON**: Sign out

### Your access (per-service rows)
- **SECTION LABEL**: Your access
- **SERVICE NAMES**: Ark+ / The Fold
- **BADGE (GIFT)**: 🎁 Gift
- **BADGE (SUBSCRIPTION)**: Subscription
- **STATUS (GIFT, WITH DATE)**: Gift access until {date}
- **STATUS (GIFT, NO DATE)**: Gift access
- **STATUS (SUBSCRIPTION, CANCELLING)**: Access until {date} · won't renew
- **STATUS (SUBSCRIPTION, RENEWING)**: Renews {date}
- **STATUS (SUBSCRIPTION, NO DATES)**: Active
- **STATUS (SERVICE NOT HELD)**: You don't have {Ark+|The Fold} yet.
- **BUTTON (SERVICE NOT HELD)**: Get {Ark+|The Fold} →

### Expiring gift banner (gifted access ending within 14 days)
- **BANNER**: Your gifted {Ark+|The Fold} access ends on {date} — {today / in {n} day / in {n} days}. Keep it going so you don't lose access.
- **BANNER (NO DATE)**: Your gifted {Ark+|The Fold} access is ending soon. Keep it going so you don't lose access.
- **BUTTON (OTHER SERVICE IS A SUBSCRIPTION)**: Add it to your plan →
- **BUTTON (BUSY)**: Switching…
- **BUTTON (NO OTHER SUBSCRIPTION)**: Keep {Ark+|The Fold} →
- **SUCCESS (SWITCHED TO BUNDLE)**: You're on the bundle now — both Ark+ and the Fold are on your subscription, effective {date}.
- **ERROR**: Could not switch to the bundle — please try again.

## Account — Billing   /account/billing
### Page shell
- **BREADCRUMBS**: Home / Account / Billing
- **PAGE TITLE**: Your membership.
- **LEDE**: Signed in as {email}.
- **LOAD ERROR**: We couldn't load your billing details. Refresh to try again.
- **LOADING**: Loading…

### Tier labels (used inside the sentences below)
- **LABELS**: the Ark+ & The Fold bundle / Ark+ / the Fold / the free plan

### Pending-change banner
- **BANNER (SCHEDULED TIER CHANGE)**: Your membership will change from {current tier} to {new tier} on {date}. You'll keep full access until then. (without a date: "…at the end of your current billing period. You'll keep full access until then.")
- **BANNER (GENERIC PENDING CHANGE)**: A plan change is scheduled and will take effect at the end of your current billing period, on {date}. (", on {date}" omitted when unknown)

### Cancel card
- **CARD LABEL**: Cancel
- **BODY (CANCEL SCHEDULED)**: Your membership is set to cancel and won't renew.
- **BODY (PENDING CHANGE)**: Changed your mind? You can undo the scheduled change and keep your full membership, or cancel it entirely.
- **BODY (DEFAULT)**: Cancel anytime. You'll keep access through the end of your current billing period, on {date}. (", on {date}" omitted when unknown)
- **STATUS (CANCEL SCHEDULED)**: You'll keep access until {date}.

### Confirmation messages (after a flow action)
- **CONFIRMATION (CANCELLED)**: Cancellation confirmed. Access continues until {date}.
- **CONFIRMATION (DEBUNDLED, KEPT ARK+)**: Done — you'll keep Ark+ on its own. The change takes effect at the end of your current billing period, on {date}.
- **CONFIRMATION (DEBUNDLED, KEPT FOLD)**: Done — you'll keep the Fold on its own. The change takes effect at the end of your current billing period, on {date}.
- **CONFIRMATION (REACTIVATED)**: Your membership is back on. It renews on {date}.
- **CONFIRMATION (CHANGE UNDONE)**: The scheduled change was cancelled — your membership continues unchanged. It renews on {date}.

### Buttons
- **BUTTON (REACTIVATE)**: Reactivate membership
- **BUTTON (REACTIVATE, BUSY)**: Reactivating…
- **BUTTON (UNDO PENDING CHANGE)**: Keep {current tier}
- **BUTTON (UNDO, BUSY)**: Undoing…
- **BUTTON (CANCEL WHILE CHANGE PENDING)**: Cancel my membership
- **BUTTON (OPEN CANCEL FLOW — BUNDLE)**: Cancel or change my membership
- **BUTTON (OPEN CANCEL FLOW — FOLD)**: Cancel the Fold
- **BUTTON (OPEN CANCEL FLOW — ARK+)**: Cancel Ark+
- **ERROR (REACTIVATE)**: Could not reactivate — please try again.
- **ERROR (UNDO)**: Could not undo the change — please try again.

## Cancel / change membership flow (modal from /account/billing)
### Mission reminder (step 0 of every flow)
- **HEADING**: Thanks for being a subscriber!
- **BODY (ARK+ / BUNDLE)**: Ark Media is funded in large part by our Ark+ subscribers. They allow us to cover Israel and the Jewish world honestly, without compromise. As an Ark+ subscriber, you make that possible.
- **BODY (FOLD)**: Ark Media is funded in large part by our subscribers. They allow us to cover Israel and the Jewish world honestly, without compromise. As a subscriber, you make that possible.
- **BUTTON (KEEP — BUNDLE)**: Keep my bundle
- **BUTTON (KEEP — ARK+ / FOLD)**: Keep my subscription
- **BUTTON (CONTINUE — BUNDLE)**: Continue
- **BUTTON (CONTINUE — ARK+ / FOLD)**: Continue to cancel

### Bundle service selector (bundle members only)
- **HEADING**: Do you want to keep any services?
- **BODY**: Your membership includes these services for {price}/{month|year}. Choose any individual services you'd like to keep. (without prices: "Your membership includes both of these. Choose any you'd like to keep — uncheck the rest.")
- **CHECKBOX LABEL**: Ark+
- **CHECKBOX LABEL**: The Fold
- **SUMMARY (KEEP NONE)**: Your membership ends at the end of your current billing period.
- **SUMMARY (KEEP BOTH)**: Keeping both — your membership is unchanged.
- **PRIMARY BUTTON (KEEP NONE)**: Cancel all services
- **PRIMARY BUTTON (KEEPING SOME)**: {count} service: {price}/{month|year} / {count} services: {price}/{month|year} (without prices: "Keep {count} service(s)")
- **SECONDARY BUTTON**: Keep bundle

### Save offers ("Are you sure?")
- **HEADING (CANCEL FLOWS)**: Are you sure you want to cancel?
- **HEADING (DEBUNDLE FLOWS)**: Before you go — a couple of options.
- **BODY**: Your subscription helps make Ark Media's work possible.
- **OFFER HEADING (SWITCH TO ANNUAL)**: Get a full year of Ark+ for less
- **OFFER BODY (SWITCH TO ANNUAL)**: Save {percent}% when you switch to annual billing (without a percentage: "Switch to annual billing at {price}/year")
- **OFFER CTA (SWITCH TO ANNUAL)**: Switch to annual
- **OFFER HEADING (SWITCH TO MONTHLY)**: Cancel any time
- **OFFER BODY (SWITCH TO MONTHLY)**: Switch to monthly billing for {list price, struck through} {discounted price}/month for {n} months, then {list price}/month (or simply "Switch to monthly billing" with no discount)
- **OFFER CTA (SWITCH TO MONTHLY)**: Switch to monthly
- **OFFER HEADING (DISCOUNT OFFER)**: Keep your benefits for {discount, e.g. 20% off}
- **OFFER BODY (DISCOUNT OFFER)**: {list price, struck through} {discounted price}/{month|year} for {n} months of {Ark+|the Fold}
- **OFFER CTA (DISCOUNT OFFER)**: Redeem {discount} discount
- **OFFER CTA (BUSY)**: Applying…
- **DECLINE BUTTON (CANCEL FLOWS)**: No thanks, just cancel
- **DECLINE BUTTON (BUSY)**: Cancelling…
- **DECLINE BUTTON (DEBUNDLE FLOWS)**: Continue
- **SECONDARY BUTTON (DEBUNDLE FLOWS)**: Keep my bundle

### Debundle confirm
- **HEADING (KEEP FOLD)**: Remove Ark+ and keep the Fold?
- **HEADING (KEEP ARK+)**: Remove the Fold and keep Ark+?
- **BODY (CONTINUATION SENTENCE)**: {Ark+|The Fold} continues on its own at {intro price}/{month|year} {intro term}, then {list price}/{month|year} — starting at the end of your current billing period. (no intro rate: "…at {price}/{month|year}, starting at the end of your current billing period."; intro term = "for your first year" / "for your first {n} years" / "for {n} months" / "for 1 month")
- **BUTTON**: Confirm
- **BUTTON (BUSY)**: Updating…
- **BUTTON**: Keep my bundle

### Post-cancel survey
- **HEADING**: Your subscription has been cancelled
- **BODY**: Help us improve by letting us know why you're cancelling
- **REASON**: I subscribed for specific episodes or a series and finished them.
- **REASON**: I'm not listening regularly.
- **REASON**: It's too expensive for me right now.
- **REASON**: I'm cutting back on subscriptions.
- **REASON**: The content or topics weren't what I expected.
- **REASON**: I subscribed mainly to support Ark Media and don't need an ongoing subscription
- **REASON**: I had trouble accessing the content or using my podcast app.
- **REASON**: Other (please tell us more).
- **TEXTAREA LABEL (WHEN "OTHER" CHECKED)**: Tell us more
- **BUTTON**: Submit
- **BUTTON (BUSY)**: Submitting…

### "Saved" success screen (offer accepted)
- **HEADING**: Thanks for sticking around
- **BODY**: Your subscription helps make Ark Media's work possible.
- **DETAIL ROW LABEL**: New subscription details
- **DETAIL ROW LABEL**: Next payment date

### Flow errors
- **ERROR (PLAN SWITCH)**: Could not switch your plan — please try again.
- **ERROR (SWITCH OK, DISCOUNT FAILED)**: Your plan was switched but we couldn't apply your discount — please try again or contact support.
- **ERROR (DISCOUNT OFFER)**: Could not apply your offer — please try again.
- **ERROR (CANCEL)**: Could not cancel — please try again.
- **ERROR (DEBUNDLE)**: Could not update your plan — please try again.

## Account — Newsletters   /account/newsletters
### Page shell
- **BREADCRUMBS**: Home / Account / Newsletter preferences
- **PAGE TITLE**: Pick what lands in your inbox.
- **LEDE**: Signed in as {email}. Adjust at any time — toggling off won't delete past issues from your archive.
- **LOAD ERROR**: We couldn't load your newsletter settings. Refresh to try again.
- **LOADING**: Loading…

### Preference card
- **ROW (ARK+ MEMBERS) LABEL / TITLE**: Members letter — The Ark+ Members Letter
- **ROW (ARK+ MEMBERS) DESCRIPTION**: A members-only letter from the Ark Media editorial team — sharper analysis, source notes, and what we're reading. Turning off keeps you on the free newsletter.
- **BADGE (ARK+ MEMBERS)**: Ark+
- **ROW (FREE ACCOUNTS) LABEL / TITLE**: Free newsletter — The Ark Media Newsletter
- **ROW (FREE ACCOUNTS) DESCRIPTION**: Our free dispatch — the through-lines from this week's interviews and what they tell us about the week ahead. Toggling off stops all Ark Media emails.
- **CADENCE (BOTH ROWS)**: Weekly
- **ERROR (SESSION EXPIRED)**: Session expired. Sign in again to manage preferences.
- **ERROR (LOAD FAILED)**: Could not load preferences. Please refresh the page.
- **RETRY BUTTON**: Try again
- **ERROR (SAVE FAILED)**: Could not update. Please try again.
- **ERROR (ARK+ REQUIRED)**: Ark+ membership required.
- **ERROR (PROVIDER UPDATE FAILED)**: Could not update newsletter preferences. Please try again.
- **ERROR (GENERIC SAVE)**: Could not save. Please try again.
- **ERROR (NETWORK)**: Network error. Please try again.

## Feed setup hub   /setup and /account/podcast-feed
### Masthead
- **BREADCRUMBS**: Home / Account / Podcast feed
- **EYEBROW**: Your private feeds
- **HEADLINE**: Now let's get you listening. ("listening." in the cyan accent)
- **LEDE**: Your Ark+ membership unlocks a private feed for every show in the network. Link Spotify once to get them all — or add each show to the app you already use.
- **LOADING**: Loading…

### Progress meter
- **METER LABEL**: Setup
- **METER LABEL (ALL DONE)**: All set
- **METER COUNT**: {done}/{total}
- **METER CAPTION (ALL DONE)**: You're following the whole network. Nice.
- **METER CAPTION (REMAINING)**: {n} shows left to add. / {n} show left to add. (singular when 1)
- **EMPTY STATE**: No private feeds on your membership yet. If you just joined, give it a minute and refresh — they appear here automatically.

### Spotify hero
- **EYEBROW**: Fastest way in
- **HEADING**: Link Spotify once — get every show
- **BODY**: Connect your Spotify account and your entire network of private feeds follows automatically. No adding shows one by one — new shows we launch show up on their own, too.
- **CTA**: Link my Spotify →

### Show list
- **SECTION LABEL (WITH SPOTIFY PATH)**: Or one at a time
- **SECTION LABEL (NO SPOTIFY PATH)**: Set up your shows
- **SECTION HEADING**: Every show in the network
- **SECTION BODY**: Add each show to Apple Podcasts, Overcast, Pocket Casts, or any app you like. The more you set up, the less you'll miss.
- **ROW ACTION (NOT SET UP)**: Set up →
- **ROW ACTION (DONE)**: Manage →
- **STATUS BADGE (DONE)**: Set up
- **STATUS BADGE (NOT DONE)**: Not set up yet

## Per-show feed setup (after picking a show)
### Masthead
- **BACK LINK (MULTI-FEED MEMBERS)**: ← All feeds
- **EYEBROW**: You're in
- **HEADLINE**: Now let's get you listening. ("listening." in the cyan accent)
- **LEDE**: Get your exclusive {show name} episodes in your podcast app of choice — in just a few steps.

### Step 1 — device (hidden on phones)
- **STEP LABEL**: Step 1 (appends " ✓" when done)
- **STEP TITLE**: Choose what device you want to listen on
- **STEP SUBTITLE**: Skip this on a phone — we'll assume you want the phone flow.
- **DEVICE CARD**: On my phone — Open or scan to add to your podcast app
- **DEVICE CARD**: On my computer — Open in Spotify, Apple Podcasts, or similar

### Step 2 — app
- **STEP LABEL**: Step 2 (appends " ✓" when done)
- **STEP TITLE**: Choose where you listen to your podcasts
- **STEP SUBTITLE (COMPUTER)**: These three work directly in your browser or desktop app.
- **STEP SUBTITLE (PHONE / DEFAULT)**: Pick the app you already use — we'll send you straight there.
- **FEATURED BADGE (SPOTIFY)**: Easiest setup
- **APP CARD**: Spotify — Link once — no copy-paste
- **APP CARD**: Apple Podcasts — iPhone, iPad, Mac
- **APP CARD**: YouTube Music — Phone or desktop
- **APP CARD**: Overcast — iPhone
- **APP CARD**: Pocket Casts — iPhone & Android
- **APP CARD**: Downcast — iPhone
- **APP CARD (MANUAL)**: Another app — I'll add the feed manually — Any podcast player

### Step 3 — instructions
- **STEP LABEL**: Step 3
- **STEP TITLE**: Start listening
- **STEP SUBTITLE (APP SELECTED)**: Here's how to finish setting up {app name}.
- **STEP SUBTITLE (NO APP SELECTED)**: Pick an app above to see your instructions.
- **INSTRUCTIONS (SPOTIFY)**: A separate window will open — click Link Account. / Sign in to your Spotify account. / {show name} episodes unlock inside the show on Spotify.
- **CTA (SPOTIFY)**: Link my Spotify account →
- **INSTRUCTIONS (APPLE PODCASTS)**: The Podcasts app will open on your device. / A pop-up will appear with the show URL — tap Follow. / Your exclusive {show name} episodes appear here. Your other feeds stay where they are.
- **CTA (APPLE PODCASTS)**: Open in Apple Podcasts →
- **NOTE (APPLE PODCASTS)**: Note — Can't find the show? Don't search for it — a private feed never appears in Apple Podcasts search. Go to Library → Shows to find it there.
- **INSTRUCTIONS (YOUTUBE MUSIC)**: YouTube Music will open — sign in if you're not already. / A pop-up will appear with the show URL — tap Add. / Your exclusive {show name} episodes appear in your library when new ones drop.
- **CTA (YOUTUBE MUSIC)**: Open in YouTube Music →
- **INSTRUCTIONS (OVERCAST)**: Open Overcast on your phone. / Tap the + icon, then Add URL. / Paste the private feed URL below.
- **INSTRUCTIONS (POCKET CASTS)**: Open Pocket Casts. / Tap Profile → Settings → Advanced → Add Podcast by URL. / Paste the private feed URL below.
- **INSTRUCTIONS (DOWNCAST)**: Open Downcast and go to the Podcasts tab. / Tap Add Podcast → Add Podcast by URL. / Paste the private feed URL below.
- **INSTRUCTIONS (MANUAL)**: Open the podcast app you want to listen in. / Find the option to add a podcast by URL (sometimes under Settings → Advanced). / Paste the private feed URL below.
- **CTA (COPY-BASED APPS)**: Copy feed URL →
- **CTA (AFTER COPY)**: Copied ✓ →
- **SECONDARY LINK**: Or copy the raw feed URL
- **SECONDARY LINK (AFTER COPY)**: Feed URL copied
- **EMPTY FEED STATE**: No feed available for this membership yet.
- **COPY BUTTON (URL BAR)**: Copy
- **COPY BUTTON (AFTER COPY)**: Copied

### QR handoff panel
- **EYEBROW (ON PHONE)**: Continue on another device
- **EYEBROW (ON COMPUTER)**: Continue on phone
- **HEADING (MANUAL APP)**: Scan to open the setup link
- **HEADING (NAMED APP)**: Scan to open {app name}
- **BODY (ON PHONE)**: On another device, point its camera at this code to open the setup link there.
- **BODY (ON COMPUTER, MANUAL)**: Point your phone's camera at this code. It'll open the setup link on your phone, ready to add in your podcast app.
- **BODY (ON COMPUTER, NAMED APP)**: Point your phone's camera at this code. It'll open the setup link on your phone so you can finish in the {app name} app.

### SMS handoff panel (phone flow only)
- **EYEBROW**: Text me the setup link
- **BODY**: We'll text you a link that opens your feed. Useful if you'd rather set this up on a different phone.
- **INPUT PLACEHOLDER**: +1 555 123 4567
- **SUBMIT BUTTON**: Text me the link →
- **SUBMIT BUTTON (SENDING)**: Sending... →
- **SUCCESS**: Sent. Check your messages — tap the link to finish setup.
- **SUCCESS ACTION**: Send another
- **ERROR (SEND FAILED)**: Could not send SMS.
- **ERROR (NETWORK)**: Could not reach the server. Please try again.
- **SELF-SMS LINK**: Or open Messages with the link pre-filled →
- **PRE-FILLED SMS BODY**: Your {show name} feed: {feed URL}
