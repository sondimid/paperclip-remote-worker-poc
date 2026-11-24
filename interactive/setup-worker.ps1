#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [ValidatePattern('\A[0-9a-fA-F]{40}\z')] [string] $Revision,
    [Parameter(Mandatory)] [string] $Destination
)

$ErrorActionPreference = 'Stop'
$repository = 'https://github.com/sondimid/paperclip-remote-worker-poc.git'
if ($Destination -notmatch '^[A-Za-z]:[\\/]') {
    throw 'Destination must be an absolute path on a Windows drive, for example C:\PaperclipWorker.'
}
$target = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $target) { throw 'Destination already exists. Choose a new directory.' }

$git = (Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$npm = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$nodeVersion = & $node --version
if ($LASTEXITCODE -ne 0 -or "$nodeVersion" -notmatch '^v(\d+)\.' -or [int] $Matches[1] -lt 22) {
    throw 'Node.js 22 or newer is required.'
}

# Do not use -Force: if another setup creates this directory, stop instead of reusing it.
New-Item -ItemType Directory -Path $target | Out-Null
try {
    & $git -C $target init --quiet --template=
    if ($LASTEXITCODE -ne 0) { throw 'Git init failed.' }
    & $git -C $target fetch --no-tags --depth=1 $repository $Revision
    if ($LASTEXITCODE -ne 0) { throw 'Git fetch failed.' }
    & $git -C $target checkout --quiet --detach FETCH_HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Git checkout failed.' }
    $checkout = & $git -C $target rev-parse --verify HEAD
    if ($LASTEXITCODE -ne 0 -or $checkout -ne $Revision) { throw 'Checked-out revision does not match the requested revision.' }

    $workerDir = Join-Path $target 'interactive'
    Push-Location -LiteralPath $workerDir
    try {
        & $npm ci --ignore-scripts
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    } finally {
        Pop-Location
    }
} catch {
    throw "Setup failed: $($_.Exception.Message) Files remain at '$target'. Inspect them and use a new destination to retry."
}

Write-Output "Setup complete: $workerDir"
Write-Output 'Next: place the privately supplied .worker.cli.env in that directory, verify the local CLI configuration, then start the worker manually.'
