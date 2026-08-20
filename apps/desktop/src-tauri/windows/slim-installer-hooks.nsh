; 卸载/安装前清扫仍从安装目录运行的进程。
;
; 上游 Tauri NSIS 模板的 CheckIfAppIsRunning 只按映像名查杀一次并等待 500ms：
; 进程退出慢、或 full 私有运行时（$INSTDIR\resources\node 下的 node.exe 等异名
; 进程）占用安装目录时，后续 Delete/Rename 会静默失败，外层安装器随即报
; unableToUninstall / 「现有资源正在使用」。这里先主动清扫并等待文件锁释放，
; 模板宏随后找不到进程便直接通过；任一环节失败仅记录日志，交给模板逻辑兜底。
; 注意：本宏在两个 hooks 文件中保持同步（slim-installer-hooks.nsh /
; full-installer-hooks.nsh），NSIS 的相对 !include 在 bundler 临时目录下不可靠，
; 因此不做公共 include。
!macro ROCKETX_SWEEP_INSTDIR_PROCESSES
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::KillProcessCurrentUser "rocketx.exe"
  !else
    nsis_tauri_utils::KillProcess "rocketx.exe"
  !endif
  Pop $R8
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = $'$INSTDIR$'.TrimEnd([char]92) + [char]92; $$end = (Get-Date).AddSeconds(10); do { $$p = @(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d, [System.StringComparison]::OrdinalIgnoreCase) }); $$p | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; if ($$p.Count -eq 0) { break }; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $$end)"'
  Pop $R8
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro ROCKETX_SWEEP_INSTDIR_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro ROCKETX_SWEEP_INSTDIR_PROCESSES
!macroend

!macro NSIS_HOOK_POSTINSTALL
  RMDir /r "$LOCALAPPDATA\RocketX\resources.__staging"
  RMDir /r "$LOCALAPPDATA\RocketX\resources.__old"
  RMDir /r "$LOCALAPPDATA\RocketX\resources"
  IfFileExists "$LOCALAPPDATA\RocketX\resources\*.*" slim_resources_cleanup_failed 0

  CreateDirectory "$LOCALAPPDATA\RocketX"
  Delete "$LOCALAPPDATA\RocketX\rocketx-package-profile.__staging"
  ClearErrors
  FileOpen $0 "$LOCALAPPDATA\RocketX\rocketx-package-profile.__staging" w
  IfErrors slim_profile_open_failed
  FileWrite $0 "slim"
  IfErrors slim_profile_write_failed
  FileClose $0
  Delete "$LOCALAPPDATA\RocketX\rocketx-package-profile"
  ClearErrors
  Rename "$LOCALAPPDATA\RocketX\rocketx-package-profile.__staging" "$LOCALAPPDATA\RocketX\rocketx-package-profile"
  IfErrors slim_profile_activate_failed slim_profile_installed

slim_resources_cleanup_failed:
  MessageBox MB_ICONSTOP "RocketX slim 安装失败：无法清理旧 full 运行时资源；请退出正在运行的 RocketX 后重试。"
  Abort

slim_profile_write_failed:
  FileClose $0

slim_profile_open_failed:
  Delete "$LOCALAPPDATA\RocketX\rocketx-package-profile.__staging"
  Delete "$LOCALAPPDATA\RocketX\rocketx-package-profile"
  MessageBox MB_ICONEXCLAMATION "RocketX slim 已安装，但无法记录安装包形态；下次启动将自动检测本机 AI 运行时。"
  Goto slim_profile_installed

slim_profile_activate_failed:
  Delete "$LOCALAPPDATA\RocketX\rocketx-package-profile.__staging"
  Delete "$LOCALAPPDATA\RocketX\rocketx-package-profile"
  MessageBox MB_ICONEXCLAMATION "RocketX slim 已安装，但无法启用安装包形态标记；下次启动将自动检测本机 AI 运行时。"
  Goto slim_profile_installed

slim_profile_installed:
!macroend
