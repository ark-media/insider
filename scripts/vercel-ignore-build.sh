#!/usr/bin/env bash
# Vercel "Ignored Build Step" command.
# Pass the branch this Vercel project should deploy from as the first argument.
# Exit 1 = proceed with build, exit 0 = skip.
# Configure in Vercel: Settings -> Git -> Ignored Build Step
#   Main project: bash scripts/vercel-ignore-build.sh main
#   Demo project: bash scripts/vercel-ignore-build.sh demo-full-site
set -eu
expected_branch="${1:?expected branch name as first argument}"
if [ "${VERCEL_GIT_COMMIT_REF:-}" = "$expected_branch" ]; then
  exit 1
else
  exit 0
fi
