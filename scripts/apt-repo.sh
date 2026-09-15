#!/usr/bin/env bash
# Build a signed *flat* apt repository from one or more .deb files.
#
#   scripts/apt-repo.sh <suite> <outdir> <file.deb>...
#
# The result (Packages, Packages.gz, Release, Release.gpg, InRelease and the
# .deb files) is meant to be uploaded as the assets of one GitHub release
# (apt-qa or apt-prod), which apt then reads as
#   deb [signed-by=…] https://github.com/<owner>/<repo>/releases/download/<suite-release>/ ./
# Flat repositories have no dists/ tree, so every file sits at one URL depth,
# which is exactly what release assets allow.
#
# Signing: set APT_SIGNING_KEY to the armored private key (the Actions
# secret), or have it already in a keyring and set APT_SIGNING_KEYID. Uses
# dpkg-scanpackages (dpkg-dev) and gpg only; no apt-ftparchive/reprepro.
set -euo pipefail

SUITE="${1:?suite (qa|prod)}"; OUT="${2:?output directory}"; shift 2
[ "$#" -ge 1 ] || { echo "usage: $0 <suite> <outdir> <file.deb>..." >&2; exit 2; }
case "$SUITE" in qa|prod) ;; *) echo "suite must be qa or prod" >&2; exit 2 ;; esac

mkdir -p "$OUT"
for f in "$@"; do test -f "$f" || { echo "missing $f" >&2; exit 1; }; cp -f "$f" "$OUT/"; done

if [ -n "${APT_SIGNING_KEY:-}" ]; then
  export GNUPGHOME="$(mktemp -d)"
  trap 'rm -rf "$GNUPGHOME"' EXIT
  printf '%s\n' "$APT_SIGNING_KEY" | gpg --batch --quiet --import
  APT_SIGNING_KEYID="$(gpg --batch --list-secret-keys --with-colons | awk -F: '$1=="sec"{print $5; exit}')"
fi
: "${APT_SIGNING_KEYID:?no signing key: set APT_SIGNING_KEY (armored private key) or APT_SIGNING_KEYID}"

cd "$OUT"
# Packages: dpkg-scanpackages writes "Filename: ./x.deb"; apt joins that onto
# the base URL, so strip the "./" (GitHub does not normalise it away).
dpkg-scanpackages --multiversion . /dev/null 2>/dev/null | sed 's|^Filename: \./|Filename: |' > Packages
gzip -9 -k -n -f Packages

sha() { sha256sum "$1" | cut -d' ' -f1; }
md5() { md5sum "$1" | cut -d' ' -f1; }
{
  echo "Origin: FieldLink"
  echo "Label: FieldLink"
  echo "Suite: $SUITE"
  echo "Codename: $SUITE"
  echo "Architectures: arm64 amd64"
  echo "Description: Field Link Missions kiosk display updates ($SUITE)"
  echo "Date: $(LC_ALL=C date -u -R)"
  echo "MD5Sum:"
  for f in Packages Packages.gz; do printf ' %s %16d %s\n' "$(md5 "$f")" "$(stat -c %s "$f")" "$f"; done
  echo "SHA256:"
  for f in Packages Packages.gz; do printf ' %s %16d %s\n' "$(sha "$f")" "$(stat -c %s "$f")" "$f"; done
} > Release

rm -f Release.gpg InRelease
gpg --batch --yes --local-user "$APT_SIGNING_KEYID" --digest-algo SHA256 --armor --detach-sign --output Release.gpg Release
gpg --batch --yes --local-user "$APT_SIGNING_KEYID" --digest-algo SHA256 --clearsign --output InRelease Release

echo "==> $OUT ($SUITE):"
ls -l
grep -E '^(Package|Version|Architecture|Filename):' Packages
