#!/usr/bin/env bash
# End-to-end test of the update channel, with no secrets and no network:
# a throwaway signing key, stand-in packages, the real scripts.
#
#   scripts/test-apt-channel.sh
#
#   0. An empty signed repository (a channel before its first release) must
#      be readable: apt-get update succeeds and offers nothing.
#   1. scripts/apt-repo.sh builds and signs a repository holding version 0.0.1;
#      scripts/verify-apt-channel.sh reads it through apt over HTTP.
#   2. The repository is replaced by 0.0.2 (what a release does to the channel):
#      apt must now offer 0.0.2.
#   3. A changed index and a foreign key must both be refused.
# Needs gpg, dpkg-dev, apt and python3 (all on the GitHub runners).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; SRV=""
trap '[ -n "$SRV" ] && kill "$SRV" 2>/dev/null; rm -rf "$T"' EXIT
ARCH="$(dpkg --print-architecture)"

newkey() { # <homedir> → armored private key on stdout, public key in <homedir>/public.asc
  mkdir -p "$1"; chmod 700 "$1"
  gpg --homedir "$1" --batch --quiet --pinentry-mode loopback --passphrase '' \
    --quick-generate-key "apt channel test <test@invalid>" ed25519 sign 0
  gpg --homedir "$1" --batch --armor --export > "$1/public.asc"
  gpg --homedir "$1" --batch --armor --export-secret-keys
}
deb() { # <version> → path of a stand-in fieldlink-pi-kiosk package
  local root="$T/pkg-$1"
  mkdir -p "$root/DEBIAN" "$root/usr/share/doc/fieldlink-pi-kiosk"
  echo "stand-in $1" > "$root/usr/share/doc/fieldlink-pi-kiosk/README"
  printf 'Package: fieldlink-pi-kiosk\nVersion: %s\nArchitecture: %s\nMaintainer: test <test@invalid>\nDescription: stand-in package for the channel test\n' "$1" "$ARCH" > "$root/DEBIAN/control"
  dpkg-deb --build --root-owner-group "$root" "$T/fieldlink-pi-kiosk_$1_${ARCH}.deb" >/dev/null
  echo "$T/fieldlink-pi-kiosk_$1_${ARCH}.deb"
}
publish() { rm -rf "$T/www"; APT_SIGNING_KEY="$KEY" "$HERE/apt-repo.sh" qa "$T/www" "$@" >/dev/null; }
verify() { "$HERE/verify-apt-channel.sh" "http://127.0.0.1:$PORT" "$1" "$ARCH" "${2:-$T/key/public.asc}"; }
refused() { if "$@" >"$T/out" 2>&1; then cat "$T/out"; echo "FAIL: this should have been refused" >&2; exit 1; fi; }

KEY="$(newkey "$T/key")"
mkdir -p "$T/www"
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
( cd "$T" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$T/www" >/dev/null 2>&1 ) & SRV=$!
for _ in $(seq 50); do python3 -c "import socket; socket.create_connection(('127.0.0.1',$PORT),1)" 2>/dev/null && break; sleep 0.1; done

echo "── 0. a channel before its first release (empty, signed) is readable"
publish; verify none
if find "$T/www" -type f -size 0 | grep -q .; then echo "FAIL: an empty file in the channel (GitHub refuses zero-byte release assets)" >&2; exit 1; fi
echo "── 1. a signed channel is read"
publish "$(deb 0.0.1)"; verify 0.0.1
echo "── 2. a newer release replaces it"
publish "$(deb 0.0.2)"; verify 0.0.2
refused verify 0.0.1; echo "   an older expected version is reported as a mismatch"
echo "── 3. a changed index is refused"
cp "$T/www/Packages" "$T/Packages.good"
sed -i 's/^Version: 0.0.2/Version: 9.9.9/' "$T/www/Packages"; gzip -9 -k -n -f "$T/www/Packages"
refused verify 9.9.9; echo "   refused"
cp "$T/Packages.good" "$T/www/Packages"; gzip -9 -k -n -f "$T/www/Packages"; verify 0.0.2 >/dev/null
echo "── 4. a repository signed with another key is refused"
newkey "$T/other" >/dev/null
refused verify 0.0.2 "$T/other/public.asc"; echo "   refused"
echo "==> update channel test passed"
