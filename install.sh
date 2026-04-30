#!/usr/bin/env sh
set -eu

repo="${DISCODE_REPO:-https://github.com/morefeinn/discode.git}"
target="${DISCODE_HOME:-$HOME/discode}"

ask_yes() {
    prompt="$1"

    if [ "${DISCODE_YES:-}" = "1" ]; then
        return 0
    fi

    if [ -r /dev/tty ]; then
        printf "%s [y/N]: " "$prompt" > /dev/tty
        read answer < /dev/tty
    else
        answer=""
    fi

    case "$answer" in
        y|Y|yes|YES) return 0 ;;
        *) return 1 ;;
    esac
}

install_with_brew() {
    name="$1"

    if command -v brew >/dev/null 2>&1; then
        brew install "$name"
        return 0
    fi

    return 1
}

if ! command -v git >/dev/null 2>&1; then
    if ask_yes "Install git"; then
        install_with_brew git || {
            echo "Install git, then run this installer again."
            exit 1
        }
    else
        echo "git is required."
        exit 1
    fi
fi

if ! command -v bun >/dev/null 2>&1; then
    if ask_yes "Install Bun"; then
        curl -fsSL https://bun.sh/install | bash
        export PATH="$HOME/.bun/bin:$PATH"
    else
        echo "Bun is required."
        exit 1
    fi
fi

if [ -d "$target/.git" ]; then
    git -C "$target" pull --ff-only
else
    git clone "$repo" "$target"
fi

cd "$target"
bun install
bun link

if [ "${DISCODE_SETUP:-1}" != "0" ]; then
    if [ -r /dev/tty ] && [ -z "${DISCODE_SETUP_ARGS:-}" ]; then
        bun bin/discode.mjs setup < /dev/tty
    else
        bun bin/discode.mjs setup ${DISCODE_SETUP_ARGS:-}
    fi
fi
