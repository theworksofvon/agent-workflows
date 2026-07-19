#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
source_dir="$repo_root/skills"

for target_dir in "$HOME/.codex/skills" "$HOME/.claude/skills" "$HOME/.cursor/skills"; do
  mkdir -p "$target_dir"

  for skill_file in "$source_dir"/*/SKILL.md; do
    skill_dir=$(dirname -- "$skill_file")
    skill_name=$(basename -- "$skill_dir")
    link_path="$target_dir/$skill_name"

    if [ -e "$link_path" ] && [ ! -L "$link_path" ]; then
      printf 'skip: %s exists and is not a symlink\n' "$link_path" >&2
      continue
    fi

    ln -sfn "$skill_dir" "$link_path"
    printf '%s -> %s\n' "$link_path" "$skill_dir"
  done
done
