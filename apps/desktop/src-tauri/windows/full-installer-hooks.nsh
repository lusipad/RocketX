!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$LOCALAPPDATA\RocketX\resources"
  RMDir /r "$LOCALAPPDATA\RocketX\resources\codex"
  RMDir /r "$LOCALAPPDATA\RocketX\resources\ocr"

  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /D /C xcopy /E /I /Y /Q "$INSTDIR\full-resources\codex" "$LOCALAPPDATA\RocketX\resources\codex"'
  Pop $0
  StrCmp $0 "0" full_codex_copied
  MessageBox MB_ICONSTOP "RocketX full 安装失败：无法写入 Codex 资源（xcopy 退出码 $0）。"
  Abort

full_codex_copied:
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /D /C xcopy /E /I /Y /Q "$INSTDIR\full-resources\ocr" "$LOCALAPPDATA\RocketX\resources\ocr"'
  Pop $0
  StrCmp $0 "0" full_resources_copied
  MessageBox MB_ICONSTOP "RocketX full 安装失败：无法写入 OCR 资源（xcopy 退出码 $0）。"
  Abort

full_resources_copied:
  RMDir /r "$INSTDIR\full-resources"
!macroend
