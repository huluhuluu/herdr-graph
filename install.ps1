$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js 18+ is required. Install it and add node to PATH.'
    exit 1
}
& node (Join-Path $PSScriptRoot 'src/install.js') @args
exit $LASTEXITCODE
