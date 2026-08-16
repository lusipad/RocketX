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
