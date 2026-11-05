#!/usr/bin/env bash
set -euo pipefail
report_path="${RUNNER_TEMP:?}/mr1-deployment-status.json"
test -f "$report_path"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
if git ls-remote --exit-code origin refs/heads/mr1-deployment-status > /dev/null; then
  git fetch origin refs/heads/mr1-deployment-status
  git switch -C mr1-deployment-status FETCH_HEAD
else
  git switch --orphan mr1-deployment-status
fi
cp "$report_path" deployment-status.json
git add deployment-status.json
git commit -m "Record deployment status for run $GITHUB_RUN_ID"
git push origin HEAD:refs/heads/mr1-deployment-status
