#!/bin/bash -e
# FieldLink kiosk stage: install the app package built by the app workflow
# (dropped into files/ by the image workflow), enable the display unit and
# tune the boot config. Runs on top of a stock Raspberry Pi OS Lite rootfs.

DEB="$(ls files/fieldlink-pi-kiosk_*_arm64.deb 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "${DEB}" ]; then
	echo "stage-fieldlink: no files/fieldlink-pi-kiosk_*_arm64.deb — download one from the app release first" >&2
	exit 1
fi

install -m 644 "${DEB}" "${ROOTFS_DIR}/tmp/fieldlink-pi-kiosk.deb"
on_chroot << EOF
apt-get install -y --no-install-recommends /tmp/fieldlink-pi-kiosk.deb
rm -f /tmp/fieldlink-pi-kiosk.deb
EOF

# The display is the only thing this machine does: start it at boot instead of
# a login prompt on tty1, and never rename the first user on first boot.
# userconfig.service is the first-boot rename wizard from userconf-pi. It is
# not enabled in this image, but rename-user (which cloud-init's Raspberry Pi
# hook calls after creating a user) would enable it; masking makes sure the
# TV never shows a keyboard/username dialog instead of the pairing code.
on_chroot << EOF
systemctl set-default graphical.target
systemctl enable fieldlink-kiosk.service
systemctl disable getty@tty1.service
systemctl mask userconfig.service
rm -f /etc/xdg/autostart/piwiz.desktop
EOF

# Version marker for the recovery screen and support.
echo "fieldlink-kiosk-image ${FIELDLINK_IMAGE_VERSION:-dev} $(basename "${DEB}")" > "${ROOTFS_DIR}/etc/fieldlink-kiosk-image"

# Boot config: 4K at 60 Hz on the Pi 4 (the Pi 5 does it by default; the
# setting is ignored there). Keep the [all] section last as config.txt expects.
CONFIG="${ROOTFS_DIR}/boot/firmware/config.txt"
if ! grep -q '^hdmi_enable_4kp60=1' "${CONFIG}"; then
	cat >> "${CONFIG}" << 'EOT'

# FieldLink kiosk: 4K at 60 Hz on a Pi 4 (no effect on a Pi 5).
[pi4]
hdmi_enable_4kp60=1

[all]
EOT
fi

# Quieter boot on the TV: no kernel messages or blinking console cursor before
# the display starts. Everything still goes to the journal and the serial port.
CMDLINE="${ROOTFS_DIR}/boot/firmware/cmdline.txt"
if ! grep -q 'vt.global_cursor_default=0' "${CMDLINE}"; then
	sed -i 's/$/ quiet loglevel=3 logo.nologo vt.global_cursor_default=0 consoleblank=0/' "${CMDLINE}"
fi
