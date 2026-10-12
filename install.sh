#!/bin/sh
# Installs kndl: Bun if it's missing, the checkout in <home>/app, its dependencies, and the
# `kndl` command in ~/.local/bin; then `kndl onboard`, when there's a terminal to ask
# in. Run again on an installed machine, it updates the install and runs `kndl doctor --fix`.
#
#   curl -fsSL https://raw.githubusercontent.com/kddige/kndl/main/install.sh | sh
#   ... | sh -s -- --channel <stable|dev> --ref <branch|tag|sha> --no-onboard
#
# A fresh install follows the stable Channel: the latest Release, a tag like v2026.10.1 (ADR
# 0025). --channel dev follows main instead, and --ref, which wins over --channel, follows a
# branch or pins a tag or commit. Run on an installed machine, only what's passed changes what it
# follows.
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
  say "Usage: install.sh [--channel <stable|dev>] [--ref <branch|tag|sha>] [--no-onboard]"
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

# Clones the checkout. kndl's repo is public, so neither this nor `kndl update` needs credentials.
clone() {
  repo=$1
  app=$2
  git clone --quiet "$repo" "$app" || die "Could not clone $repo."
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

# Prints the latest Release among the checkout's tags, compared by number (v2026.10.10 is after
# v2026.10.9), or nothing. A tag with a suffix, like -beta.1, isn't a Release. The CLI's
# latestRelease in Update.ts picks the same one.
latest_release() {
  git -C "$1" tag --list 'v*' |
    grep -E '^v[0-9]{4}\.([1-9]|1[0-2])\.[1-9][0-9]*$' |
    sed 's/^v//' |
    sort -t . -k1,1n -k2,2n -k3,3n |
    tail -n 1 |
    sed 's/^./v&/'
}

# Moves a fresh checkout to its Channel, and records the Channel for `kndl update`
# (kndl.channel in the checkout's git config).
checkout_channel() {
  app=$1
  channel=$2
  if [ "$channel" = stable ]; then
    release=$(latest_release "$app")
    if [ -n "$release" ]; then
      git -C "$app" checkout --quiet --detach "refs/tags/$release"
      say "Installing Release $release."
    else
      say "There's no Release yet: installing main. kndl update moves to the first Release."
    fi
  fi
  git -C "$app" config kndl.channel "$channel"
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
  channel=""
  onboard=1
  while [ $# -gt 0 ]; do
    case $1 in
      --channel)
        [ $# -ge 2 ] || die "$1 needs a value."
        channel=$2
        shift 2
        ;;
      --channel=*)
        channel=${1#*=}
        shift
        ;;
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

  case $channel in
    "" | stable | dev) ;;
    *) die "--channel is stable or dev, not $channel." ;;
  esac
  # --ref wins over --channel.
  [ -z "$ref" ] || channel=""

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
  repo=${KNDL_REPO:-https://github.com/kddige/kndl.git}

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
    elif [ -n "$channel" ]; then
      "$wrapper" update --channel "$channel" || status=$?
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
  if [ -n "$ref" ]; then
    checkout_ref "$app" "$ref"
  else
    checkout_channel "$app" "${channel:-stable}"
  fi
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
