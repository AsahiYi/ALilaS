$ErrorActionPreference = "Stop"

$RepoDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$TargetDir = Join-Path $env:USERPROFILE ".gemini\config\plugins\alilas"

Write-Host "==> Installing ALilaS into $TargetDir"
New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null

# Preserve user-local config/mode_a_patch.yml and custom mcp_config env overrides on upgrade
$SavedPatch = $null
$PatchDst = Join-Path $TargetDir "config\mode_a_patch.yml"
if (Test-Path $PatchDst) {
  $SavedPatch = [IO.File]::ReadAllText($PatchDst, [Text.UTF8Encoding]::new($false))
}

$SavedEnv = @{}
$McpDst = Join-Path $TargetDir "mcp_config.json"
if (Test-Path $McpDst) {
  try {
    $oldMcp = Get-Content -Raw -Encoding UTF8 $McpDst | ConvertFrom-Json
    $oldEnvObj = $oldMcp.mcpServers.alilas.env
    if ($oldEnvObj) {
      foreach ($p in $oldEnvObj.PSObject.Properties) {
        if ($p.Name -notin @("ALILAS_PLUGIN_ROOT", "ALILAS_DATA_DIR")) {
          $SavedEnv[$p.Name] = $p.Value
        }
      }
    }
  } catch {}
}

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

if ($null -ne $SavedPatch) {
  [IO.File]::WriteAllText($PatchDst, $SavedPatch, [Text.UTF8Encoding]::new($false))
}

if ($SavedEnv.Count -gt 0 -and (Test-Path $McpDst)) {
  try {
    $newMcp = Get-Content -Raw -Encoding UTF8 $McpDst | ConvertFrom-Json
    foreach ($k in $SavedEnv.Keys) {
      $newMcp.mcpServers.alilas.env | Add-Member -NotePropertyName $k -NotePropertyValue $SavedEnv[$k] -Force
    }
    [IO.File]::WriteAllText($McpDst, ($newMcp | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
  } catch {}
}

Write-Host "==> Installing server dependencies"
Push-Location (Join-Path $TargetDir "server")
try {
  npm install --no-audit --no-fund
} finally {
  Pop-Location
}

Write-Host "==> Building self-contained ALilaS UI"
node (Join-Path $TargetDir "ui\build.mjs")

$PatchExample = Join-Path $TargetDir "config\mode_a_patch.example.yml"
if (-not (Test-Path $PatchDst) -and (Test-Path $PatchExample)) {
  Write-Host "Tip: Copy config\mode_a_patch.example.yml to config\mode_a_patch.yml for custom DSH provider defaults."
}

Write-Host "==> Done! Launch ALilaS from Antigravity's '+' side pane menu or left sidebar."
