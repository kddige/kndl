#!/bin/sh
# Installs the kndl CLI from a kndl Hub, which builds it from the commit it runs
# (CliRoutes.ts serves this script at GET /cli, with the Hub's URL filled in):
#
#   curl -fsSL https://hub.example.com/cli | sh
#
# It downloads the binary for this machine's platform into KNDL_BIN_DIR, by default
# ~/.local/bin, as kndl, and records the Hub in the CLI's config,
# ${XDG_CONFIG_HOME:-~/.config}/kndl/cli.json, for the CLI to update itself from.
# KNDL_URL overrides the Hub's URL. Everything is in functions, and the last line runs them,
# so a download cut short runs nothing.

set -eu

say() {
  printf '%s\n' "$*"
}

die() {
  printf 'kndl install: %s\n' "$*" >&2
  exit 1
}

# The Hub's name for this machine's platform: darwin-arm64, darwin-x64, linux-x64 or linux-arm64.
detect_target() {
  os=$(uname -s)
  arch=$(uname -m)
  case $os in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT)
      die "kndl doesn't run on Windows. Install it in WSL, or on a Mac or Linux machine."
      ;;
    *) die "kndl runs on macOS and Linux, not $os." ;;
  esac
  case $arch in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) die "kndl runs on arm64 and x64, not $arch." ;;
  esac
  # A shell under Rosetta says x86_64 on an Apple silicon Mac: install the native binary.
  if [ "$os-$arch" = darwin-x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi
  say "$os-$arch"
}

# Downloads $1 into $2. A refusal from the Hub is shown as it said it.
download() {
  url=$1
  out=$2
  if command -v curl >/dev/null 2>&1; then
    status=$(curl -sSL -o "$out" -w '%{http_code}' "$url") || die "Couldn't reach the Hub at $url."
    if [ "$status" != 200 ]; then
      die "The Hub answered $status for $url: $(head -c 500 "$out" 2>/dev/null || true)"
    fi
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$out" "$url" || die "Couldn't download $url."
  else
    die "Installing kndl needs curl or wget."
  fi
}

# Records the Hub for the CLI, unless it is recorded already: what else the file holds is about
# that Hub, and stays.
record_hub() {
  dir=${XDG_CONFIG_HOME:-$HOME/.config}/kndl
  file=$dir/cli.json
  if [ -f "$file" ] && grep -qF "\"hub\":\"$hub_url\"" "$file"; then
    return 0
  fi
  mkdir -p "$dir"
  (umask 077 && printf '{"hub":"%s"}\n' "$hub_url" >"$file.tmp")
  mv -f "$file.tmp" "$file"
  say "Recorded the Hub in $file."
}

main() {
  case $hub_url in
    http://* | https://*) ;;
    *) die "KNDL_URL must be the Hub's http:// or https:// URL, not $hub_url." ;;
  esac
  # It goes into the CLI's config file as a JSON string.
  case $hub_url in
    *'"'* | *\\* | *' '*) die "$hub_url isn't a URL." ;;
  esac
  hub_url=${hub_url%/}
  [ -n "${HOME:-}" ] || die "HOME isn't set."

  target=$(detect_target)
  bin_dir=${KNDL_BIN_DIR:-$HOME/.local/bin}
  bin_dir=${bin_dir%/}
  dest=$bin_dir/kndl

  # The command install.sh writes runs a kndl install's own CLI, which has every command
  # this one has, and updates with the install.
  if [ -f "$dest" ] && sed -n 2p "$dest" 2>/dev/null | grep -q '^# kndl: written by install.sh.'; then
    die "$dest is the command of the kndl install on this machine, which has every command this one has and updates with the install. To install this one elsewhere, set KNDL_BIN_DIR."
  fi

  mkdir -p "$bin_dir"
  partial=$dest.download-$$
  trap 'rm -f "$partial"' EXIT
  say "Downloading kndl for $target from $hub_url (the Hub builds it the first time it's asked, which can take a minute)..."
  download "$hub_url/cli/$target" "$partial"
  chmod 755 "$partial"
  if [ "${target%%-*}" = darwin ]; then
    # The signature bun build --compile gives a binary doesn't hold on macOS, which kills such a
    # binary as it starts: sign it again, ad hoc.
    codesign --force --sign - "$partial" >/dev/null 2>&1 || die "Couldn't sign the binary for macOS with codesign."
  fi
  version=$(KNDL_NO_SELF_UPDATE=1 "$partial" --version) || die "The downloaded kndl doesn't run on this machine."
  mv -f "$partial" "$dest"
  trap - EXIT
  record_hub
  say "Installed $version in $dest."

  case ":${PATH:-}:" in
    *":$bin_dir:"*)
      found=$(command -v kndl 2>/dev/null || true)
      if [ -n "$found" ] && [ "$found" != "$dest" ]; then
        say "Note: kndl on your PATH is $found, which comes before $dest."
      fi
      ;;
    *)
      say "$bin_dir isn't on your PATH. Add it in your shell's startup file:"
      say ""
      say "  export PATH=\"$bin_dir:\$PATH\""
      ;;
  esac
}

hub_url=${KNDL_URL:-@HUB_URL@}
main "$@"
