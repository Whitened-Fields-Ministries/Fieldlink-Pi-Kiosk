#!/usr/bin/env bash
# Create the update channel's signing key. Run once, on your own computer, from
# a clone of this repository:
#
#   scripts/make-apt-key.sh [--no-secret] [private-key-backup-file]
#
# It makes a dedicated Ed25519 key in a scratch keyring (your own gpg keys are
# not touched) and puts the two halves where they belong:
#
#   public   app/debian/fieldlink-apt.public.asc   committed; every package
#            carries it, and a kiosk installs updates signed by this key only
#   private  the APT_SIGNING_KEY Actions secret, set with the GitHub CLI when
#            it is installed and signed in (skip with --no-secret), and a copy
#            in the backup file (default ~/fieldlink-apt-signing.private.asc)
#            for you to move into a password manager
#
# The private key never leaves this computer except to GitHub's secret store.
# Whoever holds it can install software as root on every kiosk, and without it
# no kiosk can be updated again, which is why a person runs this and not CI.
# Background and key rotation: docs/apt-signing.md.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${GITHUB_REPOSITORY:-Whitened-Fields-Ministries/Fieldlink-Pi-Kiosk}"
PUB=app/debian/fieldlink-apt.public.asc
SECRET=1; [ "${1:-}" = "--no-secret" ] && { SECRET=0; shift; }
BACKUP="${1:-$HOME/fieldlink-apt-signing.private.asc}"

command -v gpg >/dev/null || { echo "gpg is not installed (macOS: brew install gnupg; Windows: use Git Bash)." >&2; exit 1; }
[ ! -e "$PUB" ] || { echo "$PUB already exists: the channel has a key. Replacing it is a rotation (docs/apt-signing.md), not this script." >&2; exit 1; }
[ ! -e "$BACKUP" ] || { echo "$BACKUP already exists; move it away or name another backup file." >&2; exit 1; }

GNUPGHOME="$(mktemp -d)"; export GNUPGHOME
trap 'rm -rf "$GNUPGHOME"' EXIT
gpg --batch --quiet --no-auto-check-trustdb --pinentry-mode loopback --passphrase '' --quick-generate-key \
  "Field Link Missions kiosk apt repository <support@fieldlinkmissions.com>" ed25519 sign 0
KEYID="$(gpg --batch --list-secret-keys --with-colons | awk -F: '$1=="sec"{print $5; exit}')"

( umask 077; gpg --batch --armor --export-secret-keys "$KEYID" > "$BACKUP" )
gpg --batch --armor --export "$KEYID" > "$PUB"

# Prove the two files belong together before anything depends on them.
CHECK="$(mktemp -d)"
( export GNUPGHOME="$CHECK"; chmod 700 "$CHECK"
  gpg --batch --quiet --import "$BACKUP"
  echo "fieldlink" | gpg --batch --quiet --pinentry-mode loopback --passphrase '' --local-user "$KEYID" --clearsign > "$CHECK/signed"
  gpg --batch --quiet --no-default-keyring --keyring "$CHECK/pub.kbx" --import "$OLDPWD/$PUB"
  gpg --batch --quiet --no-default-keyring --keyring "$CHECK/pub.kbx" --verify "$CHECK/signed" 2>/dev/null ) \
  || { rm -rf "$CHECK" "$PUB" "$BACKUP"; echo "the exported halves do not match; nothing was kept" >&2; exit 1; }
rm -rf "$CHECK"

echo "Key $KEYID created."
echo "  public half   $PUB"
echo "  private half  $BACKUP"
STORED=0
if [ "$SECRET" = 1 ] && command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  if gh secret set APT_SIGNING_KEY --repo "$REPO" < "$BACKUP"; then STORED=1; echo "  secret        APT_SIGNING_KEY set on $REPO"; fi
fi
echo
echo "What is left:"
n=1
if [ "$STORED" = 0 ]; then
  echo "  $n. GitHub → $REPO → Settings → Secrets and variables → Actions → New repository secret."
  echo "     Name APT_SIGNING_KEY, value: the whole contents of $BACKUP."
  n=$((n+1))
fi
echo "  $n. Commit the public half and get it onto main:"
echo "       git checkout -b apt-signing-key && git add $PUB"
echo "       git commit -m 'Update channel: public signing key' && git push -u origin apt-signing-key"
echo "     then open and merge the pull request."
n=$((n+1))
echo "  $n. Move $BACKUP into a password manager and delete the file."
echo "     Lose it and every kiosk needs a new card; leak it and so does every kiosk."
n=$((n+1))
echo "  $n. Tag the merge commit vX.Y.Z-qa. That build is the first one that updates itself."
