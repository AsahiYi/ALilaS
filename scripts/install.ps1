$ErrorActionPreference = "Stop"

$RepoDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$TargetDir = Join-Path $env:USERPROFILE ".gemini\config\plugins\lilas"

Write-Host "==> Installing LilaS into $TargetDir"
New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null

$Items = @(
  "plugin.json", "mcp_config.json", "README.md", "README.zh-CN.md", "LICENSE",
  "assets", "config", "rules", "skills", "server", "ui"
)

foreach ($Item in $Items) {
  $Src = Join-Path $RepoDir $Item
  $Dst = Join-Path $TargetDir $Item
  if (Test-Path $Src) {
    if (Test-Path $Dst) { Remove-Item -Recurse -Force $Dst }
    Copy-Item -Recurse -Force $Src $Dst
  }
}

Write-Host "==> Installing server dependencies"
Push-Location (Join-Path $TargetDir "server")
try {
  npm install --no-audit --no-fund
} finally {
  Pop-Location
}

Write-Host "==> Building self-contained LilaS UI"
node (Join-Path $TargetDir "ui\build.mjs")

$PatchDst = Join-Path $TargetDir "config\mode_a_patch.yml"
$PatchExample = Join-Path $TargetDir "config\mode_a_patch.example.yml"
if (-not (Test-Path $PatchDst) -and (Test-Path $PatchExample)) {
  Write-Host "Tip: Copy config\mode_a_patch.example.yml to config\mode_a_patch.yml to configure custom provider/model overrides."
}

Write-Host "==> Done! Open Antigravity and launch LilaS from the '+' side pane menu or left sidebar."