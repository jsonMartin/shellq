#!/bin/sh
# Installs ShellQ into ~/.local/share/shellq and loads it from ~/.zshrc.
# Rerun to update. Usage:
#   curl -fsSL https://raw.githubusercontent.com/jsonMartin/shellq/main/install.sh | sh
set -eu

repo=${SHELLQ_REPO:-https://github.com/jsonMartin/shellq.git}
dir=${SHELLQ_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/shellq}
zshrc=${ZDOTDIR:-$HOME}/.zshrc

missing=
for cmd in git zsh jq bun; do
  command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"
done
if [ -n "$missing" ]; then
  echo "shellq: install these first:$missing (Bun: https://bun.sh)" >&2
  exit 1
fi

if [ -d "$dir/.git" ]; then
  git -C "$dir" pull --ff-only --quiet
else
  git clone --quiet --depth 1 "$repo" "$dir"
fi
(cd "$dir" && bun install --frozen-lockfile --production)

line="source '$dir/shellq.plugin.zsh'"
if ! grep -qxF "$line" "$zshrc" 2>/dev/null; then
  printf '\n%s\n' "$line" >>"$zshrc"
  echo "Added to $zshrc: $line"
fi
echo "ShellQ is installed in $dir. Open a new shell and press Ctrl+O."
