# FieldLink Pi Kiosk

The Raspberry Pi image for a [Field Link Missions](https://fieldlinkmissions.com) lobby display.
A church downloads the image from FieldLink Admin → Kiosk → **🍓 Raspberry Pi Kiosk** (which
also carries the buying list and the setup steps), flashes it onto a microSD card, plugs a Pi 4
or Pi 5 into the TV and never touches the OS: the screen shows a 6-character code, a Super Admin
types it into Admin → Kiosk → 🔗 Link kiosk, and the map appears.

This repo holds two things:

| Directory | What | Output |
|---|---|---|
| `app/` | The Linux shell: an Electron app around the FieldLink kiosk page (`/kiosk?key=…`) with pairing by on-screen code, the 30 s key check and the recovery screen. The Linux counterpart of [Fieldlink-Win-Kiosk](https://github.com/Whitened-Fields-Ministries/Fieldlink-Win-Kiosk), which stays the Windows app. | `fieldlink-pi-kiosk_<version>_arm64.deb` (and `_amd64` for VM testing) |
| `image/` | A [pi-gen](https://github.com/RPi-Distro/pi-gen) stage that puts that package on Raspberry Pi OS Lite (trixie, arm64), starts it at boot under [cage](https://github.com/cage-kiosk/cage), and sets the boot config. | `fieldlink-kiosk-<version>-arm64.img.xz` + `os-list.json` for Raspberry Pi Imager |

The plan and the reasoning behind it live in the FieldLink repo:
`docs/kiosk-display-hardware.md` ("Plan for the Pi image"). Milestone 1 (**boots on Ethernet and
shows the pairing code**) shipped as 0.1.0. Milestone 2 (**Wi‑Fi set up from a phone**) is 0.2.0.
0.3.0 adds **in-place updates** (signed apt channel, nightly), restart, factory reset and a log view,
so a deployed kiosk is never reflashed for a new build.

## How a Pi boots into the display

1. Raspberry Pi OS Lite boots to `graphical.target`. There is no desktop and no login prompt.
2. `fieldlink-kiosk.service` (shipped in the `.deb`) starts on tty1 as the unprivileged `kiosk`
   user. `PAMName=` gives it a logind seat, so it can open the GPU and input devices without root.
3. The unit runs `/usr/bin/fieldlink-kiosk-session`, which starts `cage` with the Electron app as
   its only window (`--ozone-platform=wayland`, no Xwayland).
4. The app reads `/var/lib/fieldlink-kiosk/config.json`. No kiosk URL yet → it asks the server
   for a pairing code and shows it. Linked → it loads the kiosk page and checks the key every 30 s.
   Everything the display remembers is in that one directory.
5. If the app exits (crash, Ctrl+Shift+Q), systemd restarts it after 3 s.

## Wi‑Fi from a phone (milestone 2)

With no network cable and no Wi‑Fi the display cannot even ask for a pairing code, so the app
takes over networking itself (`app/network.js` talks to NetworkManager through `nmcli`; a polkit
rule in the package allows the `kiosk` user to):

1. **No network** (after 8 s with no cable; 20 s when a cable is in but has no address yet; 25 s
   when a Wi‑Fi network is saved, so NetworkManager can join it first): the app scans, caches the
   list, and turns the Pi's radio into a WPA2 hotspot named `FieldLink-XXXX` (last four digits of
   the Wi‑Fi MAC) with a random 10-character password. The TV shows a QR code that joins it, plus
   the name and password in text. A display with no keyboard and no touch screen has no other way
   in, which is why this is automatic and quick.
2. The app serves the **setup page** at `http://10.42.0.1/` (`app/setup-server.js`). A dnsmasq
   entry in the package resolves every name to the Pi while the hotspot is up, so the phone's
   captive-portal check hits that page and iOS/Android open it on their own.
3. The page lists the networks from the scan; the person picks one and types the password.
4. The hotspot goes down (the radio cannot do both), the Pi joins the network with an
   autoconnect profile, and the TV shows the pairing code. The phone drops off the setup network
   at that moment, by design. A wrong password brings the hotspot back with the same name and
   password; the phone rejoins and the page shows the error.
5. Ethernet plugged in at any point wins: the hotspot goes down as soon as the Pi is online.
6. With nobody on the setup page for 10 minutes and a saved network on file, the hotspot pauses
   for 45 s so a rebooted router can be rejoined without anyone touching the display.

A keyboard gets the same picker on the TV (*Use a keyboard instead*), and the Ctrl+Shift+K screen
has a Wi‑Fi block (current network, *Change network*, *Set up from a phone*).

**Getting to the settings screen without a keyboard.** Press and hold the top-left corner of the
screen for four seconds with one finger (touch screen) or the mouse. A small progress ring shows
while holding; the settings screen opens, and the same gesture closes it. It is detected in
`app/preload.js` on every page the window shows, including the kiosk page, and only ever does
what Ctrl+Shift+K does. The Windows shell can carry the same snippet for touch displays. Raspberry Pi
Imager's OS customisation can still write Wi‑Fi credentials at flash time; NetworkManager picks
those up before the app ever starts a hotspot.

The image is identical for every church. The first user is `fieldlink`; its password is random per
build and thrown away (pi-gen needs one to skip the first-boot rename wizard, which would otherwise
take over the TV), so SSH is only usable with a key: one baked in by a *Run workflow* build, or one
added through Imager's OS customisation. `hdmi_enable_4kp60=1` is set for the Pi 4. The image has no cloud-init and the first-boot
rename wizard (`userconfig.service`) is masked: cloud-init's Raspberry Pi hook would otherwise
create a `pi` user and put the wizard's keyboard dialog on the TV instead of the pairing code.

## Updates without reflashing

A deployed kiosk gets new builds through apt, never through a new card:

- The package ships `/etc/apt/sources.list.d/fieldlink.sources` (a signed **flat** apt repository
  held as the assets of the `apt-prod` GitHub release), the repository's public key in
  `/etc/apt/keyrings/`, and an `unattended-upgrades` policy that takes packages from the FieldLink
  origin and Debian security nightly (apt's daily timers). The package's `postinst` restarts the
  display, so an overnight update is a few seconds of dark screen.
- The settings screen (Ctrl+Shift+K or the corner hold) has **Updates** (check now, install now,
  progress), **Restart**, **Show log** (journal + `kiosk.log`) and **Factory reset** (forgets the
  pairing and every saved Wi‑Fi network, then reboots to a fresh pairing code). Ctrl+Shift+S on that
  screen also reveals the **update channel** switch (`prod` / `qa`) for bench testing.
- Root is reached only through `/usr/lib/fieldlink-kiosk/root-helper`, a fixed menu allowed for the
  `kiosk` user by one sudoers line: `check-update`, `update`, `reboot`, `factory-reset`, `logs`,
  `channel`.
- **The server decides the channel.** FieldLink's `/api/kiosk/whoami` (the 30 s key check) answers
  `update_channel: "qa"` on a QA server and `"prod"` on production; when that differs from the apt
  source on the card the app runs `root-helper channel <x>` once and logs it. So a display linked
  to `app.qa.fieldlinkmissions.com` gets early builds from `apt-qa`, one linked to production
  only promoted builds, from the very same image and without a reflash. Re-linking a display to
  the other server moves it over at its next check. A server that does not send the field (an
  older FieldLink) leaves the manual Ctrl+Shift+S switch alone.
- Publishing: the `vX.Y.Z-qa` tag pushes the `.deb` to the `apt-qa` channel, the `vX.Y.Z`
  promotion to `apt-prod` (`scripts/apt-repo.sh` builds and signs, `scripts/publish-apt.sh`
  replaces the release assets). Both need the signing key: the public half committed as
  `app/debian/fieldlink-apt.public.asc`, the private half as the `APT_SIGNING_KEY` Actions secret
  (`docs/apt-signing.md`). **Until the public key file exists, packages are built without an
  update channel** and the publish step is skipped; the first release after adding it is the one
  kiosks start updating from, so it should ship in a QA/prod image (a package without the channel
  cannot learn about it later).
- What still needs a new image: kernel, firmware and anything under `/boot/firmware`. Those come
  from the Raspberry Pi archive and are deliberately not auto-installed (they need a reboot).
- Read-only root was in the original plan and is **not** done: an overlay root discards apt
  updates on reboot unless every update also remounts and writes the lower layer, which is what
  this milestone chose to avoid. `fsck.repair=yes` is on the kernel line and the state directory is
  small; if pulled plugs turn out to corrupt cards in practice, that is the time to revisit.

## Releases

Nothing builds on pull requests or merges; PRs only run the fast checks (`node --check`, the unit
tests, shellcheck, the unit file and the workflow YAML; about 15 s). Building is driven by tags,
two per version, on the free arm64 runners:

| Tag | What happens | Result |
|---|---|---|
| `vX.Y.Z-qa` | Builds the `.deb`, installs it on the runner, `ldd` + smoke test; builds the image with pi-gen (~10 min) | GitHub **pre-release** "FieldLink Kiosk X.Y.Z (QA)" with the `.img.xz`, checksum, `.deb` files and `os-list.json`. Flash this on the test Pi. |
| `vX.Y.Z` **or** Actions → *Promote to prod* (version) | **No rebuild.** Finds the `vX.Y.Z-qa` release, downloads and verifies its assets, points `os-list.json` at the prod URLs; the button also creates the `vX.Y.Z` tag on the QA commit | GitHub release "FieldLink Kiosk X.Y.Z", marked *latest*: the download churches get; `.deb` published to `apt-prod`. |

`X.Y.Z` must equal `app/package.json`'s version, and the prod tag must point at the same commit as
the QA tag (otherwise the workflow refuses, because the promoted image would not match the source).
A QA build that needs redoing gets `vX.Y.Z-qa.2`, `-qa.3`…; promotion picks the newest one on the
commit.

FieldLink's Admin → Kiosk → 🍓 Raspberry Pi Kiosk panel hands out whichever release matches the
server: the **QA server** shows the newest `vX.Y.Z-qa` pre-release, **production** the *latest*
release (`server/src/routes/kiosk.js` in the FieldLink repo, `/api/kiosk/pi-image/version`). Each
server caches that lookup for an hour; both publish jobs call its
`POST /api/kiosk/installer/invalidate` so the new build shows up at once, when the repository
secrets are set: `FIELDLINK_QA_SERVER_URL` + `KIOSK_QA_WEBHOOK_SECRET` (QA tag) and
`FIELDLINK_SERVER_URL` + `KIOSK_WEBHOOK_SECRET` (prod tag), the URL being the app host
(`https://app.qa.fieldlinkmissions.com`) and the secret that server's `KIOSK_WEBHOOK_SECRET`.
Without them the step is skipped and the panel catches up within the hour.

```bash
# after the version bump has merged:
git fetch origin main
git tag -a v0.2.0-qa origin/main -m "FieldLink Kiosk 0.2.0 QA"
git push origin v0.2.0-qa
# … flash-and-check on the Pi from the v0.2.0-qa pre-release, then either
# Actions → "Promote to prod" → version 0.2.0 (creates the tag for you), or:
git tag -a v0.2.0 origin/main -m "FieldLink Kiosk 0.2.0"
git push origin v0.2.0
```

Both paths run `scripts/promote-release.sh`; the button is the normal way, the tag is the fallback.

### Raspberry Pi Imager

Every release ships `os-list.json`. The stable address of the newest **production** one is

```
https://github.com/Whitened-Fields-Ministries/Fieldlink-Pi-Kiosk/releases/latest/download/os-list.json
```

which can be used as an Imager repository (`rpi-imager --repo <that url>`) or nested into a
larger list with `subitems_url`; QA pre-releases never become *latest*, so this only ever points at
a promoted build. A QA list lives at `…/releases/download/vX.Y.Z-qa/os-list.json`. *Use custom*
with the downloaded `.img.xz` always works too.

## Flash-and-check (Pi 4, Ethernet, milestone 1)

1. Merge the PR and push the `vX.Y.Z-qa` tag (see *Releases*). Download the `.img.xz` from the
   QA pre-release. For ssh during testing, add a user with your public key through Imager's OS
   customisation (classic `firstrun.sh` path, no cloud-init in this image).
2. Raspberry Pi Imager → *Choose OS* → *Use custom* → the `.img.xz`. Skip OS customisation for
   this first test; it can add an SSH key later (classic `firstrun.sh` path, no cloud-init in
   this image). Write the card.
3. Ethernet cable in, HDMI into the port **nearest the USB‑C connector**, a real 3 A supply.
   Power on with the TV on.
4. **Expect within ~30 s:** a dark screen with "Link this display to FieldLink" and a
   6-character code, no login prompt, no cursor. Rainbow splash and a few kernel lines before
   it are fine. Note the code renews every 15 minutes on its own.
5. In FieldLink Admin → Kiosk → 🔗 Link kiosk, type the code. **Expect within ~5 s:** the map.
6. Pull the network cable for a minute and plug it back in: the page's own offline handling
   keeps the map; the app must not restart.
7. Power-cycle: the map must be back without any code (the pairing survived in
   `/var/lib/fieldlink-kiosk/config.json`).
8. Plug in a keyboard: Ctrl+Shift+K shows the settings screen, *Details* lists the Pi's
   IP address; Ctrl+Shift+Q restarts the app within a few seconds.

**Wi‑Fi (milestone 2), same card, cable out:**

10. Power off, unplug the Ethernet cable, power on. **Expect within ~75 s:** "Set up Wi‑Fi from
    your phone" with a QR code, a network name `FieldLink-XXXX` and a 10-character password.
    (If the display was already linked, it shows the *Connecting…* screen first; the Wi‑Fi block
    replaces the pairing code area.)
11. Scan the QR with the phone camera and join. **Expect within ~10 s:** a "sign in to network"
    prompt or notification that opens the setup page (dark page, "Connect the display to Wi‑Fi",
    a list of networks). If nothing pops up, open `http://10.42.0.1/` in the phone's browser.
12. Pick the church Wi‑Fi, type its password, *Connect the display*. The phone page says the setup
    network is switching off; **the TV shows "Joining …" then the pairing code (or the map) within
    ~30 s.**
13. Wrong-password check: repeat with a bad password. **Expect:** the TV goes back to the QR
    screen with "Could not join …: The password was not accepted." and the phone, once it has
    rejoined `FieldLink-XXXX`, shows the same error with a *Try again* button.
14. Power-cycle with the cable still out: the Pi rejoins the Wi‑Fi by itself; no QR code.
15. Plug the cable back in while on Wi‑Fi: nothing visible should change; *Details* shows both.
16. Keyboard path: Ctrl+Shift+K → *Change network* lists networks with signal and band; joining
    from there works the same.
17. Over ssh, `journalctl -u fieldlink-kiosk -b | grep 'net:'` shows every decision the app made.
18. Touch (or a mouse, if no touch screen is at hand): press and hold the top-left corner for four
    seconds. **Expect:** a gold ring fills up in the corner, then the settings screen opens; the
    same hold closes it. A short tap or a drag must do nothing.

**Updates (0.3.0, needs the signing key in place and a QA release published after it):**

19. Settings screen → *Updates* → **Check now**. **Expect:** "Up to date (0.3.0) · channel prod"
    or, on a bench Pi flashed from an older QA image, "Version X is available".
20. Ctrl+Shift+S → *use qa* switches the channel; *Check now* again. Publish a newer `-qa` tag
    (any change, version bumped) and **Install update**: progress lines appear, the display goes
    dark for a few seconds and comes back on the new version; *Updates* then says
    "Updated to X (from Y)".
21. **Restart** reboots; **Show log** shows the journal; **Factory reset** (two confirmations)
    reboots to a fresh pairing code with no saved Wi‑Fi, and the Wi‑Fi hotspot appears within
    ~10 s when the cable is out.
22. Leave the Pi on overnight with an older version installed: `journalctl -u apt-daily-upgrade`
    and `/var/log/unattended-upgrades/` show the nightly install.
9. Optional, over ssh (`ssh fieldlink@<ip>` with the key from step 1):
   `journalctl -u fieldlink-kiosk -b` for the app log, `cat /etc/fieldlink-kiosk-image` for the
   build, `sudo cat /var/lib/fieldlink-kiosk/kiosk.log` for the app's own log.

Things worth writing down for the PR: how long from power to code, whether the TV negotiated
4K (`kmsprint` over ssh, or the TV's info button), whether the map is smooth in
presentation mode, anything printed to the TV before cage takes over, and for Wi‑Fi which phone
(iOS/Android version) opened the setup page by itself.

## Development

```bash
cd app
npm install
npm start                 # uses ./config.json if present; otherwise shows the link screen
npm run check             # node --check on the app files and the inline script in recovery.html
npm test                  # unit tests: nmcli parsers, the phone setup server (no Pi needed)
npm run smoke             # start, render the recovery screen once, exit 0
npm run build:deb         # arm64 package in app/dist/
npm run build:deb:amd64   # amd64 package for the Debian VM test loop
```

The app is deliberately kept line-for-line close to `main.js` in Fieldlink-Win-Kiosk: fixes to
pairing or the health loop should be ported both ways. The differences on Linux are the state
directory (`FIELDLINK_KIOSK_STATE_DIR`, set by the unit), keyboard shortcuts through
`before-input-event` (Electron's `globalShortcut` is X11-only), the clock-sync gate (a Pi has
no battery clock, so TLS fails until NTP has run; the app polls every 5 s until
`/run/systemd/timesync/synchronized` exists) and the `--smoke-test` flag.

`recovery.html` renders standalone in a browser with sample data. The phone setup page can be
looked at on a desktop too: `node -e "require('./setup-server').createSetupServer({backend:{getNetworks:async()=>({networks:[{ssid:'Demo',signal:70,secured:true,band:'2.4'}]}),getStatus:async()=>({phase:'hotspot',hotspot:{ssid:'FieldLink-DEMO'}}),connect:async()=>{}}}).start(8080,'127.0.0.1')"`
then open http://127.0.0.1:8080/.

### Test loops without a Pi

- **Seconds:** `npm start` on any Linux desktop.
- **Minutes:** install the amd64 `.deb` in a Debian trixie VM with a virtio-gpu display,
  `systemctl enable --now fieldlink-kiosk` — real cage, real unit, real PAM.
- **Image without a Pi:** `image/config` documents a local pi-gen run; mount the image's root
  partition and `systemd-nspawn -bD <mount>` boots systemd to check unit ordering (cage fails
  there by design: no display).

### Packaging

`app/scripts/build-deb.sh` runs `@electron/packager` for the target architecture and assembles
the package with `dpkg-deb` from `app/debian/`: `control.in` (dependencies use trixie's `t64`
names with bookworm alternatives), `postinst` (creates the `kiosk` user, sets the setuid sandbox
helper), `fieldlink-kiosk.service`, `pam.d-fieldlink-kiosk`, `fieldlink-kiosk-session`, the
polkit rule that lets `kiosk` drive NetworkManager, the `dnsmasq-shared.d` entry for the captive
portal, and a `sysctl.d` file that lets an unprivileged process bind port 80.
No electron-builder, no fpm: every file that ends up on the Pi is readable in this repo.

### Image

`image/stage-fieldlink/` is a pi-gen stage appended after `stage2` (Lite): installs the
`.deb` from `00-kiosk/files/`, enables the unit, sets `graphical.target`, adds
`hdmi_enable_4kp60=1` under `[pi4]` in `config.txt` and quietens the kernel console. The Wi‑Fi
regulatory domain is set to US (`wpa-country`), which is what unblocks the radio. The workflow
runs it through [usimd/pi-gen-action](https://github.com/usimd/pi-gen-action) with the pi-gen
`arm64` branch.

## Milestone 3 preparation

The apt repository that will deliver updates must be signed. `docs/apt-signing.md` has the
commands to generate the key and where to store it; nothing in milestones 1 or 2 needs it.
