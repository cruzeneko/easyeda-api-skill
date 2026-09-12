#!/usr/bin/env bash
#
# Installer for the easyeda-api skill.
#
# Does three things, and asks before doing any of them:
#   1. Makes a suitable Node.js available (reuses a system one if new enough,
#      otherwise downloads an official build into a user-local prefix).
#   2. Installs the `ws` dependency into this checkout.
#   3. Registers the skill with Claude Code by linking it into ~/.claude/skills.
#
# It deliberately does NOT start the bridge server. The bridge executes
# arbitrary JavaScript inside your EasyEDA client; starting it should stay a
# separate, deliberate act. See SECURITY-PATCH.md.
#
# Usage:
#   scripts/install.sh [options]
#
#   -y, --yes               Skip the confirmation prompt
#   -n, --dry-run           Print the plan and exit without changing anything
#       --copy              Copy the skill instead of symlinking it
#       --project           Install into ./.claude/skills instead of ~/.claude/skills
#       --node-version VER  Node version to fetch if one must be installed
#       --prefix DIR        Where to install a user-local Node
#       --force             Replace an existing skill install that is not ours
#   -h, --help              Show this help

set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────
# Pinned rather than "latest": a pinned version is reproducible, and the
# EasyEDA pro-api-sdk requires >= 20.17.0.
NODE_VERSION="${EASYEDA_NODE_VERSION:-v22.11.0}"
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=17
MIN_NODE_PATCH=0
SKILL_NAME="easyeda-api"

NODE_PREFIX="${EASYEDA_NODE_PREFIX:-$HOME/.local/share/easyeda-api-node}"
ASSUME_YES=0
DRY_RUN=0
LINK_MODE="symlink"
SCOPE="user"
FORCE=0

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

# ─── Output helpers ─────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

info()  { printf '%s\n' "$*"; }
step()  { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
warn()  { printf '%swarning:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()   { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
ok()    { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }

usage() { sed -n '3,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# ─── Argument parsing ───────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes)       ASSUME_YES=1 ;;
    -n|--dry-run)   DRY_RUN=1 ;;
    --copy)         LINK_MODE="copy" ;;
    --project)      SCOPE="project" ;;
    --force)        FORCE=1 ;;
    --node-version) [ $# -ge 2 ] || die "--node-version needs a value"; NODE_VERSION="$2"; shift ;;
    --prefix)       [ $# -ge 2 ] || die "--prefix needs a value"; NODE_PREFIX="$2"; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

case "$NODE_VERSION" in
  v*) ;;
  *)  NODE_VERSION="v$NODE_VERSION" ;;
esac

if [ "$SCOPE" = "project" ]; then
  SKILLS_ROOT="$PWD/.claude/skills"
else
  SKILLS_ROOT="$HOME/.claude/skills"
fi
SKILL_TARGET="$SKILLS_ROOT/$SKILL_NAME"

# ─── Platform detection ─────────────────────────────────────────────
detect_platform() {
  local os arch
  case "$(uname -s)" in
    Linux)  os="linux" ;;
    Darwin) os="darwin" ;;
    *)      die "unsupported OS: $(uname -s). Install Node $NODE_VERSION manually, then re-run." ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    armv7l)        arch="armv7l" ;;
    *)             die "unsupported CPU: $(uname -m). Install Node $NODE_VERSION manually, then re-run." ;;
  esac
  printf '%s-%s\n' "$os" "$arch"
}

# ─── Node discovery ─────────────────────────────────────────────────

# Compare a "vX.Y.Z" string against the minimum. Returns 0 if new enough.
node_version_ok() {
  local v="${1#v}" major minor patch
  IFS=. read -r major minor patch <<<"$v"
  [ -n "${major:-}" ] || return 1
  minor="${minor:-0}"; patch="${patch:-0}"
  # Strip any prerelease suffix such as 22.0.0-rc.1
  patch="${patch%%-*}"
  case "$major$minor$patch" in *[!0-9]*) return 1 ;; esac
  if   [ "$major" -gt "$MIN_NODE_MAJOR" ]; then return 0
  elif [ "$major" -lt "$MIN_NODE_MAJOR" ]; then return 1
  elif [ "$minor" -gt "$MIN_NODE_MINOR" ]; then return 0
  elif [ "$minor" -lt "$MIN_NODE_MINOR" ]; then return 1
  elif [ "$patch" -ge "$MIN_NODE_PATCH" ]; then return 0
  fi
  return 1
}

# Sets NODE_BIN and NODE_SOURCE. NODE_SOURCE is one of: system, local, install.
find_node() {
  local candidate version
  for candidate in "$NODE_PREFIX/bin/node" "$(command -v node 2>/dev/null || true)"; do
    [ -n "$candidate" ] || continue
    [ -x "$candidate" ] || continue
    version="$("$candidate" --version 2>/dev/null || true)"
    if node_version_ok "$version"; then
      NODE_BIN="$candidate"
      NODE_VERSION_FOUND="$version"
      case "$candidate" in
        "$NODE_PREFIX"/*) NODE_SOURCE="local" ;;
        *)                NODE_SOURCE="system" ;;
      esac
      return 0
    fi
    [ -n "$version" ] && NODE_TOO_OLD="$version ($candidate)"
  done
  NODE_BIN="$NODE_PREFIX/bin/node"
  NODE_SOURCE="install"
  return 0
}

# ─── Download helpers ───────────────────────────────────────────────
fetch() {
  # fetch <url> <dest>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --https-only -O "$2" "$1"
  else
    die "need curl or wget to download Node.js"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "need sha256sum or shasum to verify the Node.js download"
  fi
}

install_node() {
  local platform tarball url base tmp expected actual
  platform="$(detect_platform)"
  base="https://nodejs.org/dist/$NODE_VERSION"
  tarball="node-$NODE_VERSION-$platform.tar.xz"
  url="$base/$tarball"

  command -v tar >/dev/null 2>&1 || die "need tar to unpack Node.js"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  step "Downloading $tarball"
  fetch "$url" "$tmp/$tarball" || die "download failed: $url"

  step "Verifying checksum against $base/SHASUMS256.txt"
  fetch "$base/SHASUMS256.txt" "$tmp/SHASUMS256.txt" || die "could not fetch SHASUMS256.txt"
  expected="$(awk -v f="$tarball" '$2 == f {print $1}' "$tmp/SHASUMS256.txt")"
  [ -n "$expected" ] || die "no checksum published for $tarball — is $NODE_VERSION a real release?"
  actual="$(sha256_of "$tmp/$tarball")"
  [ "$expected" = "$actual" ] || die "checksum mismatch for $tarball
  expected: $expected
  actual:   $actual"
  ok "checksum verified"

  step "Installing Node $NODE_VERSION into $NODE_PREFIX"
  rm -rf "$NODE_PREFIX"
  mkdir -p "$NODE_PREFIX"
  tar -xJf "$tmp/$tarball" -C "$NODE_PREFIX" --strip-components=1
  [ -x "$NODE_PREFIX/bin/node" ] || die "install finished but $NODE_PREFIX/bin/node is missing"
  ok "node $("$NODE_PREFIX/bin/node" --version) installed"
}

# ─── Plan ───────────────────────────────────────────────────────────
NODE_BIN=""; NODE_SOURCE=""; NODE_VERSION_FOUND=""; NODE_TOO_OLD=""
find_node

DEPS_PRESENT=0
[ -d "$SKILL_DIR/node_modules/ws" ] && DEPS_PRESENT=1

SKILL_STATE="new"
if [ -L "$SKILL_TARGET" ]; then
  if [ "$(readlink "$SKILL_TARGET")" = "$SKILL_DIR" ]; then
    SKILL_STATE="already-linked"
  else
    SKILL_STATE="foreign-link"
  fi
elif [ -e "$SKILL_TARGET" ]; then
  SKILL_STATE="foreign-dir"
fi

printf '\n%sPlan%s\n' "$BOLD" "$RESET"
printf '  %sskill checkout%s  %s\n' "$DIM" "$RESET" "$SKILL_DIR"

case "$NODE_SOURCE" in
  system) printf '  %snode%s            reuse %s (%s)\n' "$DIM" "$RESET" "$NODE_VERSION_FOUND" "$NODE_BIN" ;;
  local)  printf '  %snode%s            reuse %s (%s)\n' "$DIM" "$RESET" "$NODE_VERSION_FOUND" "$NODE_BIN" ;;
  install)
    printf '  %snode%s            DOWNLOAD %s from nodejs.org into %s\n' "$DIM" "$RESET" "$NODE_VERSION" "$NODE_PREFIX"
    if [ -n "$NODE_TOO_OLD" ]; then
      printf '                  %s(found %s, need >= %s.%s.%s)%s\n' \
        "$DIM" "$NODE_TOO_OLD" "$MIN_NODE_MAJOR" "$MIN_NODE_MINOR" "$MIN_NODE_PATCH" "$RESET"
    fi
    printf '                  %sno sudo, nothing written outside your home directory%s\n' "$DIM" "$RESET"
    ;;
esac

if [ "$DEPS_PRESENT" = 1 ]; then
  printf '  %sdependencies%s    already present (node_modules/ws)\n' "$DIM" "$RESET"
else
  printf '  %sdependencies%s    npm install `ws` into %s/node_modules\n' "$DIM" "$RESET" "$SKILL_DIR"
fi

case "$SKILL_STATE" in
  already-linked) printf '  %sskill install%s   already linked at %s\n' "$DIM" "$RESET" "$SKILL_TARGET" ;;
  new)            printf '  %sskill install%s   %s %s -> %s\n' "$DIM" "$RESET" "$LINK_MODE" "$SKILL_TARGET" "$SKILL_DIR" ;;
  foreign-link|foreign-dir)
    if [ "$FORCE" = 1 ]; then
      printf '  %sskill install%s   %sREPLACE%s existing %s\n' "$DIM" "$RESET" "$YELLOW" "$RESET" "$SKILL_TARGET"
    else
      printf '  %sskill install%s   %sBLOCKED%s — %s already exists and is not this checkout\n' \
        "$DIM" "$RESET" "$RED" "$RESET" "$SKILL_TARGET"
    fi
    ;;
esac

printf '\n  %sThe bridge server will NOT be started. It runs arbitrary JS inside%s\n' "$DIM" "$RESET"
printf '  %sEasyEDA; start it yourself when you need it.%s\n\n' "$DIM" "$RESET"

if [ "$DRY_RUN" = 1 ]; then
  info "Dry run — nothing changed."
  exit 0
fi

if [ "$SKILL_STATE" = "foreign-link" ] || [ "$SKILL_STATE" = "foreign-dir" ]; then
  [ "$FORCE" = 1 ] || die "$SKILL_TARGET already exists and is not this checkout. Move it, or re-run with --force."
fi

# ─── Confirmation ───────────────────────────────────────────────────
if [ "$ASSUME_YES" != 1 ]; then
  # Testing -r /dev/tty is not enough: the node can exist and still fail to open
  # when the process has no controlling terminal. Probe it in a subshell so a
  # failure cannot take the script down with it.
  if (exec 3</dev/tty) 2>/dev/null; then
    HAS_TTY=1
  else
    HAS_TTY=0
  fi
  if [ "$HAS_TTY" != 1 ]; then
    # Reading a piped stdin here would let `curl ... | bash` answer its own
    # prompt. Require the flag instead, so consent is always explicit.
    die "no terminal to prompt on — re-run with --yes to accept the plan above"
  fi
  printf '%sProceed?%s [y/N] ' "$BOLD" "$RESET"
  reply=""
  read -r reply </dev/tty || reply=""
  case "$reply" in
    y|Y|yes|YES|Yes) ;;
    *) info "Aborted. Nothing changed."; exit 1 ;;
  esac
  printf '\n'
fi

# ─── Execute ────────────────────────────────────────────────────────
if [ "$NODE_SOURCE" = "install" ]; then
  install_node
  NODE_BIN="$NODE_PREFIX/bin/node"
fi

NODE_DIR="$(cd -- "$(dirname -- "$NODE_BIN")" && pwd)"
NPM_BIN="$NODE_DIR/npm"
[ -x "$NPM_BIN" ] || NPM_BIN="$(command -v npm 2>/dev/null || true)"
[ -n "$NPM_BIN" ] || die "found node at $NODE_BIN but no npm alongside it"

if [ "$DEPS_PRESENT" != 1 ]; then
  step "Installing dependencies"
  if [ -f "$SKILL_DIR/package-lock.json" ]; then
    # npm ci honours the lockfile exactly; npm install may silently drift.
    PATH="$NODE_DIR:$PATH" "$NPM_BIN" ci --omit=dev --prefix "$SKILL_DIR" \
      || die "npm ci failed"
  else
    PATH="$NODE_DIR:$PATH" "$NPM_BIN" install --omit=dev --prefix "$SKILL_DIR" \
      || die "npm install failed"
  fi
  ok "dependencies installed"
fi

if [ "$SKILL_STATE" != "already-linked" ]; then
  step "Registering the skill at $SKILL_TARGET"
  mkdir -p "$SKILLS_ROOT"
  rm -rf "$SKILL_TARGET"
  if [ "$LINK_MODE" = "copy" ]; then
    mkdir -p "$SKILL_TARGET"
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --exclude .git "$SKILL_DIR"/ "$SKILL_TARGET"/
    else
      (cd "$SKILL_DIR" && tar --exclude=.git -cf - .) | (cd "$SKILL_TARGET" && tar -xf -)
    fi
  else
    ln -s "$SKILL_DIR" "$SKILL_TARGET"
  fi
  ok "skill registered"
fi

# ─── Verify ─────────────────────────────────────────────────────────
step "Verifying"
"$NODE_BIN" --version >/dev/null || die "node is not runnable"
[ -d "$SKILL_DIR/node_modules/ws" ] || die "the ws dependency is missing after install"
[ -f "$SKILL_TARGET/SKILL.md" ] || die "$SKILL_TARGET/SKILL.md is not readable"

# Advisory: older Node parses --check as CommonJS and trips over ESM syntax,
# so a failure here is not necessarily a real syntax error.
if "$NODE_BIN" --check "$SKILL_DIR/scripts/bridge-server.mjs" 2>/dev/null; then
  ok "bridge-server.mjs parses cleanly"
else
  warn "could not syntax-check bridge-server.mjs (node --check may not support ESM on this version)"
fi
ok "verification passed"

# ─── Next steps ─────────────────────────────────────────────────────
cat <<EOF

${BOLD}Installed.${RESET}

  skill     $SKILL_TARGET
  node      $NODE_BIN
EOF

if [ "$NODE_SOURCE" = "install" ]; then
  cat <<EOF

  That Node lives in $NODE_PREFIX and is not on your PATH. To use it from a
  shell, add:

      export PATH="$NODE_PREFIX/bin:\$PATH"
EOF
fi

cat <<EOF

Next:
  1. Restart Claude Code so it picks up the new skill.
  2. Install the run-api-gateway extension in EasyEDA Pro:
     https://jlc-ext.com/item/oshwhub/run-api-gateway
  3. Start the bridge only when you need it:

       "$NODE_BIN" "$SKILL_TARGET/scripts/bridge-server.mjs" &

     It prints a bearer token to ~/.easyeda-bridge/token. Every request needs it:

       curl -H "Authorization: Bearer \$(cat ~/.easyeda-bridge/token)" \\
         http://localhost:49620/health

  4. Stop it when you are done. While it runs, it is a live code-execution
     channel into your EasyEDA client. See SECURITY-PATCH.md.
EOF
