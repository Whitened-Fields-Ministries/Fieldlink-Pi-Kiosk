#!/usr/bin/env bash
# Make sure an update channel exists, so that a kiosk (and the image build,
# which runs apt-get update inside the image) never meets an apt source that
# answers 404. A channel that has no signed index yet gets an empty, signed
# one; a channel that already has one is left alone.
#
#   APT_SIGNING_KEY=… GH_TOKEN=… scripts/init-apt-channel.sh qa prod
#
# Every package points at apt-prod from its first boot, and apt-prod is only
# filled by the first promotion: without this the very first QA image cannot
# be built, and a display flashed before the first promotion would report a
# failed apt-get update every night.
set -euo pipefail
[ "$#" -ge 1 ] || { echo "usage: $0 <qa|prod>..." >&2; exit 2; }
: "${GITHUB_REPOSITORY:?}"
if [ -z "${APT_SIGNING_KEY:-}" ]; then
  echo "::error::APT_SIGNING_KEY secret is not set, but app/debian/fieldlink-apt.public.asc is committed: packages trust that key, so the update channels must be signed with it. Add the secret (Settings → Secrets and variables → Actions; docs/apt-signing.md) and run again." >&2
  exit 1
fi
HERE="$(cd "$(dirname "$0")" && pwd)"

for SUITE in "$@"; do
  case "$SUITE" in qa|prod) ;; *) echo "suite must be qa or prod" >&2; exit 2 ;; esac
  REL="apt-$SUITE"
  if ! gh release view "$REL" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
    extra=(); [ "$SUITE" = qa ] && extra=(--prerelease)
    gh release create "$REL" --repo "$GITHUB_REPOSITORY" --title "APT repository ($SUITE)" --latest=false "${extra[@]}" \
      --notes "Signed flat apt repository for deployed FieldLink kiosks ($SUITE channel). Not for downloading by hand: kiosks read it through apt (see the repository README). Assets are replaced on every release."
  fi
  if gh release view "$REL" --repo "$GITHUB_REPOSITORY" --json assets -q '.assets[].name' | grep -qx InRelease; then
    echo "$REL: already has a signed index"
    continue
  fi
  OUT="$(mktemp -d)"
  "$HERE/apt-repo.sh" "$SUITE" "$OUT"
  gh release upload "$REL" "$OUT"/* --repo "$GITHUB_REPOSITORY" --clobber
  rm -rf "$OUT"
  for attempt in 1 2 3; do
    if "$HERE/verify-apt-channel.sh" "$SUITE" none arm64; then continue 2; fi
    [ "$attempt" = 3 ] || { echo "channel not readable yet; trying again in 30 s"; sleep 30; }
  done
  echo "::error::the empty $SUITE channel was published but apt cannot read it (see above)" >&2
  exit 1
done
