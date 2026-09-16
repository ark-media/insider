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

**Staging currently runs against production data.** All 40 environment
variables on the project target production and preview with the same value, so
a preview build talks to the prod Neon database, live Stripe, prod Auth0 and
prod Beehiiv. Until that is split, treat staging as a production mirror: safe
to look at, not safe to click through a checkout or a cancellation on.

Splitting it means giving these a preview-scoped value of their own:

| Variable | Preview should point at |
| --- | --- |
| `DATABASE_URL` | the `ark-insider-dev` Neon project |
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

**Clicking instead:** the Vercel dashboard's Redeploy and Instant Rollback on
the `arkmedia` project both still work and are the fastest way to undo a bad
deploy.

**Don't use "Promote to Production" on a preview deployment.** Promotion does
not rebuild — it re-points the alias at an artifact that was built with
*preview* environment variables. That is harmless only while preview and
production share values, and becomes a way to point ark-plus.xyz at the dev
database the moment they diverge.

## Database migrations

`migrate.yml` runs on pushes to `production` that touch `migrations/`, so the
schema moves with the deploy rather than on merge to `main`. Merging to main no
longer migrates anything — that holds now, and keeps holding after the
Production Branch flip.

The migration and the Vercel build both start from the same push and race each
other. Required reviewers on the `production-db` environment are the lever for
holding one back when an order is needed.

Two things are unconfigured on that environment today and will fail the next
migration run:

- no `DATABASE_URL` secret (Settings → Environments → production-db → secrets)
- no required reviewers, so the approval gate the workflow describes isn't
  actually gating anything

## Ownership of each piece

| Piece | Where it lives |
| --- | --- |
| Production Branch = `production` | Vercel → arkmedia → Settings → Git |
| Preview auth | Vercel → arkmedia → Settings → Deployment Protection |
| Production deploy | `.github/workflows/deploy-production.yml` |
| Schema | `.github/workflows/migrate.yml` |
| Cron jobs | `vercel.json` — they run on production deployments only, so staging never fires them |

`scripts/vercel-ignore-build.sh` is left over from the earlier
one-project-per-branch arrangement and is wired to nothing; the Ignored Build
Step is unset on the project.
