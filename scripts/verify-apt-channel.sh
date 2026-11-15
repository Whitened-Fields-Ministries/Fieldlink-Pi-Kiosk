#!/usr/bin/env bash
# Read an update channel the way a kiosk does, without touching this machine's apt.
#
#   scripts/verify-apt-channel.sh <qa|prod|base-url> <expected-version> [arch] [public-key.asc]
#
# Builds a private apt root from the package's own source entry
# (app/debian/fieldlink.sources) and public key, then proves that
#   - apt-get update accepts the repository's signature with that key only,
#   - fieldlink-pi-kiosk's candidate is <expected-version>, from origin FieldLink
#     (the origin unattended-upgrades is allowed to install from),
#   - the .deb downloads and matches the hash in the signed index.
# The release workflow runs it against GitHub right after publishing a channel;
# scripts/test-apt-channel.sh runs it against a throwaway repository on localhost.
set -euo pipefail

WHERE="${1:?qa, prod or a base URL}"; WANT="${2:?expected version}"
ARCH="${3:-arm64}"
HERE="$(cd "$(dirname "$0")" && pwd)"
KEY="${4:-$HERE/../app/debian/fieldlink-apt.public.asc}"
SRC="$HERE/../app/debian/fieldlink.sources"
PKG=fieldlink-pi-kiosk
die() { echo "::error::$*" >&2; exit 1; }
[ -f "$KEY" ] || die "no public key at $KEY"

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/sources.d" "$T/lists/partial" "$T/cache/archives/partial" "$T/keyrings" "$T/dl"
: > "$T/status"
gpg --batch --yes --dearmor --output "$T/keyrings/fieldlink-apt.gpg" "$KEY"

# The entry the package ships, with only what a test needs changed: the base
# URL (a channel name switches it exactly as root-helper does) and the key path.
case "$WHERE" in
  qa|prod) sed -e "s|/releases/download/apt-[a-z]*/|/releases/download/apt-$WHERE/|" "$SRC" ;;
  http://*|https://*) sed -e "s|^URIs:.*|URIs: ${WHERE%/}/|" "$SRC" ;;
  *) die "first argument must be qa, prod or a URL" ;;
esac | sed -e "s|^Signed-By:.*|Signed-By: $T/keyrings/fieldlink-apt.gpg|" > "$T/sources.d/fieldlink.sources"
grep -E '^(URIs|Suites):' "$T/sources.d/fieldlink.sources"

APT=(-o "Dir::Etc::sourcelist=/dev/null" -o "Dir::Etc::sourceparts=$T/sources.d" -o "Dir::Etc::preferencesparts=/dev/null"
     -o "Dir::State::lists=$T/lists" -o "Dir::State::status=$T/status" -o "Dir::Cache=$T/cache"
     -o "APT::Architecture=$ARCH" -o "APT::Architectures::=$ARCH" -o "Debug::NoLocking=1"
     -o "APT::Update::Error-Mode=any" -o "APT::Sandbox::User=root" -o "Acquire::Retries=3")

apt-get "${APT[@]}" update || die "apt-get update did not accept the channel at $WHERE"
policy="$(apt-cache "${APT[@]}" policy "$PKG")"
echo "$policy"
got="$(awk '/Candidate:/{print $2}' <<<"$policy")"
[ "$got" = "$WANT" ] || die "the channel offers $PKG ${got:-nothing} for $ARCH, expected $WANT"
apt-cache "${APT[@]}" policy | grep -q 'o=FieldLink' || die "the channel's Release file does not say Origin: FieldLink; unattended-upgrades would ignore it"
( cd "$T/dl" && apt-get "${APT[@]}" download "$PKG" ) || die "the .deb did not download or does not match the signed index"
echo "==> $WHERE offers $PKG $WANT ($ARCH), signed and downloadable"
