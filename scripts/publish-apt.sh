#!/usr/bin/env bash
# Publish .deb files to the apt-<suite> GitHub release (a signed flat apt
# repository read by deployed kiosks; see scripts/apt-repo.sh). Run in CI:
#
#   APT_SIGNING_KEY=<armored private key> GH_TOKEN=… scripts/publish-apt.sh qa out/*.deb
#
# The release "apt-qa" / "apt-prod" is created on first use and never becomes
# "latest". Old assets are removed so the index only ever describes the files
# next to it.
set -euo pipefail
SUITE="${1:?suite (qa|prod)}"; shift
[ "$#" -ge 1 ] || { echo "usage: $0 <suite> <file.deb>..." >&2; exit 2; }
: "${GITHUB_REPOSITORY:?}"
if [ -z "${APT_SIGNING_KEY:-}" ]; then
  echo "::error::APT_SIGNING_KEY secret is not set but app/debian/fieldlink-apt.public.asc exists — the kiosks trust that key, so the $SUITE channel cannot be published unsigned. See docs/apt-signing.md." >&2
  exit 1
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d)"
"$HERE/apt-repo.sh" "$SUITE" "$OUT" "$@"

REL="apt-$SUITE"
if ! gh release view "$REL" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  extra=(); [ "$SUITE" = qa ] && extra=(--prerelease)
  gh release create "$REL" --repo "$GITHUB_REPOSITORY" --title "APT repository ($SUITE)" --latest=false "${extra[@]}" \
    --notes "Signed flat apt repository for deployed FieldLink kiosks ($SUITE channel). Not for downloading by hand: kiosks read it through apt (see the repository README). Assets are replaced on every release."
fi
for a in $(gh release view "$REL" --repo "$GITHUB_REPOSITORY" --json assets -q '.assets[].name'); do
  gh release delete-asset "$REL" "$a" --repo "$GITHUB_REPOSITORY" --yes
done
gh release upload "$REL" "$OUT"/* --repo "$GITHUB_REPOSITORY" --clobber
echo "==> published to https://github.com/$GITHUB_REPOSITORY/releases/download/$REL/"
rm -rf "$OUT"
