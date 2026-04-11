# install.ps1 - Void CLI Windows Installer
# Usage: iwr https://raw.githubusercontent.com/OWNER/REPO/main/install.ps1 -useb | iex

$repo = "SUSCookie12/void-cli"
$installDir = "$HOME\.void"
$binName = "void.exe"
$url = "https://github.com/$repo/releases/latest/download/void-server-win.exe"

Write-Host "🌑 Initializing Void CLI Installation..." -ForegroundColor Cyan

if (!(Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir | Out-Null
}

# Download latest release
Write-Host "Downloading Void CLI from GitHub..." -ForegroundColor Yellow
Invoke-WebRequest -Uri $url -OutFile "$installDir\$binName"


Write-Host "✅ Binary installed to $installDir"

# Path setup
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -notlike "*$installDir*") {
    $newPath = "$currentPath;$installDir"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "✨ Added $installDir to User PATH" -ForegroundColor Yellow
}

Write-Host "🚀 Installation complete! Please restart your terminal." -ForegroundColor Green
