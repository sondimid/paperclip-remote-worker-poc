#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$setup = Join-Path $PSScriptRoot '../setup-worker.ps1'
$revision = '7628f53bbcf896db1ebca6df9efa320718a85c5f'
$repository = 'https://github.com/sondimid/paperclip-remote-worker-poc.git'
$root = Join-Path ([IO.Path]::GetTempPath()) ('paperclip-setup-test-' + [Guid]::NewGuid().ToString('N'))
$bin = Join-Path $root 'fixture bin'
$log = Join-Path $root 'calls.jsonl'
$realNode = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$ps = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path -LiteralPath $ps)) { $ps = Join-Path $PSHOME 'pwsh.exe' }

function Assert-True([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}

function Invoke-Setup([string] $Destination, [string] $Pin, [string] $Scenario) {
    [IO.File]::WriteAllText($log, '')
    [IO.File]::WriteAllText((Join-Path $bin 'scenario.txt'), $Scenario)
    $oldPath = $env:PATH
    try {
        $env:PATH = "$bin;$oldPath"
        # PowerShell 5.1 turns redirected child stderr into NativeCommandError.
        $ErrorActionPreference = 'Continue'
        $output = & $ps -NoProfile -File $setup -Revision $Pin -Destination $Destination 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $env:PATH = $oldPath
    }
    [pscustomobject]@{
        Code = $exitCode
        Output = ($output -join "`n")
        Calls = @(Get-Content -LiteralPath $log | ForEach-Object { ConvertFrom-Json -InputObject $_ })
    }
}

# Fail as a test assertion before running shims if the entry point is missing.
Assert-True (Test-Path -LiteralPath $setup -PathType Leaf) 'RED: setup-worker.ps1 is missing.'

New-Item -ItemType Directory -Path $root | Out-Null
try {
    New-Item -ItemType Directory -Path $bin | Out-Null
    $fixture = Join-Path $bin 'fixture.cjs'
    @'
const fs = require('node:fs');
const path = require('node:path');
const [tool, ...args] = process.argv.slice(2);
const scenario = fs.readFileSync(path.join(__dirname, 'scenario.txt'), 'utf8');
const revision = '7628f53bbcf896db1ebca6df9efa320718a85c5f';
const cwd = process.cwd();
fs.appendFileSync(path.join(__dirname, '..', 'calls.jsonl'), JSON.stringify({ tool, args, cwd }) + '\n');
if (tool === 'node') {
    if (args.length !== 1 || !['--version', '-v'].includes(args[0])) process.exit(9);
    console.log(scenario === 'old-node' ? 'v20.0.0' : 'v22.1.0');
} else if (tool === 'git') {
    const commands = ['init', 'fetch', 'checkout', 'rev-parse'];
    const command = args.find(arg => commands.includes(arg));
    const target = args[0] === '-C' ? args[1] : cwd;
    if (command === 'fetch' && scenario === 'fetch-fail') process.exit(8);
    if (command === 'checkout') {
        const interactive = path.join(target, 'interactive');
        fs.mkdirSync(interactive);
        fs.writeFileSync(path.join(interactive, 'package-lock.json'), '{}');
    }
    if (command === 'rev-parse') console.log(scenario === 'wrong-revision' ? 'a'.repeat(40) : revision);
} else if (tool === 'npm' && scenario === 'install-fail') {
    process.exit(7);
}
'@ | Set-Content -LiteralPath $fixture -Encoding ASCII
    foreach ($tool in @('git', 'node', 'npm')) {
        $shim = Join-Path $bin ($tool + '.cmd')
        [IO.File]::WriteAllText($shim, "@`"$realNode`" `"$fixture`" $tool %*`r`n")
    }

    $existing = Join-Path $root 'existing'
    New-Item -ItemType Directory -Path $existing | Out-Null
    $sentinel = Join-Path $existing '.worker.cli.env'
    [IO.File]::WriteAllText($sentinel, 'fixture only')
    $result = Invoke-Setup $existing $revision 'ok'
    Assert-True ($result.Code -ne 0 -and [IO.File]::ReadAllText($sentinel) -ceq 'fixture only') 'ExistingTargetIsUnchanged: existing environment was not protected.'
    Assert-True (-not ($result.Calls | Where-Object { $_.tool -eq 'npm' -or $_.args -contains 'fetch' })) 'ExistingTargetIsUnchanged: did network/install work.'
    Write-Output 'PASS ExistingTargetIsUnchanged'

    $invalid = Join-Path $root 'invalid'
    $result = Invoke-Setup $invalid '--wrong-revision' 'ok'
    Assert-True ($result.Code -ne 0 -and -not (Test-Path -LiteralPath $invalid) -and $result.Calls.Count -eq 0) 'RejectInvalidOrMismatchedRevision: accepted invalid revision.'
    $wrong = Join-Path $root 'wrong'
    $result = Invoke-Setup $wrong $revision 'wrong-revision'
    Assert-True ($result.Code -ne 0 -and -not ($result.Calls | Where-Object tool -eq 'npm')) 'RejectInvalidOrMismatchedRevision: installed a different revision.'
    Write-Output 'PASS RejectInvalidOrMismatchedRevision'

    foreach ($scenario in @('old-node', 'fetch-fail', 'install-fail')) {
        $destination = Join-Path $root $scenario
        $result = Invoke-Setup $destination $revision $scenario
        Assert-True ($result.Code -ne 0 -and $result.Output -notmatch 'Setup complete') "FailedPrerequisitesOrInstallStopSetup: $scenario reported success."
        if ($scenario -eq 'old-node') {
            Assert-True (-not (Test-Path -LiteralPath $destination) -and -not ($result.Calls | Where-Object tool -eq 'git')) 'Old Node touched the destination or Git.'
        } elseif ($scenario -eq 'fetch-fail') {
            Assert-True (-not ($result.Calls | Where-Object { $_.tool -eq 'npm' -or $_.args -contains 'checkout' })) 'Fetch failure did not stop checkout/install.'
        }
    }
    Write-Output 'PASS FailedPrerequisitesOrInstallStopSetup'

    $fresh = Join-Path $root 'new worker [1]'
    $result = Invoke-Setup $fresh $revision 'ok'
    Assert-True ($result.Code -eq 0) "PinnedInstallDoesNotStartWorker: setup failed: $($result.Output)"
    $fetch = @($result.Calls | Where-Object { $_.tool -eq 'git' -and $_.args -contains 'fetch' })
    $checkout = @($result.Calls | Where-Object { $_.tool -eq 'git' -and $_.args -contains 'checkout' })
    $npm = @($result.Calls | Where-Object tool -eq 'npm')
    $node = @($result.Calls | Where-Object tool -eq 'node')
    Assert-True ($fetch.Count -eq 1 -and $fetch[0].args -contains $revision -and $fetch[0].args -contains $repository) 'Did not fetch the exact repository and revision.'
    Assert-True ($checkout.Count -eq 1 -and $checkout[0].args -contains '--detach') 'Checkout was not detached.'
    Assert-True ($npm.Count -eq 1 -and ($npm[0].args -join ' ') -ceq 'ci --ignore-scripts' -and $npm[0].cwd -eq (Join-Path $fresh 'interactive')) 'npm did not run in interactive/ with the pinned install flags.'
    Assert-True ($node.Count -eq 1 -and $node[0].args[0] -eq '--version') 'Setup used Node beyond the version check.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $fresh 'interactive/.worker.cli.env'))) 'Setup created a worker env file.'
    Write-Output 'PASS PinnedInstallDoesNotStartWorker'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force
}
