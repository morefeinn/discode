#!/usr/bin/env sh
set -eu

repo="${DISCODE_REPO:-https://github.com/morefeinn/discode.git}"
target="${DISCODE_HOME:-$HOME/discode}"

sudo_cmd() {
    if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
        printf ""
    elif command -v sudo >/dev/null 2>&1; then
        printf "sudo "
    else
        printf ""
    fi
}

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

install_git() {
    if command -v brew >/dev/null 2>&1; then
        brew install git
    elif command -v apt-get >/dev/null 2>&1; then
        sh -c "$(sudo_cmd)apt-get update && $(sudo_cmd)apt-get install -y git"
    elif command -v dnf >/dev/null 2>&1; then
        sh -c "$(sudo_cmd)dnf install -y git"
    elif command -v yum >/dev/null 2>&1; then
        sh -c "$(sudo_cmd)yum install -y git"
    elif command -v pacman >/dev/null 2>&1; then
        sh -c "$(sudo_cmd)pacman -Sy --noconfirm git"
    elif command -v apk >/dev/null 2>&1; then
        sh -c "$(sudo_cmd)apk add git"
    elif command -v zypper >/dev/null 2>&1; then
        sh -c "$(sudo_cmd)zypper install -y git"
    elif command -v pkg >/dev/null 2>&1; then
        pkg install -y git
    else
        return 1
    fi
}

if ! command -v git >/dev/null 2>&1; then
    if ask_yes "Install git"; then
        install_git || {
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
    git -C "$target" fetch origin main
    git -C "$target" checkout main
    git -C "$target" pull --ff-only origin main
else
    git clone "$repo" "$target"
fi

cd "$target"
bun install --production
bun link

if [ "${DISCODE_SETUP:-1}" != "0" ]; then
    if [ -r /dev/tty ]; then
        bun bin/discode.mjs setup < /dev/tty
    else
        echo "Interactive setup needs a terminal. Re-run this installer from a shell, or run: $target/bin/discode.mjs setup"
        exit 1
    fi
fi
