# Signing key for the apt repository (milestone 3)

Milestone 3 ships app updates to installed Pis through a small apt repository
pulled nightly by `unattended-upgrades`. apt refuses unsigned repositories, so
the repository index must be signed with a GPG key that the image trusts. The
key is created **once, by a person, on their own machine**; the private half is
stored as a GitHub Actions secret and the public half is baked into the image.
Nothing in milestone 1 or 2 uses it. Generate it whenever convenient so the
secret is ready.

## 1. Generate the key

Use a dedicated key, not a personal one: it only ever signs package indexes.
Ed25519 keys are small and every apt since Debian 11 accepts them. No
passphrase, because the CI job has no one to type it (the secret store is the
protection).

```bash
export GNUPGHOME="$(mktemp -d)"     # scratch keyring; nothing touches your own
gpg --batch --pinentry-mode loopback --passphrase '' --quick-generate-key \
  "Field Link Missions kiosk apt repository <support@fieldlinkmissions.com>" \
  ed25519 sign 0
gpg --list-secret-keys --keyid-format long
```

Note the 16-character key id shown after `sec   ed25519/`.

## 2. Export the two halves

```bash
KEYID=<the id from above>
gpg --armor --export-secret-keys "$KEYID" > fieldlink-apt-signing.private.asc
gpg --armor --export "$KEYID"             > fieldlink-apt.public.asc
```

## 3. Store them

| Half | Where | Name |
|---|---|---|
| `fieldlink-apt-signing.private.asc` | Fieldlink-Pi-Kiosk → Settings → Secrets and variables → Actions → *New repository secret* (paste the whole armored file) | `APT_SIGNING_KEY` |
| `fieldlink-apt.public.asc` | committed to this repo as **`app/debian/fieldlink-apt.public.asc`** (the package build dearmors it into `/etc/apt/keyrings/fieldlink-apt.gpg` and adds the apt source; without the file the package has no update channel) | — |

Then delete the private file and the scratch keyring:

```bash
shred -u fieldlink-apt-signing.private.asc
rm -rf "$GNUPGHOME"; unset GNUPGHOME
```

Keep a copy of the private key somewhere offline that outlives GitHub (a
password manager entry is fine). If it is lost, every deployed Pi has to be
re-flashed to trust a new key; if it leaks, rotate it the same way and
re-flash.

## What the pipeline does with it

`scripts/apt-repo.sh` imports `APT_SIGNING_KEY` into a temporary keyring, builds a
signed *flat* apt repository (`Packages`, `Release`, `InRelease`, the `.deb` files) and
`scripts/publish-apt.sh` uploads it as the assets of the `apt-qa` release (on a
`vX.Y.Z-qa` tag) or `apt-prod` (on the `vX.Y.Z` promotion). Kiosks read
`https://github.com/<owner>/<repo>/releases/download/apt-prod/` through
`/etc/apt/sources.list.d/fieldlink.sources`, trust only this key, and
`unattended-upgrades` installs new builds overnight (plus Debian security fixes).
The settings screen can check and install on demand and switch a bench Pi to the
`qa` channel.

Rotating the key means: new key pair, replace `app/debian/fieldlink-apt.public.asc` and
the secret, ship one release signed with the **old** key that carries the new public key
in the package (kiosks install it), then switch the pipeline to the new key.
