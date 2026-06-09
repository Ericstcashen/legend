#!/usr/bin/env bash
# Clones the Polymarket reference repos for the migration audit into ./polymarket-repos.
set -uo pipefail

DEST="${1:-./polymarket-repos}"
mkdir -p "$DEST"

REPOS=(
	# legacy clients (archived May 2026)
	"Polymarket/py-clob-client"
	"Polymarket/clob-client"
	# unified SDKs
	"Polymarket/py-sdk"
	"Polymarket/ts-sdk"
	# official references
	"Polymarket/agents"
	"Polymarket/poly-market-maker"
	# community references (read-only study)
	"ent0n29/polybot"
)

for repo in "${REPOS[@]}"; do
	name="${repo#*/}"
	if [ -d "$DEST/$name/.git" ]; then
		echo "already cloned: $name"
		continue
	fi
	echo "cloning $repo ..."
	git clone --depth 1 "https://github.com/$repo.git" "$DEST/$name" || echo "FAILED: $repo"
done
