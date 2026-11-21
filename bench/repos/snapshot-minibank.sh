#!/bin/sh
# Rebuild the standalone, single-commit dataset from the tracked public sources.
set -eu
root=$(git rev-parse --show-toplevel)
cd "$root"
head=$(git rev-parse --verify HEAD)
bundle=$(mktemp -d)
trap 'rm -rf "$bundle"' EXIT
mkdir "$bundle/repo"
git archive --format=tar "$head:bench/repos/minibank" > "$bundle/tree.tar"
tar -xf "$bundle/tree.tar" -C "$bundle/repo"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME='Frugal benchmark' GIT_AUTHOR_EMAIL='benchmark@example.invalid'
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_AUTHOR_DATE='2026-11-21T00:00:00Z' GIT_COMMITTER_DATE="$GIT_AUTHOR_DATE"
git init -q --template= --initial-branch=main --object-format=sha1 "$bundle/repo"
git -C "$bundle/repo" add -f -- .
git -C "$bundle/repo" -c commit.gpgsign=false commit -q -m 'chore: freeze public minibank benchmark'
git -C "$bundle/repo" bundle create "$bundle/minibank.bundle" refs/heads/main HEAD
git -C "$bundle/repo" rev-parse HEAD > "$bundle/minibank.sha"
cp "$bundle/minibank.bundle" bench/repos/minibank.bundle
cp "$bundle/minibank.sha" bench/repos/minibank.sha
