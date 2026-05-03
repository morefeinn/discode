$ErrorActionPreference = "Stop"

$Repo = if ($env:DISCODE_REPO) { $env:DISCODE_REPO } else { "https://github.com/morefeinn/discode.git" }
$Target = if ($env:DISCODE_HOME) { $env:DISCODE_HOME } else { Join-Path $HOME "discode" }

function Write-Info($Message) {
    Write-Host "info  " -ForegroundColor Cyan -NoNewline
    Write-Host $Message
}

function Write-Ok($Message) {
    Write-Host "ok    " -ForegroundColor Green -NoNewline
    Write-Host $Message
}

function Write-Warn($Message) {
    Write-Host "warn  " -ForegroundColor Yellow -NoNewline
    Write-Host $Message
}

function Write-Fail($Message) {
    Write-Host "error " -ForegroundColor Red -NoNewline
    Write-Host $Message
}

function Write-Step($Message) {
    Write-Host ""
    Write-Host "== $Message" -ForegroundColor White
}

function Ensure-Command($Name, $InstallBlock, $HelpText) {
    if (Get-Command $Name -ErrorAction SilentlyContinue) {
        Write-Ok "$Name is available"
        return
    }

    Write-Info "Installing $Name..."
    & $InstallBlock

    $refreshPaths = @(
        "$HOME\.bun\bin",
        "$env:ProgramFiles\Git\cmd",
        "$env:LOCALAPPDATA\Programs\Git\cmd",
        "$env:LOCALAPPDATA\Microsoft\WinGet\Packages"
    )
    foreach ($p in $refreshPaths) {
        if ((Test-Path $p) -and -not $env:PATH.Contains($p)) {
            $env:PATH = "$p;$env:PATH"
        }
    }

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Write-Fail "Could not install $Name. $HelpText"
        throw "Missing dependency: $Name"
    }

    Write-Ok "$Name installed"
}

function Add-ToUserPath($Dir) {
    $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($currentPath -and $currentPath.Contains($Dir)) { return }

    $newPath = if ($currentPath) { "$Dir;$currentPath" } else { $Dir }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    if (-not $env:PATH.Contains($Dir)) {
        $env:PATH = "$Dir;$env:PATH"
    }
    Write-Ok "Added $Dir to user PATH"
}

Write-Host ""
Write-Host "+-- Discode Installer ----------+" -ForegroundColor Cyan
Write-Host "|  One-command setup             |" -ForegroundColor Cyan
Write-Host "+-------------------------------+" -ForegroundColor Cyan
Write-Host ""

Write-Step "Pre-flight checks"

$osInfo = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
Write-Info "Detected: $osInfo"

Write-Step "Installing dependencies"

Ensure-Command "git" {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements
    } else {
        Write-Info "winget not available — downloading Git installer"
        $gitUrl = "https://github.com/git-for-windows/git/releases/latest/download/Git-64-bit.exe"
        $gitInstaller = Join-Path $env:TEMP "git-installer.exe"
        Invoke-WebRequest -Uri $gitUrl -OutFile $gitInstaller -UseBasicParsing
        Start-Process -FilePath $gitInstaller -ArgumentList "/VERYSILENT /NORESTART" -Wait
        Remove-Item $gitInstaller -ErrorAction SilentlyContinue
    }

    foreach ($p in @("$env:ProgramFiles\Git\cmd", "$env:LOCALAPPDATA\Programs\Git\cmd")) {
        if (Test-Path $p) {
            $env:PATH = "$p;$env:PATH"
            Add-ToUserPath $p
        }
    }
} "Install Git from https://git-scm.com then re-run."

Ensure-Command "bun" {
    irm bun.sh/install.ps1 | iex

    $bunDir = "$HOME\.bun\bin"
    if (Test-Path $bunDir) {
        $env:PATH = "$bunDir;$env:PATH"
        Add-ToUserPath $bunDir
    }
} "Install Bun from https://bun.sh then re-run."

Write-Step "Cloning Discode"

if (Test-Path (Join-Path $Target ".git")) {
    Write-Info "Existing install found at $Target - updating"
    git -C $Target fetch origin main
    git -C $Target checkout main 2>$null
    git -C $Target pull --ff-only origin main
    Write-Ok "Updated to latest"
} else {
    git clone $Repo $Target
    Write-Ok "Cloned to $Target"
}

Write-Step "Installing packages"

Set-Location $Target
bun install --production
Write-Ok "Dependencies installed"

Write-Step "Linking CLI"

bun link 2>$null

$bunBin = "$HOME\.bun\bin"
if (Test-Path $bunBin) {
    Add-ToUserPath $bunBin
}

if (Get-Command discode -ErrorAction SilentlyContinue) {
    Write-Ok "discode CLI is available"
} else {
    Write-Warn "discode may not be in PATH yet."
    Write-Warn "Close and reopen your terminal after setup completes."
}

Write-Step "Running setup"

Write-Info "Configure your Discord bot, tokens, and provider accounts."
Write-Host ""

bun "$Target\bin\discode.mjs" setup

Write-Host ""
Write-Host "+-- Installation complete -------+" -ForegroundColor Green
Write-Host "|                                |" -ForegroundColor Green
Write-Host "|  Start Discode:                |" -ForegroundColor Green
Write-Host "|    discode start --background  |" -ForegroundColor Cyan
Write-Host "|                                |" -ForegroundColor Green
Write-Host "|  If command not found, reopen  |" -ForegroundColor Green
Write-Host "|  your terminal first.          |" -ForegroundColor Green
Write-Host "|                                |" -ForegroundColor Green
Write-Host "+-------------------------------+" -ForegroundColor Green
Write-Host ""
