#!/usr/bin/env bash
# Publish .deb files to the apt-<suite> GitHub release (a signed flat apt
# repository read by deployed kiosks; see scripts/apt-repo.sh). Run in CI:
#
#   APT_SIGNING_KEY=<armored private key> GH_TOKEN=… scripts/publish-apt.sh qa out/*.deb
#
# The release "apt-qa" / "apt-prod" is created on first use and never becomes
# "latest". Assets of the previous build are removed once the new ones are up,
# so the index only ever describes files that are next to it. The channel is
# then read back the way a kiosk reads it (scripts/verify-apt-channel.sh).
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
# Packages first, the signed index after them, stale files last: a kiosk that
# reads the channel mid-publish then sees either the old index (whose .deb is
# still there) or the new one (whose .deb is already there), never a gap.
gh release upload "$REL" "$OUT"/*.deb --repo "$GITHUB_REPOSITORY" --clobber
gh release upload "$REL" "$OUT"/Packages "$OUT"/Packages.gz "$OUT"/Release "$OUT"/Release.gpg "$OUT"/InRelease --repo "$GITHUB_REPOSITORY" --clobber
for a in $(gh release view "$REL" --repo "$GITHUB_REPOSITORY" --json assets -q '.assets[].name'); do
  [ -e "$OUT/$a" ] || gh release delete-asset "$REL" "$a" --repo "$GITHUB_REPOSITORY" --yes
done
echo "==> published to https://github.com/$GITHUB_REPOSITORY/releases/download/$REL/"

# Read it back. A release that kiosks cannot install from must fail here, in
# the release run, not silently on every display that night.
version="$(dpkg-deb -f "$(ls "$OUT"/*_arm64.deb | head -n 1)" Version)"
for attempt in 1 2 3; do
  if "$HERE/verify-apt-channel.sh" "$SUITE" "$version" arm64; then rm -rf "$OUT"; exit 0; fi
  [ "$attempt" = 3 ] || { echo "channel not readable yet; trying again in 30 s"; sleep 30; }
done
rm -rf "$OUT"
echo "::error::the $SUITE channel was published but does not read back as $version (see above)" >&2
exit 1
