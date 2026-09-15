#!/usr/bin/env bash
# Promote a tested QA build to production without rebuilding.
#
#   scripts/promote-release.sh <X.Y.Z> [--create-tag]
#
# Finds the newest vX.Y.Z-qa* tag, checks that app/package.json at that commit
# says X.Y.Z and that the QA release exists, then:
#   --create-tag   creates the annotated tag vX.Y.Z on that commit and pushes
#                  it (the "Promote to prod" workflow button); without it the
#                  tag vX.Y.Z must already exist and point at the same commit
#                  (the tag-push path in release.yml).
# Downloads the QA release assets, verifies every .sha256, rewrites
# os-list.json to the prod URLs and name, publishes (or updates) the GitHub
# release vX.Y.Z as *latest*, and publishes the .deb to the apt-prod channel
# when the signing key is set up (scripts/publish-apt.sh).
#
# Needs: gh (GH_TOKEN with contents: write), git with tags, GITHUB_REPOSITORY.
set -euo pipefail

VERSION="${1:?version X.Y.Z}"; shift || true
CREATE=0; [ "${1:-}" = "--create-tag" ] && CREATE=1
: "${GH_TOKEN:?GH_TOKEN}" "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY}"
die() { echo "::error::$*" >&2; exit 1; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be X.Y.Z, got '$VERSION'"

git fetch --quiet --tags origin
qa_tag="$(git tag -l "v${VERSION}-qa" "v${VERSION}-qa.*" --sort=-v:refname | head -n 1)"
[ -n "$qa_tag" ] || die "no v${VERSION}-qa tag exists. Tag QA first (git tag -a v${VERSION}-qa <sha>), test it, then promote."
qa_sha="$(git rev-parse "${qa_tag}^{commit}")"
pkg="$(git show "${qa_sha}:app/package.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
[ "$pkg" = "$VERSION" ] || die "app/package.json at $qa_tag says $pkg, not $VERSION"
gh release view "$qa_tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1 || die "GitHub release for $qa_tag not found (did its build finish?)"
echo "QA build: $qa_tag at ${qa_sha:0:9}"

prod_tag="v${VERSION}"
if git rev-parse -q --verify "refs/tags/${prod_tag}^{commit}" >/dev/null 2>&1; then
  have="$(git rev-parse "${prod_tag}^{commit}")"
  [ "$have" = "$qa_sha" ] || die "$prod_tag already exists on ${have:0:9}, but $qa_tag is at ${qa_sha:0:9}. Refusing to publish a release whose tag does not match its build."
  echo "Tag $prod_tag already on the QA commit."
elif [ "$CREATE" = 1 ]; then
  # Create the annotated tag through the REST API, not `git push`: GitHub
  # refuses a git push from the workflow token when the tagged tree contains
  # .github/workflows (it would need the `workflows` permission), but the Git
  # Data API only needs contents: write.
  tag_obj="$(python3 -c 'import json,sys; print(json.dumps({"tag": sys.argv[1], "message": "FieldLink Kiosk " + sys.argv[2], "object": sys.argv[3], "type": "commit", "tagger": {"name": "github-actions[bot]", "email": "41898282+github-actions[bot]@users.noreply.github.com"}}))' "$prod_tag" "$VERSION" "$qa_sha" \
    | gh api "repos/${GITHUB_REPOSITORY}/git/tags" --input - --jq .sha)"
  gh api "repos/${GITHUB_REPOSITORY}/git/refs" -f ref="refs/tags/${prod_tag}" -f sha="$tag_obj" >/dev/null
  echo "Created $prod_tag at ${qa_sha:0:9} (tag object ${tag_obj:0:9})."
else
  die "tag $prod_tag does not exist. Push it on ${qa_sha:0:9}, or use the Promote to prod workflow."
fi

OUT="$(mktemp -d)"
( cd "$OUT"
  gh release download "$qa_tag" --repo "$GITHUB_REPOSITORY"
  ls -l
  for f in *.sha256; do sha256sum -c "$f"; done
  python3 - "$qa_tag" "$prod_tag" <<'PY'
import json, sys
qa, prod = sys.argv[1], sys.argv[2]
d = json.load(open('os-list.json'))
for e in d['os_list']:
    e['url'] = e['url'].replace(f'/releases/download/{qa}/', f'/releases/download/{prod}/')
    e['name'] = e['name'].replace(' (QA)', '')
json.dump(d, open('os-list.json', 'w'), indent=2)
print(open('os-list.json').read())
PY
)

img="$(ls "$OUT"/*.img.xz | head -n 1 | xargs -n1 basename)"
notes="Raspberry Pi kiosk image \`${img}\` (Raspberry Pi OS Lite trixie, arm64, Pi 4 and Pi 5) and the kiosk app package. Same build as \`${qa_tag}\`, promoted after testing.

**Flash it** with Raspberry Pi Imager → *Use custom*, or add this list as a repository: \`https://github.com/${GITHUB_REPOSITORY}/releases/latest/download/os-list.json\`."
if gh release view "$prod_tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  gh release upload "$prod_tag" "$OUT"/* --repo "$GITHUB_REPOSITORY" --clobber
  gh release edit "$prod_tag" --repo "$GITHUB_REPOSITORY" --title "FieldLink Kiosk ${VERSION}" --notes "$notes" --prerelease=false --latest
else
  gh release create "$prod_tag" "$OUT"/* --repo "$GITHUB_REPOSITORY" --title "FieldLink Kiosk ${VERSION}" --notes "$notes" --latest
fi
echo "==> https://github.com/${GITHUB_REPOSITORY}/releases/tag/${prod_tag}"

HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -f app/debian/fieldlink-apt.public.asc ]; then
  "$HERE/publish-apt.sh" prod "$OUT"/*.deb
else
  echo "no app/debian/fieldlink-apt.public.asc — apt-prod channel not published (packages carry no update channel)"
fi
rm -rf "$OUT"
