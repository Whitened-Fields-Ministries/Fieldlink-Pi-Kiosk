#!/usr/bin/env bash
# Builds fieldlink-pi-kiosk_<version>_<arch>.deb into app/dist/.
#
#   scripts/build-deb.sh arm64     # Raspberry Pi 4/5 (the image)
#   scripts/build-deb.sh amd64     # Debian VM test loop on a PC
#
# @electron/packager fetches the prebuilt Electron for the target architecture
# (works on any host: no cross toolchain), then dpkg-deb assembles the package
# from app/debian/. No fpm, no electron-builder: the unit, PAM stack and
# maintainer scripts are plain files in this repo and easy to audit.
set -euo pipefail

ARCH="${1:-arm64}"
case "$ARCH" in
  arm64) PACKAGER_ARCH=arm64 ;;
  amd64) PACKAGER_ARCH=x64 ;;
  *) echo "usage: $0 arm64|amd64" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.." || exit 1
NAME=fieldlink-pi-kiosk
VERSION="$(node -p "require('./package.json').version")"
OUT="dist"
PACK="$OUT/pack-$ARCH"
ROOT="$OUT/root-$ARCH"
DEB="$OUT/${NAME}_${VERSION}_${ARCH}.deb"

rm -rf "$PACK" "$ROOT"
mkdir -p "$OUT"

echo "==> packaging Electron app for linux/$PACKAGER_ARCH"
npx --no-install @electron/packager . "$NAME" \
  --platform=linux --arch="$PACKAGER_ARCH" \
  --out="$PACK" --overwrite --asar \
  --app-version="$VERSION" \
  --ignore='^/dist' --ignore='^/debian' --ignore='^/scripts' --ignore='^/node_modules' \
  --ignore='^/config(\.example)?\.json' --ignore='^/\.gitignore' --ignore='^/README\.md'

APP_SRC="$PACK/${NAME}-linux-${PACKAGER_ARCH}"
test -x "$APP_SRC/$NAME"

echo "==> assembling package tree"
install -d "$ROOT/DEBIAN" "$ROOT/opt" "$ROOT/usr/bin" "$ROOT/usr/lib/systemd/system" \
  "$ROOT/etc/pam.d" "$ROOT/usr/share/doc/$NAME"
cp -a "$APP_SRC" "$ROOT/opt/$NAME"
# packager leaves its output directory 0700; the app runs as the kiosk user.
chmod 0755 "$ROOT/opt/$NAME"
chmod -R a+rX "$ROOT/opt/$NAME"
ln -s "/opt/$NAME/$NAME" "$ROOT/usr/bin/$NAME"
install -m 0755 debian/fieldlink-kiosk-session "$ROOT/usr/bin/fieldlink-kiosk-session"
install -m 0644 debian/fieldlink-kiosk.service "$ROOT/usr/lib/systemd/system/fieldlink-kiosk.service"
install -m 0644 debian/pam.d-fieldlink-kiosk "$ROOT/etc/pam.d/fieldlink-kiosk"
install -m 0644 debian/copyright "$ROOT/usr/share/doc/$NAME/copyright"
install -m 0755 debian/postinst debian/prerm debian/postrm "$ROOT/DEBIAN/"
printf '/etc/pam.d/fieldlink-kiosk\n' > "$ROOT/DEBIAN/conffiles"

SIZE_KB="$(du -sk --apparent-size "$ROOT" --exclude=DEBIAN | cut -f1)"
sed -e "s/@VERSION@/$VERSION/" -e "s/@ARCH@/$ARCH/" -e "s/@SIZE@/$SIZE_KB/" debian/control.in > "$ROOT/DEBIAN/control"

echo "==> building $DEB"
rm -f "$DEB"
dpkg-deb --build --root-owner-group -Zxz "$ROOT" "$DEB"
dpkg-deb --info "$DEB"
(cd "$OUT" && sha256sum "$(basename "$DEB")" > "$(basename "$DEB").sha256")
echo "==> $DEB"
