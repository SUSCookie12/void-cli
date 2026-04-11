# install.ps1 - Void CLI Windows Installer
# Usage: iwr "https://raw.githubusercontent.com/SUSCookie12/void-cli/main/dist_scripts/install.ps1" -useb | iex

$repo = "SUSCookie12/void-cli"
$installDir = "$HOME\.void"
$binName = "voidmc.exe"
$versionTag = "v0.1.3"
$urlPinned = "https://github.com/$repo/releases/download/$versionTag/$binName"
$urlLatest = "https://github.com/$repo/releases/latest/download/$binName"

Write-Host "🌑 Initializing Void CLI Installation..." -ForegroundColor Cyan

if (!(Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir | Out-Null
}

Write-Host "Downloading Void CLI from GitHub..." -ForegroundColor Yellow
try {
    Invoke-WebRequest -Uri $urlPinned -OutFile "$installDir\$binName" -ErrorAction Stop
    Write-Host "Downloaded release $versionTag" -ForegroundColor Gray
} catch {
    Write-Host "Warning: Could not download $versionTag, trying latest release..." -ForegroundColor Gray
    try {
        Invoke-WebRequest -Uri $urlLatest -OutFile "$installDir\$binName" -ErrorAction Stop
    } catch {
        Write-Host "❌ Error: Could not download $binName. Create a GitHub Release with tag $versionTag (or publish latest) and attach $binName." -ForegroundColor Red
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
