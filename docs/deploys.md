# Deploys

Merging to `main` publishes to staging. Production only moves when someone
asks it to.

## Current state (not yet the diagram below)

`ark-plus.xyz` is being used as staging while the production environment
variables are still being assembled, so the Vercel **Production Branch is
still `main`** and merges to main deploy straight to it. That is deliberate
for now.

The machinery below is in place and waiting on one switch. When the real
production env vars land, flip arkmedia → Settings → Git → Production Branch
to `production`, and from that moment merges to main become preview builds and
`ark-plus.xyz` only moves via the Deploy to production workflow.

**Before that flip, give Vercel Production its own `DATABASE_URL`** pointing at
`ark-insider-prod`. Today one shared value serves Preview and Production and it
points at `ark-insider-dev`, which is right for staging but not for prod. The
`production` GitHub Environment already points at `ark-insider-prod`, so
without the split, a production deploy would run against dev while its
migrations land on prod.

Until the flip, running that workflow pushes the `production` branch but Vercel
builds it as a *preview*, because it is not the Production Branch yet.

## The shape of it

```
feature branch ──PR──▶ main ──────▶ Vercel PREVIEW build   (staging)
                                     arkmedia-git-main-hannah-waxman.vercel.app

                       Actions ▶ "Deploy to production"  (manual dispatch)
                            │    fast-forwards production ← main
                            ▼
                       production ─▶ Vercel PRODUCTION build
                                     ark-plus.xyz
```

The single setting that makes this work: the `arkmedia` Vercel project's
**Production Branch must be `production`, not `main`.** Vercel builds any push to
the Production Branch as production and everything else as a preview, so
moving that setting off `main` is what demotes merges to staging. There is no
public API for it — it lives in Settings → Git.

## Staging

Every push to `main` builds a preview deployment, reachable at the branch's
stable alias:

    https://arkmedia-git-main-hannah-waxman.vercel.app

Vercel Authentication is on for all non-custom domains, so that URL asks for a
Vercel login. Team members get in; the public does not.

**Staging shares every environment variable with production.** All 40 on the
project target production and preview with the same value. For
`DATABASE_URL` that value is `ark-insider-dev` — confirmed 2026-09-16 by
matching the FAQ row ids ark-plus.xyz serves against each database — so
staging's data is already the dev database, and `ark-insider-prod` is not wired
into Vercel at all yet. The rest (live Stripe, prod Auth0, prod Beehiiv) still
point wherever production does, so treat staging as safe to look at, not safe
to click through a checkout or a cancellation on.

Splitting it means giving these a preview-scoped value of their own:

| Variable | Preview should point at |
| --- | --- |
| `DATABASE_URL` | the `ark-insider-dev` Neon project (already true — the split is giving *Production* `ark-insider-prod`) |
| `STRIPE_SECRET_KEY`, `VITE_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | the Stripe test catalog |
| `APP_BASE_URL` | the staging origin — it drives every OAuth `redirect_uri` |
| Auth0 client/tenant vars | plus the staging callback URL added to the Auth0 app |
| Beehiiv keys | a non-production publication, or accept read-only drift |

`vercel env add <NAME> preview` sets a preview-only value without disturbing
production.

## Shipping to production

Actions tab → **Deploy to production** → Run workflow.

It takes a `ref` (default `main`) and pushes that commit to the `production`
branch. Vercel sees the push, builds it with production environment variables,
and re-aliases `ark-plus.xyz`. The run summary shows the commit and the list of
commits production gains before it pushes.

The push is a plain fast-forward, so it is **rejected if the ref is missing
work that is already live**. That is the guard against shipping a stale branch;
the fix is to merge `production` into your branch, not to reach for `force`.
The `force` input exists for deliberate rollbacks and sideways moves, and says
so in the run summary.

The ref must also **already be on `main`**: the workflow refuses a commit that
is not an ancestor of `origin/main`, so nothing reaches production without
having been through main's pull-request review. `force` overrides that too (a
hotfix cut from `production` is not on main), which is why the `production`
environment's required reviewer matters.

**Clicking instead:** the Vercel dashboard's Redeploy and Instant Rollback on
the `arkmedia` project both still work and are the fastest way to undo a bad
deploy.

**Don't use "Promote to Production" on a preview deployment.** Promotion does
not rebuild — it re-points the alias at an artifact that was built with
*preview* environment variables. That is harmless only while preview and
production share values, and becomes a way to point ark-plus.xyz at the dev
database the moment they diverge.

## Database migrations

`migrate.yml` runs on any push to `main` or `production` that touches
`migrations/`, and the branch picks the database:

| Push to | GitHub Environment | `DATABASE_URL` | Gate |
| --- | --- | --- | --- |
| `main` | `preview` | `ark-insider-dev` | none — migrates on merge |
| `production` | `production` | `ark-insider-prod` | required reviewer |

Each environment holds its own `DATABASE_URL` secret, pointing at the same
database as the Vercel environment of the same name — but on Neon's **direct**
host, where Vercel uses the pooled one. The runner holds a session-level
advisory lock, which the pooler doesn't support (see `migrations/README.md`).
**GitHub Actions cannot read Vercel's variables** — the two are set
separately, so when a password rotates, change both.
(Vercel won't hand them back either: they're Sensitive, and `vercel env pull`
returns them empty.)

A manual dispatch follows the same rule: run it from `production` to migrate
prod, from `main` to migrate staging. Any other branch is skipped, so an
unmerged migration can't reach a shared database.

The migration and the Vercel build both start from the same push and race each
other. The required reviewer on `production` is the lever for holding one back
when an order is needed. `preview` deliberately has none.

`ark-insider-dev` is also what local `.env` points at, so a migration you apply
locally lands on staging too.

## Required GitHub settings

None of this can be enforced from the repo; the workflows assume it. Settings
→ Branches / Rules, and Settings → Environments.

- [ ] **`production` branch protected:** push restricted to the GitHub Actions
      app (so only "Deploy to production" moves it), force-push off for
      everyone else, deletion off. A `force: true` deploy needs the Actions app
      on the force-push bypass list; leave it off until a rollback needs it.
- [ ] **`main` branch protected:** pull request required, at least one
      approval, "Require review from Code Owners" on (`.github/CODEOWNERS`),
      force-push and deletion off.
- [ ] **`production` environment:** required reviewers set, and **"Prevent
      self-review"** on, so whoever dispatches a deploy or a prod migration
      cannot also approve it.
- [ ] **Deployment branch policies:** `production` environment → selected
      branches → `production` only. `preview` environment → `main` only. Without
      these, any branch's workflow file can name the environment and read its
      `DATABASE_URL`.
- [ ] **`preview` environment gets a required reviewer for now.** Its database
      is `ark-insider-dev`, which the live site still reads, so an ungated
      merge-to-main migration is a production schema change. Drop the reviewer
      once Vercel Production has its own `DATABASE_URL` (top of this page).
- [ ] Settings → Actions → General: workflow permissions read-only by default,
      and "Allow GitHub Actions to create and approve pull requests" off.
- [ ] Dependabot alerts and security updates on (`.github/dependabot.yml` only
      configures version updates).

Actions are pinned to commit SHAs and Dependabot proposes the bumps; review
those PRs like any other change to `.github/`.

## Ownership of each piece

| Piece | Where it lives |
| --- | --- |
| Production Branch = `production` | Vercel → arkmedia → Settings → Git |
| Preview auth | Vercel → arkmedia → Settings → Deployment Protection |
| Production deploy | `.github/workflows/deploy-production.yml` |
| Branch protection, environment reviewers, branch policies | GitHub → Settings (checklist above) |
| Schema | `.github/workflows/migrate.yml` |
| Per-branch `DATABASE_URL` + prod approval | GitHub → Settings → Environments → `preview` / `production` |
| Cron jobs | `vercel.json` — they run on production deployments only, so staging never fires them |

`scripts/vercel-ignore-build.sh` is left over from the earlier
one-project-per-branch arrangement and is wired to nothing; the Ignored Build
Step is unset on the project.
