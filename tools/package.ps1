$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskExtension = Join-Path $taskRoot 'extension'
$taskOutput = Join-Path $taskRoot 'misheel-extension.zip'
if (-not (Test-Path -LiteralPath (Join-Path $taskExtension 'data/index.json'))) {
    throw 'Dictionary data is missing. Run tools/export_dictionary.py first.'
}
Compress-Archive -Path (Join-Path $taskExtension '*') -DestinationPath $taskOutput -Force
Write-Output "Created $taskOutput"
