# Sets up the food photo sync on this PC: a Python venv under %LOCALAPPDATA% and a
# scheduled task that runs sync.py every 15 minutes while you are signed in.
# Rerun it any time; it replaces what it made. -Uninstall removes the task.
#
#   powershell -ExecutionPolicy Bypass -File scripts\food-inbox\install.ps1
param([switch]$Uninstall, [string]$Since = '2026-01-01')
$ErrorActionPreference = 'Stop'

$task = 'Food photo inbox'
if ($Uninstall) {
	Unregister-ScheduledTask -TaskName $task -Confirm:$false
	return
}

# A worktree is deleted when its branch merges, and the task would go with it.
if ($PSScriptRoot -like '*\.claude\worktrees\*') { throw 'Run this from the main checkout, not a worktree.' }

$venv = Join-Path $env:LOCALAPPDATA 'food-inbox\venv'
if (-not (Test-Path "$venv\Scripts\pythonw.exe")) { py -3.13 -m venv $venv }
& "$venv\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check -r "$PSScriptRoot\requirements.txt"
if ($LASTEXITCODE) { throw 'pip install failed' }

$action = New-ScheduledTaskAction -Execute "$venv\Scripts\pythonw.exe" `
	-Argument "`"$PSScriptRoot\sync.py`" --since $Since" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15)
# The first run is long (the backlog); later ones finish in a second.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
	-ExecutionTimeLimit (New-TimeSpan -Hours 12) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Priority 8
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $task
"Installed. Log: $env:LOCALAPPDATA\food-inbox\sync.log"
