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
try {
    # Try latest first, then fallback to v0.1.0
    Invoke-WebRequest -Uri $url -OutFile "$installDir\$binName" -ErrorAction Stop
} catch {
    Write-Host "Warning: 'Latest' download failed, trying hardcoded v0.1.0 fallback..." -ForegroundColor Gray
    $fallbackUrl = "https://github.com/$repo/releases/download/v0.1.0/void-server-win.exe"
    try {
        Invoke-WebRequest -Uri $fallbackUrl -OutFile "$installDir\$binName" -ErrorAction Stop
    } catch {
        Write-Host "❌ Error: Could not find the file on GitHub. Please ensure you have a Release named 'v0.1.0' with 'void-server-win.exe' attached." -ForegroundColor Red
        return
    }
}

if (!(Test-Path "$installDir\$binName")) {
    Write-Host "❌ Error: Download failed or file was not saved." -ForegroundColor Red
    return
}

Write-Host "✅ Binary installed to $installDir"

# Path setup
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -notlike "*$installDir*") {
    $newPath = "$currentPath;$installDir"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "✨ Added $installDir to User PATH" -ForegroundColor Yellow
}

Write-Host "🚀 Installation complete! Please restart your terminal." -ForegroundColor Green
