#!/usr/bin/env bash
# Publishes the packages for a tag whose GitHub release already exists:
# builds the Arch package and attaches it to the release, then points the
# Homebrew tap at the tag's tarball. Run on Arch with gh signed in.
#   scripts/release.sh v1.0.0-beta.2
set -euo pipefail

tag=${1:?usage: scripts/release.sh <tag>}
repo=jsonMartin/shellq
tap=jsonMartin/homebrew-shellq
root=$(cd "$(dirname "$0")/.." && pwd)
# Arch versions cannot contain "-": v1.0.0-beta.2 becomes 1.0.0beta2.
pkgver=$(sed -E 's/^v//; s/-([a-z]+)\.?/\1/' <<<"$tag")

gh release view "$tag" --repo "$repo" >/dev/null
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

url="https://github.com/$repo/archive/refs/tags/$tag.tar.gz"
mkdir "$work/arch"
curl -fsSL "$url" -o "$work/arch/shellq-$tag.tar.gz"
sha=$(sha256sum "$work/arch/shellq-$tag.tar.gz" | cut -d' ' -f1)

sed -e "s/@TAG@/$tag/" -e "s/@PKGVER@/$pkgver/" -e "s/@SHA256@/$sha/" \
  "$root/packaging/arch/PKGBUILD.in" >"$work/arch/PKGBUILD"
cp "$root/packaging/arch/shellq.install" "$work/arch/"
# -d: bun is often installed outside pacman; build() fails loudly without it.
(cd "$work/arch" && makepkg -df --noconfirm)
gh release upload "$tag" "$work"/arch/*.pkg.tar.zst --repo "$repo" --clobber

git clone --quiet "https://github.com/$tap.git" "$work/tap"
sed -i -E "s|^  url .*|  url \"$url\"|; s|^  sha256 .*|  sha256 \"$sha\"|" "$work/tap/Formula/shellq.rb"
if git -C "$work/tap" diff --quiet; then
  echo "Homebrew tap already points at $tag."
else
  git -C "$work/tap" \
    -c user.name="$(git -C "$root" log -1 --format=%an)" \
    -c user.email="$(git -C "$root" log -1 --format=%ae)" \
    commit -qam "shellq ${tag#v}"
  git -C "$work/tap" push -q
fi
echo "Released $tag: Arch package on the release, Homebrew tap at sha256 $sha."
