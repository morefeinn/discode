$ErrorActionPreference = "Stop"

$Repo = if ($env:DISCODE_REPO) { $env:DISCODE_REPO } else { "https://github.com/morefeinn/discode.git" }
$Target = if ($env:DISCODE_HOME) { $env:DISCODE_HOME } else { Join-Path $HOME "discode" }

function Ask-Yes($Prompt) {
    if ($env:DISCODE_YES -eq "1") {
        return $true
    }

    $answer = Read-Host "$Prompt [y/N]"
    return @("y", "yes") -contains $answer.ToLowerInvariant()
}

function Ensure-Command($Name, $InstallScript, $HelpText) {
    if (Get-Command $Name -ErrorAction SilentlyContinue) {
        return
    }

    if (-not (Ask-Yes "Install $Name")) {
        throw "$Name is required. $HelpText"
    }

    Invoke-Expression $InstallScript
    if ($Name -eq "bun") {
        $env:PATH = "$HOME\.bun\bin;$env:PATH"
    } elseif ($Name -eq "git") {
        $env:PATH = "$env:ProgramFiles\Git\cmd;$env:PATH"
    }

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Could not install $Name. $HelpText"
    }
}

Ensure-Command "git" "winget install --id Git.Git -e --source winget" "Install Git, then run this installer again."
Ensure-Command "bun" "irm bun.sh/install.ps1 | iex" "Install Bun, then run this installer again."

if (Test-Path (Join-Path $Target ".git")) {
    git -C $Target fetch origin main
    git -C $Target checkout main
    git -C $Target pull --ff-only origin main
} else {
    git clone $Repo $Target
}

Set-Location $Target
bun install --production
bun link

if ($env:DISCODE_SETUP -ne "0") {
    bun .\bin\discode.mjs setup
}
