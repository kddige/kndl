#!/bin/sh
# Installs kndl: Bun if it's missing, the checkout in <home>/app, its dependencies, and the
# `kndl` command in ~/.local/bin; then `kndl onboard`, when there's a terminal to ask
# in. Run again on an installed machine, it updates the install and runs `kndl doctor --fix`.
#
#   gh api repos/kddige/kndl/contents/install.sh -H 'Accept: application/vnd.github.raw' | sh
#   ... | sh -s -- --ref <branch|tag|sha> --no-onboard
#
# The home is KNDL_HOME, by default ~/.kndl. KNDL_REPO overrides where the
# checkout is cloned from (a URL, or a local checkout). Everything is in functions, and the last
# line runs them, so a download cut short runs nothing.

set -eu

say() {
  printf '%s\n' "$*"
}

die() {
  printf 'kndl install: %s\n' "$*" >&2
  exit 1
}

usage() {
  say "Usage: install.sh [--ref <branch|tag|sha>] [--no-onboard]"
}

# Puts a line in the shell's startup file that adds ~/.local/bin to PATH, once.
add_to_path() {
  bin_dir=$1
  case ":${PATH}:" in
    *":${bin_dir}:"*) return 0 ;;
  esac
  case "${SHELL:-}" in
    */zsh) rc="$HOME/.zshrc" ;;
    */bash) rc="$HOME/.bashrc" ;;
    *) rc="$HOME/.profile" ;;
  esac
  if [ -f "$rc" ] && grep -q '# kndl: PATH' "$rc"; then
    return 0
  fi
  # shellcheck disable=SC2016 # $PATH expands when the startup file runs, not here.
  printf '\nexport PATH="%s:$PATH" # kndl: PATH\n' "$bin_dir" >>"$rc"
  say "Added $bin_dir to PATH in $rc: open a new shell, or run  export PATH=\"$bin_dir:\$PATH\""
}

# Finds Bun, or installs it with Bun's own installer.
find_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  if [ -x "$HOME/.bun/bin/bun" ]; then
    say "$HOME/.bun/bin/bun"
    return 0
  fi
  command -v curl >/dev/null 2>&1 || die "Bun is missing, and installing it needs curl."
  command -v bash >/dev/null 2>&1 || die "Bun is missing, and its installer needs bash."
  say "Installing Bun (https://bun.sh)..." >&2
  curl -fsSL https://bun.sh/install | bash >&2
  [ -x "$HOME/.bun/bin/bun" ] || die "Bun's installer didn't leave $HOME/.bun/bin/bun."
  say "$HOME/.bun/bin/bun"
}

# Clones the checkout. A private GitHub repo is cloned with gh, and the checkout keeps using gh's
# credentials (in its own git config only), so `kndl update` can fetch.
clone() {
  repo=$1
  app=$2
  if [ -n "${KNDL_REPO:-}" ]; then
    git clone --quiet "$repo" "$app"
    return 0
  fi
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh repo clone "$repo" "$app" -- --quiet
    git -C "$app" config credential.https://github.com.helper ''
    git -C "$app" config --add credential.https://github.com.helper '!gh auth git-credential'
    return 0
  fi
  git clone --quiet "https://github.com/$repo.git" "$app" ||
    die "Could not clone $repo: it's private, so install gh and run  gh auth login  first."
}

# Moves a fresh checkout to --ref: a branch is followed, a tag or commit pinned.
checkout_ref() {
  app=$1
  ref=$2
  if git -C "$app" ls-remote --exit-code --heads origin "$ref" >/dev/null 2>&1; then
    git -C "$app" checkout --quiet -B "$ref" --track "origin/$ref"
  elif git -C "$app" ls-remote --exit-code --tags origin "$ref" >/dev/null 2>&1; then
    git -C "$app" fetch --quiet --tags origin
    git -C "$app" checkout --quiet --detach "refs/tags/$ref"
  else
    git -C "$app" checkout --quiet --detach "$ref" || die "origin has no branch, tag or commit $ref."
  fi
}

# Writes the `kndl` command; the CLI's Layout.ts writes the same script.
write_wrapper() {
  wrapper=$1
  home=$2
  bun=$3
  mkdir -p "$(dirname "$wrapper")"
  if [ -e "$wrapper" ] && ! sed -n 2p "$wrapper" | grep -q '^# kndl: written by install.sh.'; then
    die "$wrapper exists and isn't kndl's: move it, and run this again."
  fi
  {
    say '#!/bin/sh'
    say '# kndl: written by install.sh. Runs the CLI from the installed checkout.'
    say ": \"\${KNDL_HOME:=$home}\""
    say 'export KNDL_HOME'
    say "exec $(quote "$bun") \"\$KNDL_HOME/app/packages/cli/src/main.ts\" \"\$@\""
  } >"$wrapper.tmp"
  chmod 755 "$wrapper.tmp"
  mv "$wrapper.tmp" "$wrapper"
}

# Quotes a word for sh, as the CLI's shellQuote does.
quote() {
  case $1 in
    *[!A-Za-z0-9_@%+=:,./-]* | '') printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Whether there's a terminal to ask questions in, even when this script is piped to sh.
has_tty() {
  [ -t 1 ] && (: </dev/tty) 2>/dev/null
}

main() {
  ref=""
  onboard=1
  while [ $# -gt 0 ]; do
    case $1 in
      --ref | --branch)
        [ $# -ge 2 ] || die "$1 needs a value."
        ref=$2
        shift 2
        ;;
      --ref=* | --branch=*)
        ref=${1#*=}
        shift
        ;;
      --no-onboard)
        onboard=0
        shift
        ;;
      -h | --help)
        usage
        return 0
        ;;
      *)
        usage >&2
        die "unknown option $1"
        ;;
    esac
  done

  case "$(uname -s)" in
    Darwin | Linux) ;;
    *) die "kndl runs on macOS and Linux." ;;
  esac
  [ -n "${HOME:-}" ] || die "HOME isn't set."
  command -v git >/dev/null 2>&1 || die "git is missing: install it, and run this again."

  home=${KNDL_HOME:-$HOME/.kndl}
  case $home in
    /*) ;;
    *) die "KNDL_HOME must be an absolute path, not $home." ;;
  esac
  home=${home%/}
  [ -n "$home" ] && [ "$home" != "${HOME%/}" ] || die "KNDL_HOME can't be / or your home directory."
  app="$home/app"
  wrapper="$HOME/.local/bin/kndl"
  repo=${KNDL_REPO:-kddige/kndl}

  bun=$(find_bun)
  mkdir -p "$home"

  if [ -d "$app/.git" ]; then
    say "kndl is installed in $home: updating it."
    write_wrapper "$wrapper" "$home" "$bun"
    add_to_path "$(dirname "$wrapper")"
    export KNDL_HOME="$home"
    # update ends with doctor, which fails on what --fix may repair: run it either way, and fail
    # if either did.
    status=0
    if [ -n "$ref" ]; then
      "$wrapper" update --ref "$ref" || status=$?
    else
      "$wrapper" update || status=$?
    fi
    if has_tty; then
      "$wrapper" doctor --fix </dev/tty || status=$?
    else
      "$wrapper" doctor --fix || status=$?
    fi
    return "$status"
  fi

  [ ! -e "$app" ] || die "$app exists but isn't a git checkout: move it, and run this again."
  say "Installing kndl in $home."
  clone "$repo" "$app"
  [ -z "$ref" ] || checkout_ref "$app" "$ref"
  (cd "$app" && "$bun" install --frozen-lockfile)
  write_wrapper "$wrapper" "$home" "$bun"
  add_to_path "$(dirname "$wrapper")"
  export KNDL_HOME="$home"
  say "Installed: $wrapper"

  if [ "$onboard" = 1 ] && has_tty; then
    "$wrapper" onboard </dev/tty
  else
    say "Next: kndl onboard  (set up a Hub, a Runner, or both)."
  fi
}

main "$@"
