#!/usr/bin/env zsh

emulate -LR zsh
setopt no_aliases
unsetopt bg_nice

typeset script_dir=${0:A:h}
exec bun "$script_dir/local-openai-provider.ts"
