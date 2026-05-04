#!/usr/bin/env sh
set -eu

repo="${DISCODE_REPO:-https://github.com/morefeinn/discode.git}"
target="${DISCODE_HOME:-$HOME/discode}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

info() {
    printf "${CYAN}info ${RESET} %s\n" "$1"
}

ok() {
    printf "${GREEN}ok   ${RESET} %s\n" "$1"
}

warn() {
    printf "${YELLOW}warn ${RESET} %s\n" "$1"
}

fail() {
    printf "${RED}error${RESET} %s\n" "$1"
}

step() {
    printf "\n${BOLD}-> %s${RESET}\n" "$1"
}

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
        printf "%s [Y/n]: " "$prompt" > /dev/tty
        read answer < /dev/tty
    else
        answer="y"
    fi

    case "$answer" in
        n|N|no|NO) return 1 ;;
        *) return 0 ;;
    esac
}

detect_shell_profile() {
    shell_name="$(basename "${SHELL:-sh}")"

    case "$shell_name" in
        zsh)
            if [ -f "$HOME/.zshrc" ]; then
                printf "%s/.zshrc" "$HOME"
            else
                printf "%s/.zprofile" "$HOME"
            fi
            ;;
        bash)
            if [ -f "$HOME/.bashrc" ]; then
                printf "%s/.bashrc" "$HOME"
            elif [ -f "$HOME/.bash_profile" ]; then
                printf "%s/.bash_profile" "$HOME"
            else
                printf "%s/.profile" "$HOME"
            fi
            ;;
        fish)
            printf "%s/.config/fish/config.fish" "$HOME"
            ;;
        *)
            printf "%s/.profile" "$HOME"
            ;;
    esac
}

add_to_path() {
    dir_to_add="$1"
    profile="$(detect_shell_profile)"
    shell_name="$(basename "${SHELL:-sh}")"

    if [ -f "$profile" ] && grep -q "$dir_to_add" "$profile" 2>/dev/null; then
        return 0
    fi

    mkdir -p "$(dirname "$profile")"

    if [ "$shell_name" = "fish" ]; then
        printf "\nfish_add_path %s\n" "$dir_to_add" >> "$profile"
    else
        printf "\nexport PATH=\"%s:\$PATH\"\n" "$dir_to_add" >> "$profile"
    fi

    ok "Added $dir_to_add to $profile"
}

reload_path() {
    if [ -d "$HOME/.bun/bin" ]; then
        export PATH="$HOME/.bun/bin:$PATH"
    fi
    if [ -d "/opt/homebrew/bin" ]; then
        export PATH="/opt/homebrew/bin:$PATH"
    fi
    if [ -d "/usr/local/bin" ]; then
        export PATH="/usr/local/bin:$PATH"
    fi
    hash -r 2>/dev/null || true
}

install_xcode_clt() {
    if xcode-select -p >/dev/null 2>&1; then
        ok "Xcode Command Line Tools already installed"
        return 0
    fi

    info "Installing Xcode Command Line Tools (required for git and build tools)"
    xcode-select --install 2>/dev/null || true

    info "Waiting for Xcode CLT installation to complete..."
    info "If a dialog appeared, click Install and wait for it to finish."

    timeout=600
    elapsed=0
    while ! xcode-select -p >/dev/null 2>&1; do
        sleep 5
        elapsed=$((elapsed + 5))
        if [ "$elapsed" -ge "$timeout" ]; then
            fail "Xcode CLT installation timed out after ${timeout}s"
            fail "Run 'xcode-select --install' manually, then re-run this installer."
            exit 1
        fi
    done

    ok "Xcode Command Line Tools installed"
}

install_homebrew() {
    if command -v brew >/dev/null 2>&1; then
        ok "Homebrew already installed"
        return 0
    fi

    info "Installing Homebrew (macOS package manager)"
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

    if [ -d "/opt/homebrew/bin" ]; then
        export PATH="/opt/homebrew/bin:$PATH"
        add_to_path "/opt/homebrew/bin"
    elif [ -d "/usr/local/bin" ]; then
        export PATH="/usr/local/bin:$PATH"
    fi

    if command -v brew >/dev/null 2>&1; then
        ok "Homebrew installed"
    else
        fail "Homebrew installation failed. Install it manually: https://brew.sh"
        exit 1
    fi
}

install_git() {
    if command -v git >/dev/null 2>&1; then
        ok "git $(git --version | sed 's/git version //')"
        return 0
    fi

    if [ "$(uname -s)" = "Darwin" ]; then
        install_xcode_clt
        reload_path
        if command -v git >/dev/null 2>&1; then
            ok "git installed via Xcode CLT"
            return 0
        fi
        install_homebrew
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
        fail "Could not install git automatically. Install git manually, then re-run."
        exit 1
    fi

    reload_path

    if command -v git >/dev/null 2>&1; then
        ok "git installed"
    else
        fail "git installation failed."
        exit 1
    fi
}

install_bun() {
    if command -v bun >/dev/null 2>&1; then
        ok "bun $(bun --version)"
        return 0
    fi

    info "Installing Bun runtime"
    curl -fsSL https://bun.sh/install | bash < /dev/null

    export PATH="$HOME/.bun/bin:$PATH"
    add_to_path "$HOME/.bun/bin"
    reload_path

    if command -v bun >/dev/null 2>&1; then
        ok "bun $(bun --version) installed"
    else
        fail "Bun installation failed. Install manually: https://bun.sh"
        exit 1
    fi
}

install_curl() {
    if command -v curl >/dev/null 2>&1; then
        return 0
    fi

    info "Installing curl"
    if command -v apt-get >/dev/null 2>&1; then
        sh -c "$(sudo_cmd)apt-get update && $(sudo_cmd)apt-get install -y curl"
    elif command -v dnf >/dev/null 2>&1; then
        sh -c "$(sudo_cmd)dnf install -y curl"
    elif command -v yum >/dev/null 2>&1; then
        sh -c "$(sudo_cmd)yum install -y curl"
    elif command -v pacman >/dev/null 2>&1; then
        sh -c "$(sudo_cmd)pacman -Sy --noconfirm curl"
    elif command -v apk >/dev/null 2>&1; then
        sh -c "$(sudo_cmd)apk add curl"
    else
        fail "curl is required. Install it manually, then re-run."
        exit 1
    fi
}

printf "\n"
printf "${BOLD}${CYAN}+-- Discode Installer ----------+${RESET}\n"
printf "${BOLD}${CYAN}|${RESET}  One-command setup             ${BOLD}${CYAN}|${RESET}\n"
printf "${BOLD}${CYAN}+-------------------------------+${RESET}\n"
printf "\n"

step "Pre-flight checks"

os_name="$(uname -s)"
arch="$(uname -m)"

if [ "$os_name" = "Darwin" ]; then
    if [ "$arch" = "arm64" ]; then
        info "Detected: macOS (Apple Silicon)"
    else
        info "Detected: macOS (Intel)"
    fi
elif [ "$os_name" = "Linux" ]; then
    info "Detected: Linux"
else
    info "Detected: $os_name"
fi

install_curl

step "Installing dependencies"

install_git
install_bun

reload_path

step "Cloning Discode"

if [ -d "$target/.git" ]; then
    info "Existing install found at $target — updating"
    git -C "$target" fetch -q origin main
    git -C "$target" checkout -q main 2>/dev/null || true
    git -C "$target" pull -q --ff-only origin main
    ok "Updated to latest"
else
    git clone -q "$repo" "$target"
    ok "Cloned to $target"
fi

step "Installing packages"

cd "$target"
bun install --production
ok "Dependencies installed"

step "Linking CLI"

bun link 2>/dev/null || true

if [ -d "$HOME/.bun/bin" ]; then
    add_to_path "$HOME/.bun/bin"
    export PATH="$HOME/.bun/bin:$PATH"
fi

reload_path

if command -v discode >/dev/null 2>&1; then
    ok "discode CLI is available"
else
    warn "discode may not be in PATH yet."
    warn "Run: export PATH=\"\$HOME/.bun/bin:\$PATH\""
    warn "Or open a new terminal after setup completes."
fi

step "Running setup"

info "Configure your Discord bot, tokens, and provider accounts."
printf "\n"

if [ -r /dev/tty ]; then
    exec < /dev/tty
fi
bun "$target/bin/discode.mjs" setup

printf "\n"
printf "${BOLD}${GREEN}+-- Installation complete -------+${RESET}\n"
printf "${GREEN}|${RESET}                                ${GREEN}|${RESET}\n"
printf "${GREEN}|${RESET}  Start Discode:                ${GREEN}|${RESET}\n"
printf "${GREEN}|${RESET}    ${CYAN}discode start --background${RESET}  ${GREEN}|${RESET}\n"
printf "${GREEN}|${RESET}                                ${GREEN}|${RESET}\n"
printf "${GREEN}|${RESET}  If command not found, run:    ${GREEN}|${RESET}\n"
printf "${GREEN}|${RESET}    ${DIM}source %s${RESET}\n" "$(detect_shell_profile)"
printf "${GREEN}|${RESET}  or open a new terminal.       ${GREEN}|${RESET}\n"
printf "${GREEN}|${RESET}                                ${GREEN}|${RESET}\n"
printf "${BOLD}${GREEN}+-------------------------------+${RESET}\n"
printf "\n"
