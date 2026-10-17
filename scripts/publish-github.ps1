<#
.SYNOPSIS
  校验 → 首次提交 → 创建 GitHub 仓库并推送。

.DESCRIPTION
  本脚本不保存任何凭据。需要先登录一次 GitHub（任选其一）：
    gh auth login                       # 装了 GitHub CLI 时最省事
    git config --global user.name  ...
    git config --global user.email ...
  并且 git 能推送（HTTPS 走凭据管理器 / SSH 走已配置的 key）。

.EXAMPLE
  pwsh -File scripts/publish-github.ps1 -Owner your-name -Repo dsh-qq-voice-chat

.EXAMPLE
  pwsh -File scripts/publish-github.ps1 -Owner your-name -Repo dsh-qq-voice-chat -Visibility private -SkipVerify
#>
param(
  [Parameter(Mandatory = $true)][string]$Owner,
  [string]$Repo = 'dsh-qq-voice-chat',
  [ValidateSet('public', 'private')][string]$Visibility = 'public',
  [string]$Branch = 'main',
  [string]$Message = 'chore: initial public release of dsh-qq-voice-chat',
  [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
Write-Host "repo root: $(Get-Location)" -ForegroundColor Cyan

# 1) 校验
if (-not $SkipVerify) {
  Write-Host '→ syntax check' -ForegroundColor Cyan
  node scripts/check-syntax.mjs
  if ($LASTEXITCODE -ne 0) { throw 'syntax check failed' }
  Write-Host '→ smoke test' -ForegroundColor Cyan
  node tests/smoke.mjs
  if ($LASTEXITCODE -ne 0) { throw 'smoke test failed' }
}

# 2) 身份（不代填，未设置就提示）
$name = (git config user.name) 2>$null
$email = (git config user.email) 2>$null
if (-not $name -or -not $email) {
  throw 'git identity missing. run: git config --global user.name "..." && git config --global user.email "..."'
}

# 3) 初始化
if (-not (Test-Path .git)) {
  git init -b $Branch | Out-Null
}
git add -A
if (git diff --cached --quiet) {
  Write-Host 'nothing to commit (already committed)' -ForegroundColor Yellow
} else {
  git commit -m $Message | Out-Null
}

# 4) 远端
$url = "https://github.com/$Owner/$Repo.git"
$existing = (git remote) 2>$null
if ($existing -contains 'origin') {
  git remote set-url origin $url
} else {
  git remote add origin $url
}

# 5) 建仓库（有 gh 才能自动建；没有就打印手动步骤）
$gh = Get-Command gh -ErrorAction SilentlyContinue
if ($gh) {
  git push -u origin $Branch
  gh repo create "$Owner/$Repo" "--$Visibility" --source . --remote origin --push 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'gh repo create failed (repo may already exist); trying push' -ForegroundColor Yellow
    git push -u origin $Branch
  }
} else {
  Write-Host ''
  Write-Host 'GitHub CLI (gh) 未安装。请手动建一个空仓库，然后：' -ForegroundColor Yellow
  Write-Host "  1. https://github.com/new  →  owner=$Owner  name=$Repo  (不要勾选 README/.gitignore/LICENSE)"
  Write-Host "  2. git push -u origin $Branch"
  Write-Host ''
  Write-Host "或者装 gh 后直接跑：gh repo create $Owner/$Repo --$Visibility --source . --remote origin --push"
  exit 1
}

Write-Host "done: https://github.com/$Owner/$Repo" -ForegroundColor Green
