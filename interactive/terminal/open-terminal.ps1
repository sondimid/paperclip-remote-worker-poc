param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$Workspace
)

try {
    Start-Process -FilePath $Executable -WorkingDirectory $Workspace -ErrorAction Stop
    exit 0
} catch {
    # Bao loi cho worker qua exit code; khong phat duong dan hay credential.
    exit 1
}
