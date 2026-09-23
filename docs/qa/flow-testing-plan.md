# Flow Testing Plan

Manual QA for the six member journeys. Grounded in the live entitlement model:
**Ark+** grants the private feed + Members Letter; **the Fold** (`circle`) grants
Circle; **Bundle** grants both. Neon is authoritative; every gate must check an
**axis**, never a SKU name.

Webhook / Beehiiv / Circle / reconcile depth lives in
[`membership-testing-plan.md`](./membership-testing-plan.md). Run that after the
happy paths here pass.

**Env:** staging / Vercel preview + Stripe **test mode**. Do not run against
production.

---

## Setup (once)

- [ ] Preview URL + Stripe test webhook enabled for it.
- [ ] Auth0 staging tenant: email one-time code + Google only (no password).
- [ ] Circle sandbox access group + SSO; Circle's own paywall **off**.
- [ ] Plus-aliased emails per case (`qa+vis-01@…`). Stripe `4242` succeeds;
      `4000…9995` declines; `4000 0027 6000 3184` is 3DS.

**Fixture accounts** (keep them live across the run):

| Alias | State |
|---|---|
| visitor | Signed out (incognito) |
| free | Signed in, no membership row |
| arkplus | Active `ark-plus` sub |
| fold | Active `circle` sub |
| bundle | Active `bundle` sub |

---

## Access matrix

Confirm this grid on every audience before walking the flow-specific cases.
**Yes** = full access. **Tease** = public marketing / gated teaser, no grant.
**No** = bounce, empty, or unplayable.

| Surface | Visitor | Free (signed in) | Ark+ | Fold | Bundle |
|---|---|---|---|---|---|
| Public podcasts | Yes | Yes | Yes | Yes | Yes |
| Paid show audio (`/plus/inside-call-me-back`) | Tease | Tease | Yes | No | Yes |
| Private RSS / `/account/podcast-feed` | No | No | Yes | No | Yes |
| Members Letter (full post) | Tease | Tease | Yes | Tease | Yes |
| Ark Daily | Yes | Yes | Yes | Yes | Yes |
| `/fold` marketing page | Yes | Yes | Yes | Yes | Yes |
| Fold app / Circle SSO | No | No | No | Yes | Yes |
| `/account/fold` tab | No | No | No | Yes | Yes |
| `/account` membership | No → `/plus` | Free pitch | Plan card | Plan card | Plan card |
| Subscribe nav | Membership + Gift | Membership + Gift | Membership + Gift | Membership + Gift | **Gift** tab only |
| Home hero CTA | Subscribe → `/plus` | Subscribe → `/plus` | Subscriber Benefits → `/account` | Subscribe → `/plus` (keys on Ark+) | Subscriber Benefits → `/account` |

The Fold-only home CTA is keyed on `arkPlus`, not “any paid”. Treat a mismatch
as a product bug to flag, not as a silent pass.

---

## 1. Visitor

Signed-out, plus signed-in with no membership (the pre-checkout identity).

| ID | Check | Expected |
|---|---|---|
| **VIS-01** | Home, podcasts hub, show pages | Public episodes play. Paid show is a join CTA, no audio. |
| **VIS-02** | `/newsletters` + a Members Letter URL | Daily is readable. Members Letter is a teaser + Subscribe, not the full body. |
| **VIS-03** | `/fold`, `/book-club`, open-house band | Public marketing, no auth spinner. Join CTAs are **Fold** and **Bundle** only (not Ark+). No real Fold posts. Upcoming open houses render or the band hides. |
| **VIS-04** | `/plus`, `/pricing` | Three SKUs (Ark+, Bundle featured, Fold). Prices from `/api/pricing`, not hardcoded. Gift lives under Subscribe. |
| **VIS-05** | `/account`, `/welcome`, `/setup`, `/account/billing` | Guests bounce to `/plus` or Auth0. No member chrome leak. |
| **VIS-06** | Sign in | Auth0 offers **emailed code** and **Google** only. Unknown email cannot receive a code (sign-ups disabled). Return-to lands back on the page. |
| **VIS-07** | Fold deep link / SSO while signed out | Lands on `/plus?from=fold` with the **guest** gate (“sign in”), not a cold pricing page. |
| **VIS-08** | Newsletter signup on home | Subscribes the address to Ark Daily. Duplicate is idempotent, not an error. |
| **VIS-09** | Signed-in free: `/account` | Greeting + Membership + Settings only. Pricing cards to join. No Podcasts / Fold tabs. |
| **VIS-10** | Signed-in free: Fold gate (`/plus?from=fold`) | **no-membership** copy (“join or renew”), not “add the Fold”. Pricing cards are the right next step. |
| **VIS-11** | URL-poke `/account/podcast-feed` and `/account/fold` while free | Redirect to `/account` or `/plus`. No empty entitled chrome. |
| **VIS-12** | About, FAQ, contact, careers, privacy, terms | Load; forms submit. |

---

## 2. Existing Ark+ subscriber

Holds `arkPlus` only. Highest leak risk: selling them a **second** Stripe
subscription instead of switching the one they have.

| ID | Check | Expected |
|---|---|---|
| **AP-01** | Sign in (code + Google) | `/api/me` is `ark-plus`. Account in nav. Home hero → `/account`. |
| **AP-02** | Members Letter + paid show | Full post. Paid episode **plays**. Private-feed CTA on the show page. |
| **AP-03** | `/account` tabs + jump cards | Membership, **Podcasts**, Settings. No Fold tab. Jump: feeds + newsletter + **Add the Fold**. |
| **AP-04** | `/account/podcast-feed` and `/setup` | Feed checklist. New members may wait ~2 min for Beehiiv to mint feeds; empty then populated, not a dead end. |
| **AP-05** | `/account/fold` and Circle SSO / app link | Tab absent; URL-poke → `/account`. SSO bounces to `/plus?from=fold` with **ark-plus-only** copy. CTA is **Add the Fold** → `/account`, **not** a pricing-card checkout. |
| **AP-06** | Add the Fold from the membership tab | Bundle **change-tier** confirm (price, cadence, proration). On confirm: entitlements become bundle, Circle access granted, **one** Stripe sub. Age attestation required. |
| **AP-07** | Preview fails | Error + retry on the panel. Must **not** open standalone checkout (that would double-bill). |
| **AP-08** | Buy Ark+ or Bundle again from `/plus` | `already_subscribed`. No second customer/subscription. |
| **AP-09** | `/fold` while entitled only for Ark+ | Still the public marketing page with join CTAs (by design). App hand-off is `/account/fold` only. |
| **AP-10** | Billing | Card on file, invoices. Cancel = period-end (access stays). Reactivate clears cancel. Receipts cannot be opted out. |
| **AP-11** | Email prefs | Daily + Members Letter. Daily off unsubscribes **both**. Letter on from unsubscribed re-subscribes + premium. Free user cannot self-grant premium. |
| **AP-12** | Nav | Subscribe menu still present (not a full member). Gift in that menu. |

---

## 3. Existing bundled subscriber

Holds both axes. Highest leak risk: **debundle** dropping the wrong axis, or
gift/nav hiding the only remaining Gift entry.

| ID | Check | Expected |
|---|---|---|
| **BU-01** | Sign in | `/api/me` is `bundle`. Both axes true. Home hero → `/account`. |
| **BU-02** | Content | Paid audio, Members Letter, private feeds, Circle SSO / Fold app all work. |
| **BU-03** | `/account` tabs | Membership, Podcasts, **The Fold**, Settings. Jump: feeds + Fold (outbound to Circle) + newsletter. **No** “add an axis” card. |
| **BU-04** | `/account/fold` | App download / open links. Session should SSO into Circle without a second login. |
| **BU-05** | Nav | Subscribe menu **hidden**. Top-level **Gift** tab present. `/plus/gift` still reachable. |
| **BU-06** | `/plus` pricing | Must not create a second sub. `already_subscribed` or no checkout CTA for an already-held SKU. |
| **BU-07** | Billing cancel | Bundle selector: keep both / keep Ark+ / keep Fold / keep none. Keep-one is a **debundle** (one sub remains, other axis revoked at the stated time). Keep-none = period-end cancel of the whole bundle. Access unchanged until then. |
| **BU-08** | After debundle to Ark+ | Fold tab gone, Circle revoked, feeds still work, offer to add Fold returns. Reverse for debundle-to-Fold. |
| **BU-09** | Retention offer | Accepting an offer does not cancel. Declining continues the chosen cancel/debundle. Survey stored. |
| **BU-10** | Email prefs | Same two-list rules as Ark+. Turning Daily off must not silently cancel a paid product they think they still have. |

---

## 4. Existing Fold subscriber

Holds `circle` only. Highest leak risk: treating them as Ark+ (feeds,
Members Letter, paid audio) or sending them through **new** checkout to add Ark+.

| ID | Check | Expected |
|---|---|---|
| **FO-01** | Sign in | `/api/me` is `circle`. Circle SSO / Fold app works. |
| **FO-02** | Ark+ surfaces | Members Letter teaser. Paid-show **audio withheld** (empty `audioUrl`). `/account/podcast-feed` and `/setup` bounce to `/account` or `/plus`. No Podcasts tab. |
| **FO-03** | `/account` | Membership, **The Fold**, Settings. Jump: Fold + newsletter + **Add Ark+**. Plan card is Fold, not Ark+. |
| **FO-04** | Add Ark+ | Same change-tier confirm as AP-06, opposite axis. Lands on bundle, one sub, Beehiiv premium + feeds mint. Age attestation required. |
| **FO-05** | Preview failure | Error + retry. No standalone Ark+ checkout (double-bill). |
| **FO-06** | Fold gate (`/plus?from=fold`) | **member** copy (“you're already in”) + Go to the Fold — not a sales pitch. |
| **FO-07** | `/fold` marketing | Still public; join CTAs still show (by design). Entry to the app is `/account/fold`. |
| **FO-08** | Home hero | Today keys on Ark+, so Fold-only still sees **Subscribe**. Flag if that is not intended. |
| **FO-09** | Billing | Same period-end cancel as Ark+ (Flow B copy). Reactivate. No private-feed setup in the cancel path. |
| **FO-10** | Email prefs | Daily only unless they somehow hold premium — `canPremium` is false. Cannot self-grant Members Letter. |
| **FO-11** | Buy Fold again from `/plus` | `already_subscribed`. |
| **FO-12** | Open houses / book club | Marketing still public. Live Fold rooms only inside Circle, not on the website. |

---

## 5. Creating a subscription

Guest or free user buying a **new** sub. Single-axis members adding the other
product belong in AP-06 / FO-04, not here.

| ID | Check | Expected |
|---|---|---|
| **SUB-01** | Entry points | Checkout opens from `/plus`, `/pricing`, `/fold` (Fold + Bundle only), home Subscribe. Modal matches the card clicked. |
| **SUB-02** | Six happy paths | Ark+ / Fold / Bundle × monthly / yearly. `4242` succeeds. Redirect / in-modal complete. `/api/me` matches the SKU. |
| **SUB-03** | Fan-out (each SKU) | Neon row live. Ark+ axis → Beehiiv premium + feeds. Circle axis → Circle access group. Bundle → both. Auth0 is identity only (no tier claim). |
| **SUB-04** | Post-checkout session | Auto-login via checkout token. `/welcome` shows the right steps: feeds if Ark+, Fold app if Circle, both if Bundle. Webhook lag → all steps shown rather than none. |
| **SUB-05** | Welcome email | Arrives. Feed-setup and sign-in links work on a **fresh** browser (OTP, not a spent magic link). |
| **SUB-06** | Email step | Pre-creates the Stripe customer. Signed-in user's email is used; changing it to someone else's paid address must not hijack that membership. |
| **SUB-07** | PWYC | Floor = suggested. Drag + typed amount above floor charge that amount. Below floor rejected. |
| **SUB-08** | Promo, currency, tax | Auto-applied coupon visible. Currency from geo / selector. Tax + total match Stripe. |
| **SUB-09** | Consent | Renewal copy matches cadence. **Age attestation** on Fold and Bundle (self); **not** on Ark+. Pay disabled until ticked. |
| **SUB-10** | Declined card | `4000…9995`: no sub, no Neon row, `/api/me` still free. |
| **SUB-11** | 3DS | Challenge appears; success activates, abandon does not. |
| **SUB-12** | Already subscribed | Same email with a live sub → 409 `already_subscribed`, no second Stripe sub. (The dangerous case: Ark+ member buying Fold from a **pricing card** instead of `/account`.) |
| **SUB-13** | Rate limit | >5 session creates / email / hour → 429. |
| **SUB-14** | Invalid input | Bad plan/tier/email → 400, no Stripe objects. |

---

## 6. Gifting a subscription

Anyone can buy a gift. Redemption is identity-keyed on the **recipient**.

| ID | Check | Expected |
|---|---|---|
| **GIFT-01** | `/plus/gift` as guest, free, Ark+, Fold, Bundle | Form works. Bundle members reach it via the Gift **tab**; everyone else via Subscribe → Gift. |
| **GIFT-02** | Six purchases | Ark+ / Fold / Bundle × 6 months / 1 year. Giver + recipient emails required. Optional names/message. Localized total. Age attestation is on the **recipient** for Fold/Bundle. |
| **GIFT-03** | Pay + confirm | `4242` succeeds. Home `?gift=complete` toast. Giver is **not** entitled. Recipient is not entitled until they redeem. |
| **GIFT-04** | Recipient email | Magic-link (`?mt=`) auto-logs-in, redeems, strips `mt` from the URL, lands on `/welcome?claimed=1` with a “how to sign in next time” step. |
| **GIFT-05** | Fallback `?token=` | Guest is asked to sign in first; signed-in recipient redeems. Wrong account must not grant. |
| **GIFT-06** | Replay / already claimed | Second click → terminal “already claimed”. No double grant, extend, or credit. |
| **GIFT-07** | Expired / garbage link | Terminal copy; no membership write. |
| **GIFT-08** | Fresh recipient | Membership row + the gifted axis(es). Welcome/onboarding matches the gift, not a phantom SKU. |
| **GIFT-09** | Stacking (see matrix) | Grant / extend / credit / mixed match the table. UI copy matches `applied`. |
| **GIFT-10** | Gift-only member | No card / no subscription on billing. Near-expiry banner inside 14 days. After expiry, axes drop; Circle removed; feeds/letter lock. |
| **GIFT-11** | Gift + live sub on the other axis | Effective tier is the **union** (bundle-equivalent) without a second Stripe sub. Account offers nothing they already hold. |
| **GIFT-12** | Self-gift / same giver+recipient | Either blocked with a clear error or redeems as a normal grant. Document which. |
| **GIFT-13** | Declined gift payment | No email, no redeemable row. |

### Gift stacking matrix

What happens when the recipient already has something. `applied` is what `/redeem`
must show.

| Recipient now | Gift | Result | `applied` |
|---|---|---|---|
| None | any | Grant those axes from now | `membership` |
| Ark+ sub | Ark+ | Extend paid sub; no extra grant | `extended` |
| Fold sub | Fold | Extend paid sub | `extended` |
| Bundle sub | Bundle | Extend paid sub | `extended` |
| Ark+ sub | Bundle | Grant Fold **and** extend Ark+ sub | `mixed` |
| Fold sub | Bundle | Grant Ark+ **and** extend Fold sub | `mixed` |
| Ark+ sub | Fold | Grant Fold (union → bundle-equivalent) | `membership` |
| Fold sub | Ark+ | Grant Ark+ (union → bundle-equivalent) | `membership` |
| Bundle sub | Ark+ or Fold | Full amount → Stripe customer credit; no extend | `credit` |
| Live gift, same axis | same axis | New term starts at the **current** expiry (stacks) | `membership` |
| Expired gift | any | Term starts **now** | `membership` |

---

## Cross-cutting (run once per fixture)

| ID | Check | Expected |
|---|---|---|
| **X-01** | Sign out | Session gone; member URLs bounce; Circle SSO no longer works. |
| **X-02** | Two browsers | Same account, no cross-user leakage of `/api/me` or feeds. |
| **X-03** | Mobile + desktop | Nav, checkout, account tabs, Fold hand-off. |
| **X-04** | Pending cancel | Still fully entitled until period end; banner + reactivate on billing. |
| **X-05** | `past_due` | Access **stays** until Stripe deletes the sub. Then the free row of the matrix. |

---

## Exit criteria

- [ ] Access matrix holds for visitor, free, Ark+, Fold, and Bundle.
- [ ] No second Stripe subscription created from an add-axis or “already a member” path.
- [ ] Fold gate copy matches audience (guest / none / Ark+-only / member).
- [ ] All six new-sub SKU × cadence paths activate the right axes.
- [ ] Gift redeem stacking matches the matrix, including Bundle-subset **credit**.
- [ ] Cancel / debundle leave access in place until the stated date, then revoke only the dropped axis.
- [ ] Lifecycle fan-out (Beehiiv, Circle, Neon) checked per [`membership-testing-plan.md`](./membership-testing-plan.md) Suites A–C.
