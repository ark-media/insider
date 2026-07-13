# Mobile Responsiveness Audit

**Date:** 2026-07-13 · **Branch:** `demo-full-site` · **Context:** 63% of site traffic is mobile.

Method: Chrome device emulation at 390×844 (iPhone 14/15, the modal phone width), 320×568
(iPhone SE / small Android / split-screen), and 1440×900 desktop. All measurements are from the
live dev server, not from reading code.

---

## Anti-Patterns Verdict: **PASS**

This does not look AI-generated. Checked against the frontend-design skill's DON'T list:

| Tell | Present? |
|---|---|
| Generic fonts (Inter, Roboto, system) | No — Exo (display) + Lato (body) |
| Purple-gradient-on-white AI palette | No — navy/cyan brandbook, committed |
| Gradient text | No |
| Glassmorphism | Borderline — see below |
| Hero metrics row | No |
| Everything-is-a-card-grid | Partially — see below |
| Gray text on colored bg | No — semantic `fg-*` tokens throughout |
| Nested cards | No |
| Bounce/elastic easing | No — `cubic-bezier(0.16, 1, 0.3, 1)` throughout |

Two minor tells worth noting, neither disqualifying:

- **The cyan halo is over-used.** `absolute -inset-4 -z-10 bg-cyan/10 blur-2xl` appears behind
  `NewsletterVisual`, `PhoneFrame`, `PlusVisual`, and `HeroShowStack` — four separate glow-behind-
  the-object treatments. It's the one gesture in the system that reads as generic. `/quieter` on
  two of the four would restore its impact.
- **Card-grid monotony on the hub pages.** `/podcasts` and `/hosts` are each a single uniform grid
  and nothing else. The codebase already has the antidote — `NumberedRow` in `ContentCard.tsx`
  ("Editorial row variant — for hub pages where we want to break the card grid monotony") — but
  neither hub uses it.

The design system itself is genuinely strong: real token layer, semantic foreground scale with
documented contrast reasoning, a full light-theme inversion, `prefers-reduced-motion` honored on
every animation, a 14px type floor "for accessibility". Whoever wrote `index.css` was paying
attention.

---

## Executive Summary

**23 issues: 2 Critical, 6 High, 9 Medium, 6 Low.**

Your hypothesis is **half right**, and the half that's wrong matters.

Image *sizing* is not really the problem — image **payload** and **grid column count** are.

1. **Images are catastrophically unoptimized.** 26.2 MB of raster in `public/`. `/hosts` alone
   ships **10.9 MB of images** to render eight 342×428 portraits. `deborah-pardes.jpg` is a
   **6.7 MB, 3678×3024** file displayed at 342px wide. `yael-wissner-levy.jpg` is **6679×5343** —
   a 35-megapixel photo. There is **no `srcset`, no `sizes`, no `<picture>`, and no image
   optimization pipeline anywhere in the codebase.** On a real 4G phone this page is unusable for
   20+ seconds, and the portraits render as empty navy boxes while they load (reproduced — see
   Critical #1).

2. **The scroll problem is a grid problem, not an image problem.** Every card grid is
   `grid-cols-1 sm:grid-cols-2`. Tailwind's `sm` is 640px. **No phone is 640px wide.** So 100% of
   your mobile traffic gets a single column, every card is a full-viewport-width square, and pages
   run 7–11 screens. Going to two columns at the base breakpoint roughly halves `/podcasts` and
   `/hosts` with no other change.

3. **`/plus` — the page that takes money — horizontally overflows at 320px.** The billing-period
   toggle is an `inline-flex` measuring 308px inside a 272px content box, forcing the layout
   viewport to 332px on a 320px device. Isolated by hiding the element: viewport snaps back to 320.

### Scroll depth (viewport-heights, top to bottom)

Original audit figures, with the post-fix 390px number alongside (C1/C2/H1/H2/H3 landed
2026-07-13):

| Route | 320px | 390px | 1440px | Mobile penalty | **390px now** |
|---|---|---|---|---|---|
| `/` | **11.0** | **7.2** | 4.1 | 1.8× | **5.7** |
| `/hosts` | **10.1** | **7.5** | 3.1 | 2.4× | **3.0** |
| `/community` | 8.8 | 5.5 | 4.0 | 1.4× | 5.5 (untouched — needs `/distill`) |
| `/plus` | 8.6 | 5.6 | 3.3 | 1.7× | 5.6 (untouched — needs `/distill`) |
| `/podcasts` | 5.4 | 3.9 | 2.2 | 1.8× | **2.0** |
| `/israel-votes` | — | 4.6 | 3.3 | 1.4× | 4.6 (untouched) |

The three image/grid-driven pages are fixed. `/plus` and `/community` are unchanged because their
length is copy volume, not layout — see H6.

Desktop is fine (2–4 screens). The heavy-scroll complaint is overwhelmingly a mobile problem, and
the two worst pages (`/`, `/hosts`) are both image-grid-driven.

**Note:** `/plus` and `/community` are long for a *different* reason — content volume, not images.
`/plus`'s body contains **zero images**; it's 4,742px of hero + benefits + pricing + FAQ. Image
work will not shorten those two. They need `/distill`.

---

## Critical

> **Both Critical issues were fixed on 2026-07-13.** See "Resolution" under each. The High /
> Medium / Low findings below are still open.

### C1. `/hosts` ships 10.9 MB of images; portraits render as empty boxes while loading
**Status: ✅ RESOLVED**
**Location:** `public/hosts/*.jpg`, `src/components/HostArtwork.tsx:31-37`
**Category:** Performance / Responsive

Measured via `performance.getEntriesByType('resource')` on `/hosts` at 390px:

| File | Transferred | Intrinsic | Displayed | Waste |
|---|---|---|---|---|
| `deborah-pardes.jpg` | **6.71 MB** | 3678×3024 | 342×428 | ~99.9% |
| `yael-wissner-levy.jpg` | **2.05 MB** | 6679×5343 | 342×428 | ~99.9% |
| `yossi-klein-halevi.jpg` | 0.79 MB | 1000×998 | 342×428 | — |
| `nadav-eyal.jpg` | 0.71 MB | 2280×1346 | 342×428 | — |
| **Page total** | **10.86 MB** | | | |

**Impact:** On Fast 4G (~1.6 Mbps effective) this is ~55 seconds of image transfer. `HostArtwork`
uses `loading="lazy"` with an `aspect-[4/5]` frame, so there's no layout shift — but there's also
no placeholder, so the user scrolls past a column of **empty navy rectangles**. I reproduced this:
a full-page screenshot of `/hosts` shows 5 of 8 portraits blank. It reads as a broken page. On a
metered plan you are also spending ~11 MB of someone's data allowance on a bio page.

**Recommendation:** This is the single highest-impact fix on the site.
1. Resize the source files. Nothing on this site displays wider than ~700 CSS px; a 1400px-wide
   JPEG at q80 covers every use including 2× DPR. Expect 26.2 MB → **under 2 MB** total.
2. Add responsive images. You're a Vite SPA on Vercel, so `next/image` isn't available, but
   Vercel's Image Optimization API is framework-agnostic — add an `images` block to `vercel.json`
   and serve `/_vercel/image?url=…&w=…&q=…` with a real `srcset`/`sizes`. Alternative:
   `vite-imagetools` to generate AVIF/WebP `srcset` at build.
3. Add a `bg-navy-900` + blurred-placeholder or the existing initials art as the loading state, so
   a slow portrait never renders as a void.

**Suggested command:** `/optimize`

**Resolution (2026-07-13):** Every JPEG in `public/` was capped at a 1200px longest edge and
re-encoded at q80 (`sips`). 1200px covers the largest on-site display width (446px — the show-page
cover) at 2.7× DPR. Two files (`amit-segal.jpg`, `yonatan-adiri.jpg`) were already well-compressed
and grew under re-encoding, so they were reverted to their originals.

| | Before | After |
|---|---|---|
| `public/` raster total | 26.2 MB | **4.7 MB** (−82%) |
| `/hosts` image payload | 10.86 MB | **1.03 MB** (−91%) |
| `deborah-pardes.jpg` | 6.71 MB (3678×3024) | 264 KB (1200×986) |
| `yael-wissner-levy.jpg` | 2.05 MB (6679×5343) | 135 KB (1200×960) |
| `inside-cmb.jpg` | 4.53 MB (4000×4000) | 202 KB (1200×1200) |
| `shows/call-me-back.jpg` | 1.55 MB (2048×2048) | 222 KB (1200×1200) |

Verified: all 10 portraits on `/hosts` now load (0 broken; 5 previously rendered blank), covers are
visually identical, build passes. **This does not close H4** — there is still no `srcset`, so a
390px phone downloads the same 1200px file as a desktop. The pipeline work remains open.

### C2. `/plus` horizontally overflows at 320px — on the conversion page
**Status: ✅ RESOLVED**
**Location:** `src/components/Pricing.tsx:125` (`role="group" aria-label="Billing period"`)
**Category:** Responsive · **WCAG 1.4.10 Reflow (AA)**

```jsx
<div role="group" aria-label="Billing period" className="inline-flex border border-rule-strong p-1">
```

Measured at 320×568:

- Toggle intrinsic width: **308px**. Available content box: **272px** (320 − 48px gutters).
- Its right edge lands at **332px** — 12px past the device width.
- The browser widens the layout viewport to 332px to fit it, so `window.innerWidth` reports 332.
- **Causal proof:** setting `display:none` on this one element drops `innerWidth` 332 → 320.
  Every other section leaves it at 332.

The two buttons measure 131px ("MONTHLY") and 167px ("YEARLY −17%") — `px-6` padding plus
`button-text`'s `0.18em` letter-spacing plus the savings badge. `inline-flex` refuses to shrink
below content and there's no wrap.

**Impact:** On iPhone SE, small Androids, and any phone in split-screen, the entire Ark+ pricing
page renders shrunk-to-fit and horizontally scrollable. WCAG 1.4.10 requires content to reflow to
320px CSS width without horizontal scrolling. This is the page that takes money, and it is the
*only* true horizontal overflow on the site — everything else is clean at 320px.

**Recommendation:** Make the toggle fluid: `flex w-full max-w-sm` with `flex-1` buttons, drop
`px-6` to `px-4` at base, and move the `−17%` badge below the label (or to a `sr-only` + visual
chip) at the smallest size.

**Suggested command:** `/adapt`

**Resolution (2026-07-13):** The toggle is now `flex w-full … sm:inline-flex sm:w-auto` with
`flex-1 justify-center px-3 … sm:flex-none sm:px-6` buttons — fluid (two equal halves) on phones,
intrinsic from `sm` up.

- At 320px: `innerWidth` 332 → **320**, no horizontal scroll, no text overflow inside either
  button, and both keep their 44px height.
- At 1440px: toggle is 308px with 131px/167px buttons — **byte-identical to before.**
- Swept all 13 routes at 320px: **zero horizontal overflow site-wide.** WCAG 1.4.10 now satisfied.

---

## High

### H1. Every card grid skips the phone breakpoint entirely
**Status: ✅ RESOLVED** (cover/portrait grids). `LatestEpisodes` deliberately left for H2.
**Location:** `src/routes/podcasts/index.tsx:21`, `src/routes/hosts/index.tsx:52`,
`src/routes/index.tsx:557`, `src/components/LatestEpisodes.tsx:157`
**Category:** Responsive

All four read `grid-cols-1 sm:grid-cols-2 …` (or `md:grid-cols-3`). Tailwind's `sm` is **640px**
and `md` is **768px**. Phones are 360–430px. **The two-column layout never renders for a single
mobile visitor** — 63% of your traffic sees one card per row, forever.

Measured consequence at 390px:

| Grid | Per-card height | Cards | Section height |
|---|---|---|---|
| `/podcasts` covers | ~570px | 4 | **2,282px** |
| `/hosts` portraits | ~560px | 8 | **5,406px** |
| Home "Four shows." | ~280px | 4 | **1,358px** |
| Home "Latest episodes" | ~450px | 3 | **1,354px** |

**Impact:** This is the primary driver of the heavy-scroll complaint. Two columns at the base
breakpoint (a 155px cover on a 390px phone is entirely legible — Spotify and Apple Podcasts both
do exactly this) roughly halves `/podcasts` and `/hosts`.

**Recommendation:** `grid-cols-2 sm:grid-cols-2 lg:grid-cols-3` for the cover/portrait grids.
Drop the per-card body copy to a 2-line clamp at the base size, or hide it below `sm` — at 155px
wide it isn't doing work anyway.

**Suggested command:** `/adapt`

**Resolution (2026-07-13):** The three cover/portrait grids now start at **two columns**, and the
card copy is hidden below `sm` (`max-sm:hidden`) — a 163px card leaves a ~130px text column, which
is ~14 characters a line. The art and title carry the browse grid on phones; the description
returns at 640px, and the full text is always one tap away on the show/host page. This is the
Crooked / Spotify / Apple Podcasts browse-grid pattern.

| Route (390px) | Before | After | |
|---|---|---|---|
| `/podcasts` | 3,298px (3.9 screens) | **1,646px (2.0)** | −50% |
| `/hosts` | 6,364px (7.5 screens) | **2,494px (3.0)** | −61% |
| `/` "Four shows." section | 1,358px | **737px** | −46% |
| `/` total | 6,110px (7.2 screens) | **5,489px (6.5)** | −10% |

Home moves least because its biggest section, "Latest episodes" (1,354px), is **untouched** — that
grid needs H2's horizontal-row treatment, not a column bump. Two columns would squeeze long episode
titles into an unreadable strip. It is deliberately still `grid-cols-1 md:grid-cols-3`.

Also fixed along the way:
- **Two-line CTA.** `eyebrow`'s 14px + 0.22em tracking wrapped "Visit show →" so the arrow fell to
  its own line in a two-up column. Tightened to 11px / 0.1em below `sm`.
- **A clamp bug I introduced and caught.** The first pass used `hidden sm:block`, whose
  `display: block` silently overrides `line-clamp`'s `display: -webkit-box` — which *unclamped*
  every card description at ≥640px and blew out the desktop row heights ("For Heaven's Sake" ran to
  ~10 lines). `max-sm:hidden` doesn't touch `display` above the phone. Verified: all four home
  cards are a uniform 300px on desktop again.

Verified at 320 / 390 / 768 / 1440: no horizontal overflow, copy hidden below `sm` and visible
above it, desktop `lg` 50/50 split unchanged. Build and typecheck pass. (`npm run lint` reports 4
errors in `src/lib/launchMode.tsx` — pre-existing, confirmed by stashing.)

### H2. Episode thumbnails waste 44% of their box to letterboxing
**Status: ✅ RESOLVED**
**Location:** `src/components/LatestEpisodes.tsx:46-54`
**Category:** Responsive / Performance

```jsx
<Link className="… relative block aspect-video overflow-hidden bg-navy-900 p-2 sm:p-3 …">
  <img … className="h-full w-full object-contain …" />
```

A **16:9 box** with `object-contain` on a **1:1 source** (Simplecast episode art is square).
Measured at 390px: box is 340×191, the image renders at 191×191, and **44% of every episode
media box is empty navy**. Three cards on the home page → ~450px of pure dead space, plus the
optical mess of a square floating in a wide letterbox.

**Impact:** Wasted vertical space on the highest-traffic page, and it looks unintentional.

**Recommendation:** Either switch the box to `aspect-square` and let it be a square cover
(`object-cover`), or — better, and this is what Crooked does — make the episode card a **horizontal
row on mobile**: 96px square thumb left, date/show/title/play right. That converts each card from
~450px tall to ~120px and cuts the section from 1,354px to under 400px.

**Suggested command:** `/adapt`

**Resolution (2026-07-13):** Both halves of the recommendation, since they're complementary.

1. **The media box is now square** (`object-cover`), matching the source art. The letterbox is gone
   at every breakpoint — measured waste is now **0%**, down from 44%.
2. **The card is a horizontal row below `md`** — a 112px square thumb on the left, date / show /
   title / play on the right — and becomes the three-up vertical card exactly when the grid does.

| | Before | After |
|---|---|---|
| Episode card (390px) | ~450px tall | **171px** |
| "Latest episodes" section (390px) | 1,354px | **689px** (−49%) |
| Media box waste | 44% | **0%** |

**Desktop grew slightly and that's intentional.** The square art at `md`+ renders 393×393 instead
of a 393×221 letterbox, so the section goes 611px → 781px and the page 4.1 → 4.2 screens. It buys
full-bleed episode art with no dead navy, which is a clear visual win on a page that was never
scroll-constrained on desktop. Verified at 320 / 390 / 640 / 768 / 1440 — the row↔card flip is
clean at every step and nothing overflows.

### H3. The home "Four shows." cards crush body copy into a 122px column
**Status: ✅ RESOLVED** (fixed as part of H1)
**Location:** `src/components/ContentCard.tsx:57-64` (`CardBody`, the `media` branch)
**Category:** Responsive / Typography

```jsx
<div className="flex w-1/2 shrink-0 items-center border-r border-rule p-6">{media}</div>
<div className="flex w-1/2 flex-col justify-start p-6"><CardText … /></div>
```

A hard 50/50 split with `p-6` (24px) on both halves. Measured at 390px:

- Card: 342px → each half 170px → **text column is 122px of usable width**.
- At 15px Lato that's roughly **14 characters per line** (the readable range is 45–75).
- "For Heaven's Sake" wraps to **3 lines** and consumes 76px of height for a 4-word title.

**Impact:** The body copy renders as an unreadable ribbon 2–3 words wide. This is the worst
typography on the site and it's on the home page.

**Recommendation:** Below `sm`, either stack the media above the text (full-bleed cover, text
under) or shrink the media to a fixed `w-28` thumb and let the text take the remaining ~200px.
The 50/50 split only earns its keep above ~500px.

**Suggested command:** `/adapt`

**Resolution (2026-07-13):** `CardBody`'s media branch now **stacks** (full-bleed cover above the
copy) and only becomes the 50/50 split at **`lg`**, where the card is wide enough to leave the text
a ~250px column. The old `sm:grid-cols-2` + 50/50 split combination was broken at 640–1023px too —
a 280px card split in half left a 92px text column — so this fixes the tablet range as well, not
just phones.

### H4. No responsive image machinery exists anywhere
**Status: ✅ RESOLVED**
**Location:** whole codebase
**Category:** Performance

`grep -rln "srcset\|<picture\|sizes=" src/` → **no matches**. `vite.config.ts` has no image plugin.
`vercel.json` has no `images` block. Every `<img>` on the site ships its full-resolution source to
every device, and a 390px phone downloads the exact same bytes as a 5K iMac.

Show covers are 2048×2048 (`call-me-back.jpg` = 1.55 MB) and render at 121–340px.

**Impact:** Compounds C1 across every page. Home ships four 2048px show covers to render them at
121px thumbs.

**Recommendation:** See C1. One pipeline fixes every page at once.

**Suggested command:** `/optimize`

**Resolution (2026-07-13):** Static width variants plus a real `srcset`/`sizes`, with no host
dependency and nothing new on the build path.

- `scripts/gen-image-variants.sh` writes `-400.jpg` / `-800.jpg` next to each source, **never
  upscaling** (a source already ≤ the target gets no variant), and emits `src/lib/image-variants.ts`
  — a manifest of the widths actually on disk. A component can't stat the filesystem, and a
  `srcset` naming a file that doesn't exist is a 404 the browser may still choose, so the generator
  records what it wrote.
- `srcSet()` in `src/lib/images.ts` builds the attribute from that manifest and returns `undefined`
  when an image has no variants — the plain `src` then stands alone, which is the right fallback.
- Wired into `ShowCover` and `HostArtwork` (both take a `sizes` prop defaulting to the browse grid,
  `"(min-width: 1024px) 33vw, 50vw"`) and the `inside-cmb.jpg` thumb, which declares `sizes="80px"`
  because it isn't in that grid.

Measured on a 390px phone at **DPR 2** (the common case), against the *original* pre-audit payload:

| Page | Originally | After C1 | **After H4** |
|---|---|---|---|
| `/hosts` | 10,860 KB | 1,030 KB | **225 KB** (−98%) |
| `/podcasts` | ~3,658 KB | 639 KB | **166 KB** (−95%) |
| `/inside-call-me-back` | 4,640 KB | 202 KB | **42 KB** (−99%) |

At **DPR 3** the browser correctly steps up to the 800w files (`/hosts` = 724 KB); on a retina
desktop it picks the full-size original. Verified by reading `currentSrc` at each breakpoint, and
visually — the 400w portraits are sharp at 2×.

Chosen over Vercel's Image Optimization API deliberately: `/_vercel/image` doesn't run under `vite
dev`, so it could not have been verified locally before shipping. This approach is fully checkable
in the browser right now and works identically in dev and prod. Cost is 57 committed variant files
(`public/` is 4.7 MB → 7.6 MB **on disk**, but what a phone *downloads* drops by ~95%).

**Not covered:** episode thumbnails come from `image.simplecastcdn.com` and are outside this
pipeline. They render at 112px and are the largest remaining image cost on the home page.

### H5. Hero art is `hidden lg:block` — mobile gets a wall of text
**Location:** `src/routes/index.tsx:528`
**Category:** Responsive / Design

```jsx
<div className="hidden lg:block"><HeroShowStack /></div>
```

`HeroShowStack` — the fanned deck of four covers, the most distinctive thing on the page — is
**hidden from 63% of your traffic**. The mobile hero is a headline, a 78-word paragraph, and a
button, above the fold. The paragraph is doing all the work and it is long.

**Impact:** Mobile users get the least interesting version of the strongest asset. The show art is
the reason someone recognizes this as Ark Media.

**Recommendation:** Show a scaled-down fan (or a single hero cover) above the headline on mobile.
It costs ~180px and buys the page an identity. Simultaneously, `/distill` the 78-word hero
paragraph — it's ~4 sentences where 1 would land.

**Suggested command:** `/adapt`, then `/distill`

### H6. `/plus` and `/community` are 5.5+ screens of pure copy
**Location:** `src/routes/plus/`, `src/routes/community.tsx`
**Category:** Design / Responsive

Contrary to the image-sizing hypothesis, these two pages contain **almost no images**. Measured
section heights on `/plus` at 390px (total image height in the body: **0px**):

| Section | Height |
|---|---|
| "The full Ark Media experience." | 1,098px |
| "Three things, one membership." | 821px |
| "Pick your own terms." (pricing) | 1,235px |
| "Frequently asked." | 844px |

`/community` is 3,469px in a single section.

**Impact:** 5.6 screens to buy a subscription. Every additional screen between a visitor and the
pricing toggle is conversion lost, and this is the funnel page.

**Recommendation:** This is an editing problem, not a layout problem. Cut sections, tighten copy,
and consider anchoring a "See pricing ↓" jump from the `/plus` hero. Collapse the FAQ into an
accordion (844px → ~300px).

**Suggested command:** `/distill`

---

## Medium

### M1. Footer nav links are 28px tall
**Location:** `src/components/Footer.tsx`
**Category:** Accessibility · **WCAG 2.5.8 Target Size (AA, 24×24) — passes; WCAG 2.5.5 (AAA, 44×44) — fails**

All 14 footer links measure **28px tall** at 390px. They clear the WCAG 2.2 AA floor of 24×24, but
miss both Apple HIG (44pt) and Material (48dp). The footer is 647px tall on mobile and is the
primary navigation surface once someone has scrolled a 7-screen page.

**Recommendation:** `py-2` on the link (28 → 44px) costs ~110px of footer height and makes it
thumb-usable.

**Suggested command:** `/adapt`

### M2. "LEARN MORE →" is a 14px-tall tap target
**Location:** `src/routes/index.tsx:441-447` (Community band `Learn more` link)
**Category:** Accessibility · **WCAG 2.5.8**

Measured **135×14px**. It survives WCAG 2.5.8 only on the spacing exception. It's a bare text link
with no padding acting as a section CTA.

**Recommendation:** Give it `min-h-11 inline-flex items-center` like `bandCtaClass` does.

**Suggested command:** `/adapt`

### M3. The "NEW" badge is clipped at 320px
**Location:** `src/components/LatestEpisodes.tsx:108`
**Category:** Responsive

```jsx
className="pointer-events-none absolute -left-6 top-0 … sm:-left-8 …"
```

`-left-6` = −24px, exactly cancelling `--spacing-gutter` (24px). At 390px it lands flush at x=0
— pixel-perfect but with zero margin for error. At **320px it measures `left: -5px`** and the
badge is sliced by the viewport edge. It's `aria-hidden` so there's no a11y impact, just a visibly
broken decoration on small phones.

**Recommendation:** Clamp with `-left-2 sm:-left-8`, or anchor it inside the card.

**Suggested command:** `/polish`

### M4. Show covers ship at 2048×2048 to render at 121px
**Location:** `src/components/ShowCover.tsx:27-36`, `public/shows/*.jpg`
**Category:** Performance

`ShowCover` hardcodes `width={800} height={800}` while the actual files are 2048×2048 (1.55 MB for
`call-me-back.jpg`). The `width`/`height` attributes are wrong *and* irrelevant — they don't
resize anything, they only hint aspect ratio (which `aspect-square` already does).

**Recommendation:** Fold into the C1/H4 pipeline. `sizes="(min-width: 640px) 33vw, 50vw"` plus a
real `srcset`.

**Suggested command:** `/optimize`

### M5. `/hosts` has no `h1`-to-`h2` continuity for the two groups
**Location:** `src/routes/hosts/index.tsx:49`
**Category:** Accessibility

`<h2 className="label text-cyan">` renders "Hosts" and "Contributors" at 14px uppercase. It's
semantically correct, but the `label` utility strips it of any visual heading weight, so sighted
users get no group separation while screen-reader users do. Minor mismatch.

**Recommendation:** Give the group headings visible weight, or use a `<div>` + `aria-labelledby`.

**Suggested command:** `/polish`

### M6. Portrait aspect ratio is fixed at `4/5` across all breakpoints
**Location:** `src/components/HostArtwork.tsx:26`
**Category:** Responsive

`aspect-[4/5]` at every size. In a single-column mobile grid this produces a **342×428** portrait —
taller than it is wide, on the narrowest screen, for ten people in a row. The ratio is right for a
3-up desktop grid and wrong for a 1-up mobile stack.

**Recommendation:** `aspect-square sm:aspect-[4/5]`, or (better) fix H1 and let the 2-col grid make
the portraits small enough that 4:5 is fine.

**Suggested command:** `/adapt`

### M7–M9 (brief)
- **M7.** Episode title links are 300×40px — under the 44px comfort threshold.
  (`LatestEpisodes.tsx:73-80`) → `/adapt`
- **M8.** The `bg-cyan/10 blur-2xl` halo appears 4× (`index.tsx:56,126,265,331`). Over-used; see
  the Anti-Patterns note. → `/quieter`
- **M9.** `public/inside-cmb.jpg` is **4.53 MB**. Second-largest file on the site. → `/optimize`

---

## Low

- **L1.** `public/hosts/.DS_Store` is committed (6 KB). → `.gitignore`
- **L2.** `ArkNewsDailyArtwork` and the `ShowCover` gradient fallback run two infinite `drift`
  animations each; four of them are live on `/podcasts` simultaneously. They animate `opacity` and
  `translate3d` (both compositor-safe), and `prefers-reduced-motion` kills them — so this is
  correct, just worth knowing. → no action
- **L3.** `text-[240px]` initials in `HostArtwork` overflow their frame at 320px, but the frame is
  `overflow-hidden` so it's intentional. Verified, not a bug. → no action
- **L4.** `/events` is 1.5 screens on mobile — the lightest page on the site, and a good model.
- **L5.** `ShowCover`'s `width={800} height={800}` doesn't match the 2048px sources. Cosmetic
  inaccuracy today; becomes a real CLS bug the moment someone removes `aspect-square`. → `/polish`
- **L6.** Tailwind's `sm:` (640px) is used as if it means "phone landscape / small tablet", but
  every grid treats it as "not a phone". Consider adding an `xs: 480px` breakpoint so there's a
  place to put genuinely-phone-only rules. → `/normalize`

---

---

## Addendum: `/plus` and `/community` are not live (found 2026-07-13)

Both routes are wrapped in `HardLaunchOnly` (`plus/index.tsx:12`, `community.tsx:23`), and
`launchMode` defaults to `"soft"`. **In the soft launch that production currently serves, neither
page is reachable** — and home hides its Community and Ark+ bands, making it **4.1 screens**, not
the 5.7 measured with a hard-launch dev server.

This materially lowers the priority of H6 (their copy volume): it is work on pages no one can load.
It does not lower the priority of two things found while looking:

- **`/community` ships two placeholder feature blocks** (`community.tsx:200-216`) — titled
  "Placeholder feature", badged "Coming soon", with skeleton phone mockups and body copy reading
  *"This slot is reserved for the next app feature once it's confirmed."* Roughly 1,700px of the
  page. Deliberate scaffolding (there's a comment saying so), but it becomes public the moment hard
  launch flips. **Treat as a launch blocker, not a scroll issue.**
- **`/plus` states the Ark+ benefits three times** — the hero's 5 bullets (`Hero.tsx:30-43`), then
  "Three things, one membership" (`Benefits.tsx`) saying the same thing at more length, then "Every
  Ark+ member gets" (`Pricing.tsx:250`). The third sits beside the price, which is legitimate
  conversion practice; the **hero bullets are the redundant pair** and are the ones to cut.
- `Hero.tsx:71` renders a placeholder Ark+ mark ("final artwork TBD") and a fabricated
  "Ark+ Member No. 00214" badge.

These are content/product calls, not engineering ones — deliberately left alone.

Also noticed: **`public/team/` (12 photos, ~4 MB pre-optimization) is rendered nowhere.**
`src/data/team.ts` has no importers. Either dead weight or an unfinished About page.

---

## Patterns & Systemic Issues

1. **`sm:` is being used as the mobile breakpoint, and it isn't one.** Four separate grids assume
   `sm` (640px) covers phones. It covers no phone. This one misconception produces the single
   biggest scroll cost on the site.
2. **Zero image discipline.** No resizing, no `srcset`, no format negotiation, no build step.
   26.2 MB of raster for a site whose largest display size is ~700px. Three files (6.7 MB, 4.5 MB,
   2.0 MB) account for **half the total**.
3. **Fixed aspect ratios that don't respond.** `aspect-square` (ShowCover), `aspect-[4/5]`
   (HostArtwork), `aspect-video` (LatestEpisodes) are hardcoded at every breakpoint. Each is
   correct for its desktop grid and wrong for a 1-up mobile column.
4. **Touch targets cluster at 28px and 40px.** Consistently just under the 44px comfort line,
   never egregiously so. Systemic, not incidental — it suggests no one has run a target-size pass.

---

## Positive Findings

Worth protecting:

- **No horizontal scroll at 390px anywhere on the site.** Thirteen routes checked. Only `/plus`
  fails, and only at 320px. That's a better result than most production sites.
- **Zero layout shift from images.** Every `<img>` sits in an `aspect-*` box that reserves its
  space before load. The 10.9 MB of `/hosts` portraits pop in without moving a single pixel.
  Whoever did this understood CLS.
- **`prefers-reduced-motion` is honored on every animation** (`index.css:659-666`) — `rise`,
  `live-dot`, `draw-rule`, `drift`, `draw-check`, and `animate-spin` all disabled. This is rarer
  than it should be.
- **The token layer is real and the comments explain *why*.** `index.css` documents why light-mode
  cyan is darkened to `#0a6fad` (AA on paper), why filled cyan buttons get `#0d3e74` instead, and
  why the `:not(:hover)` qualifier is load-bearing. The 14px type floor is annotated "for
  accessibility". This is a design system someone thought about.
- **A skip link exists and works** (`index.css:283-303`).
- **`ContentCard.NumberedRow` already exists** as the antidote to card-grid monotony — the pattern
  is written and documented, just unused on the hub pages.
- **`/events` at 1.5 screens** shows the site *can* be tight.

---

## Recommendations by Priority

### 1. Immediate (this week)
- **Fix `/plus`'s 320px overflow** (C2). It's on the revenue page, it's one component, and it's a
  WCAG AA violation. Half a day.
- **Resize the source images** (C1). No code required — 26.2 MB → <2 MB with `sharp` over
  `public/`. The `/hosts` page goes from 10.9 MB to ~400 KB. Half a day, and it is the largest
  single win available on this site.

### 2. Short-term (this sprint)
- **Two columns at the base breakpoint** for `/podcasts`, `/hosts`, and the home show grid (H1).
  Roughly halves the two worst pages.
- **Rebuild the episode card as a horizontal row on mobile** (H2). Kills the 44% letterbox waste
  and cuts the home page's biggest section by ~950px.
- **Fix the home show-card 50/50 split** (H3). The 122px text column is the worst typography on
  the site.
- Projected: home **7.2 → ~4.2 screens**, `/hosts` **7.5 → ~4.0**, `/podcasts` **3.9 → ~2.2**.

### 3. Medium-term (next sprint)
- **Real `srcset`/`sizes` pipeline** (H4) — Vercel Image Optimization via `vercel.json`, or
  `vite-imagetools`.
- **Touch-target pass** (M1, M2, M7) — a single sweep to a 44px floor.
- **Bring `HeroShowStack` to mobile** (H5) and cut the hero paragraph.

### 4. Long-term
- **`/distill` `/plus` and `/community`** (H6). These need an editor, not a developer. 5.6 screens
  to reach a pricing toggle is a conversion problem.
- Add an `xs: 480px` breakpoint (L6) so phone-only rules have somewhere to live.
- Break up hub-page card monotony using the `NumberedRow` you already built.

---

## Suggested Commands

| Command | Addresses |
|---|---|
| `/optimize` | C1, H4, M4, M9 — image payload, `srcset`, the pipeline (**start here**) |
| `/adapt` | C2, H1, H2, H3, H5, M1, M2, M6, M7 — breakpoints, aspect ratios, touch targets |
| `/distill` | H6 — `/plus` and `/community` copy volume; the hero paragraph |
| `/polish` | M3, M5, L5 — badge clipping, heading weight, dimension attrs |
| `/quieter` | M8 — the four-times-repeated cyan halo |
| `/normalize` | L6 — breakpoint scale |
