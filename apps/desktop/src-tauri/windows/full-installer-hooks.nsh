!macro NSIS_HOOK_POSTINSTALL
  RMDir /r "$LOCALAPPDATA\RocketX\resources.__staging"
  CreateDirectory "$LOCALAPPDATA\RocketX\resources.__staging"

  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /D /C xcopy /E /I /Y /Q "$INSTDIR\full-resources\ocr" "$LOCALAPPDATA\RocketX\resources.__staging\ocr"'
  Pop $0
  StrCmp $0 "0" full_ocr_staged
  RMDir /r "$LOCALAPPDATA\RocketX\resources.__staging"
  MessageBox MB_ICONSTOP "RocketX full 安装失败：无法写入 OCR 资源（xcopy 退出码 $0）；原有资源保持不变。"
  Abort

full_ocr_staged:
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /D /C xcopy /E /I /Y /Q "$INSTDIR\full-resources\codex" "$LOCALAPPDATA\RocketX\resources.__staging\codex"'
  Pop $0
  StrCmp $0 "0" full_codex_staged
  RMDir /r "$LOCALAPPDATA\RocketX\resources.__staging"
  MessageBox MB_ICONSTOP "RocketX full 安装失败：无法写入 Codex 资源（xcopy 退出码 $0）；原有资源保持不变。"
  Abort

full_codex_staged:
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /D /C xcopy /E /I /Y /Q "$INSTDIR\full-resources\node" "$LOCALAPPDATA\RocketX\resources.__staging\node"'
  Pop $0
  StrCmp $0 "0" full_node_staged
  RMDir /r "$LOCALAPPDATA\RocketX\resources.__staging"
  MessageBox MB_ICONSTOP "RocketX full 安装失败：无法写入 Node 资源（xcopy 退出码 $0）；原有资源保持不变。"
  Abort

full_node_staged:
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\full-resources\dsh-runtime.tar.gz" "$LOCALAPPDATA\RocketX\resources.__staging\dsh-runtime.tar.gz"
  IfErrors 0 full_dsh_staged
  RMDir /r "$LOCALAPPDATA\RocketX\resources.__staging"
  MessageBox MB_ICONSTOP "RocketX full 安装失败：无法写入 DSH 运行时归档；原有资源保持不变。"
  Abort

full_dsh_staged:
  RMDir /r "$LOCALAPPDATA\RocketX\resources.__old"
  IfFileExists "$LOCALAPPDATA\RocketX\resources\*.*" full_resources_has_current full_resources_without_current

full_resources_without_current:
  RMDir "$LOCALAPPDATA\RocketX\resources"
  ClearErrors
  Rename "$LOCALAPPDATA\RocketX\resources.__staging" "$LOCALAPPDATA\RocketX\resources"
  IfErrors full_resources_activate_failed full_resources_installed

full_resources_has_current:
  ClearErrors
  Rename "$LOCALAPPDATA\RocketX\resources" "$LOCALAPPDATA\RocketX\resources.__old"
  IfErrors full_resources_swap_failed 0
  ClearErrors
  Rename "$LOCALAPPDATA\RocketX\resources.__staging" "$LOCALAPPDATA\RocketX\resources"
  IfErrors full_resources_restore_old full_resources_installed

full_resources_restore_old:
  ClearErrors
  Rename "$LOCALAPPDATA\RocketX\resources.__old" "$LOCALAPPDATA\RocketX\resources"
  IfErrors full_resources_rollback_failed full_resources_activate_failed

full_resources_swap_failed:
  RMDir /r "$LOCALAPPDATA\RocketX\resources.__staging"
  MessageBox MB_ICONSTOP "RocketX full 安装失败：现有资源正在使用，无法开始升级；原有资源保持不变。"
  Abort

full_resources_activate_failed:
  RMDir /r "$LOCALAPPDATA\RocketX\resources.__staging"
  MessageBox MB_ICONSTOP "RocketX full 安装失败：无法启用新资源；原有资源已恢复。"
  Abort

full_resources_rollback_failed:
  MessageBox MB_ICONSTOP "RocketX full 安装失败，且无法恢复原有资源；请重新运行 full 安装包。"
  Abort

full_resources_installed:
  CreateDirectory "$LOCALAPPDATA\RocketX"
  Delete "$LOCALAPPDATA\RocketX\rocketx-package-profile.__staging"
  ClearErrors
  FileOpen $1 "$LOCALAPPDATA\RocketX\rocketx-package-profile.__staging" w
  IfErrors full_profile_open_failed
  FileWrite $1 "full"
  IfErrors full_profile_write_failed
  FileClose $1
  Delete "$LOCALAPPDATA\RocketX\rocketx-package-profile"
  ClearErrors
  Rename "$LOCALAPPDATA\RocketX\rocketx-package-profile.__staging" "$LOCALAPPDATA\RocketX\rocketx-package-profile"
  IfErrors full_profile_activate_failed full_profile_installed

full_profile_write_failed:
  FileClose $1

full_profile_open_failed:
  Delete "$LOCALAPPDATA\RocketX\rocketx-package-profile.__staging"
  Delete "$LOCALAPPDATA\RocketX\rocketx-package-profile"
  MessageBox MB_ICONEXCLAMATION "RocketX full 已安装，但无法记录安装包形态；下次启动将自动检测内置 AI 运行时。"
  Goto full_profile_installed

full_profile_activate_failed:
  Delete "$LOCALAPPDATA\RocketX\rocketx-package-profile.__staging"
  Delete "$LOCALAPPDATA\RocketX\rocketx-package-profile"
  MessageBox MB_ICONEXCLAMATION "RocketX full 已安装，但无法启用安装包形态标记；下次启动将自动检测内置 AI 运行时。"
  Goto full_profile_installed

full_profile_installed:
  RMDir /r "$LOCALAPPDATA\RocketX\resources.__old"
  RMDir /r "$INSTDIR\full-resources"
!macroend
