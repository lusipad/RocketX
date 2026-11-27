import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  Blocks,
  Camera,
  CheckCircle2,
  FileDown,
  FolderOpen,
  Info,
  Keyboard,
  LayoutGrid,
  Loader2,
  MessageSquare,
  Monitor,
  Moon,
  Palette,
  PanelLeft,
  Server,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  UsersRound,
  XCircle,
} from 'lucide-react';
import { getServerBase, isTauri, rest } from '../lib/client';
import type { RcCustomUserStatus } from '@rcx/rc-client';
import {
  isPresenceStatus,
  savePresencePreference,
  type PresenceStatus,
} from '../lib/presencePreference';
import {
  checkGithubUpdate,
  checkHttpUpdate,
  installedAppVersion,
  launchDirInstaller,
  loadUpdateSource,
  probeConfiguredSource,
  saveUpdateSource,
  type UpdateProbe,
  type UpdateSourceConfig,
  type UpdateSourceKind,
} from '../lib/updateSource';
import { loadTheme, saveTheme, type ThemeMode } from '../lib/theme';
import { notifyPermissionGranted, requestNotifyPermission } from '../lib/notify';
import { clearTaskbarFlash } from '../lib/taskbar';
import { applyDesktopUiScale } from '../lib/desktopUiScale';
import { UI_SCALE_OPTIONS, normalizeUiScale, type UiScale } from '../lib/uiScale';
import {
  autostartAvailable,
  readAutostartEnabled,
  updateAutostartEnabled,
} from '../lib/autostart';
import { exportDiagnostics } from '../lib/diagnostics';
import { saveTextFile } from '../lib/exportText';
import { loadWorkbenchConfig, loadWorkbenchConfigIssue, type WorkbenchConfig } from '../lib/ado';
import { canUseNtlm, type ProbeStep } from '../lib/adoDirect';
import { useAuth } from '../stores/auth';
import { usePrefs } from '../stores/prefs';
import {
  buildAliasExport,
  listArchivedAliases,
  parseAliasExport,
  useAliases,
  type ArchivedAliases,
} from '../stores/aliases';
import { useUiPrefs } from '../stores/uiPrefs';
import { useWorkbench } from '../stores/workbench';
import { useOnboarding } from '../stores/onboarding';
import { useUI } from '../stores/ui';
import { useWiTemplates } from '../stores/wiTemplates';
import { useGlobalShortcut } from '../stores/globalShortcut';
import { useChat } from '../stores/chat';
import {
  GLOBAL_SHORTCUT_OPTIONS,
  type GlobalShortcutValue,
} from '../lib/globalShortcut';
import { humanError, toast } from '../stores/toast';
import { relaunchDesktop } from '../platform/desktopProcess';
import Avatar from '../components/Avatar';
import { ConfirmDialog } from '../components/Dialog';
import LanguageSelector from '../components/LanguageSelector';
import { RadioGroup, Row, Slider, Toggle } from '../components/SettingControls';
import { WorkspaceConfigSection } from '../components/WorkspaceConfigImport';
import { useI18n, useT, type MessageKey } from '../i18n';
import { appManager, useInstalledApps } from '../kernel/installed';
import {
  parseManifestJson,
  type AppPermission,
  type RcxAppManifest,
} from '../kernel/manifest';
import { SENSITIVE_PERMISSIONS } from '../kernel/permission';
import { ensureHttpOrigin, httpFetch } from '../lib/http';
import { resetFirstRun } from '../lib/firstRun';
import { useNotificationAggregation } from '../stores/notificationAggregation';
import { attentionReduction } from '../lib/notificationAggregation';
import { currentLanPeers } from '../lan/runtime';
import { fmtSize } from '../lib/format';
import { getRuntimeMode, persistRuntimeMode, type RuntimeMode } from '../lib/runtimeMode';
import { roomArchiveSummaries, type AttachmentArchiveSettingsV1 } from '../lib/attachmentArchive';
import {
  ATTACHMENT_ARCHIVE_CHANGED,
  deleteRoomAttachmentArchive,
  enqueueAttachmentArchives,
  openRoomAttachmentArchive,
  readAttachmentArchiveSnapshot,
  saveAttachmentArchiveSettings,
} from '../lib/attachmentArchiveRuntime';

// 由 vite.config.ts 从 apps/desktop/package.json 注入，见那里的说明
declare const __APP_VERSION__: string;
const APP_VERSION = __APP_VERSION__;
const AiSettings = lazy(() => import('../components/AiSettings'));

type Section =
  | 'account'
  | 'workspace'
  | 'appearance'
  | 'sidebar'
  | 'message'
  | 'notification'
  | 'desktop'
  | 'shortcuts'
  | 'workbench'
  | 'ai'
  | 'apps'
  | 'about';

const SECTIONS: { key: Section; labelKey: MessageKey; icon: typeof Server }[] = [
  { key: 'account', labelKey: 'settings.sections.account', icon: Server },
  { key: 'workspace', labelKey: 'settings.sections.workspace', icon: UsersRound },
  { key: 'appearance', labelKey: 'settings.sections.appearance', icon: Palette },
  { key: 'sidebar', labelKey: 'settings.sections.sidebar', icon: PanelLeft },
  { key: 'message', labelKey: 'settings.sections.message', icon: MessageSquare },
  { key: 'notification', labelKey: 'settings.sections.notification', icon: Bell },
  { key: 'desktop', labelKey: 'settings.sections.desktop', icon: Monitor },
  { key: 'shortcuts', labelKey: 'settings.sections.shortcuts', icon: Keyboard },
  { key: 'workbench', labelKey: 'settings.sections.workbench', icon: LayoutGrid },
  { key: 'ai', labelKey: 'settings.sections.ai', icon: Sparkles },
  { key: 'apps', labelKey: 'settings.sections.apps', icon: Blocks },
  { key: 'about', labelKey: 'settings.sections.about', icon: Info },
];

const inputCls =
  'h-9 w-full max-w-md rounded-md border border-line px-3 text-sm outline-none transition focus:border-primary';

const STATUSES = [
  { key: 'online', labelKey: 'settings.account.status.online', color: 'bg-success' },
  { key: 'away', labelKey: 'settings.account.status.away', color: 'bg-warning' },
  { key: 'busy', labelKey: 'settings.account.status.busy', color: 'bg-danger' },
  { key: 'offline', labelKey: 'settings.account.status.offline', color: 'bg-ink-3' },
] as const;

type PasswordErrorState = { key: MessageKey } | { raw: string } | null;

/** 账号与在线状态 */
function AccountSection() {
  const t = useT();
  const user = useAuth((s) => s.user);
  const localMode = useAuth((s) => s.localMode);
  const exitLocalMode = useAuth((s) => s.exitLocalMode);
  const logout = useAuth((s) => s.logout);
  const refreshUser = useAuth((s) => s.refreshUser);
  const bumpAvatar = useAuth((s) => s.bumpAvatar);

  const [status, setStatus] = useState<PresenceStatus>(
    isPresenceStatus(user?.status) ? user.status : 'online',
  );
  const [statusText, setStatusText] = useState('');
  const [saved, setSaved] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [confirmSetup, setConfirmSetup] = useState(false);

  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);

  const [name, setName] = useState(user?.name ?? '');
  const [nameBusy, setNameBusy] = useState(false);

  /**
   * 自定义状态：只管理服务端的状态**列表**。
   *
   * 真机实测（RC 8.6）：`users.setStatus` 只接受 online/away/busy/offline 四种字面量，
   * 传自定义状态 id 直接 400；改走 `users.updateOwnBasicInfo.statusType` 时服务端不报错，
   * 但那个值最终进的是 presence 逻辑（`setUserStatusMethod` 按在线状态处理），
   * REST 会话下 `users.info` 的 status 不会变成自定义状态、statusText 也不落。
   * 也就是说**「把某个自定义状态挂到自己身上」是 DDP/presence 侧的能力，REST 做不到**。
   * 所以这里只做列表的增删改（这部分接口真实可用），不提供「应用到我」的假按钮。
   */
  const [statuses, setStatuses] = useState<RcCustomUserStatus[]>([]);
  const [newStatusName, setNewStatusName] = useState('');
  const [statusBusy, setStatusBusy] = useState(false);

  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<PasswordErrorState>(null);

  useEffect(() => setName(user?.name ?? ''), [user?.name]);

  // 自定义状态列表：只在打开设置页时拉一次
  useEffect(() => {
    if (localMode) return;
    let current = true;
    void rest
      .listCustomUserStatuses(100)
      .then((list) => {
        if (current) setStatuses(list);
      })
      .catch(() => {
        /* 取不到就不显示这一节，不影响其他设置 */
      });
    return () => {
      current = false;
    };
  }, []);

  /**
   * 昵称 / 简介一起提交。
   *
   * `users.updateOwnBasicInfo` 在服务端限流**每分钟 1 次**，所以刻意把两项合并成
   * 一次请求；每项单独保存会在第二次被 429 打回。
   */
  const [nickname, setNickname] = useState(user?.nickname ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [profileBusy, setProfileBusy] = useState(false);

  useEffect(() => {
    setNickname(user?.nickname ?? '');
    setBio(user?.bio ?? '');
  }, [user?.nickname, user?.bio]);

  const saveProfile = async (): Promise<void> => {
    setProfileBusy(true);
    try {
      await rest.updateOwnBasicInfo({ nickname, bio });
      await refreshUser();
      toast.success(t('settings.account.profileUpdated'));
    } catch (err) {
      toast.error(err, t('settings.account.profileUpdateFailed'));
    } finally {
      setProfileBusy(false);
    }
  };

  const removeStatus = async (id: string): Promise<void> => {
    setStatusBusy(true);
    try {
      await rest.deleteCustomUserStatus(id);
      setStatuses((prev) => prev.filter((item) => item._id !== id));
      toast.success(t('settings.account.customStatusDeleted'));
    } catch (err) {
      toast.error(err, t('settings.account.customStatusDeleteFailed'));
    } finally {
      setStatusBusy(false);
    }
  };

  const createStatus = async (): Promise<void> => {
    const name = newStatusName.trim();
    if (!name) return;
    setStatusBusy(true);
    try {
      const created = await rest.createCustomUserStatus(name);
      setStatuses((prev) => [...prev, created]);
      setNewStatusName('');
      toast.success(t('settings.account.customStatusCreated', { name }));
    } catch (err) {
      toast.error(err, t('settings.account.customStatusCreateFailed'));
    } finally {
      setStatusBusy(false);
    }
  };

  // 自动离开等外部变化直接写 auth store（applyLocalStatus），不经过本组件的 useState，
  // 状态只靠初始化读一次就会滞后高亮——订阅 user.status 同步进来。
  // 手动操作的乐观更新/失败回滚不受影响：applyStatus 先改本地，refreshUser 落地后这里再确认一遍。
  useEffect(() => {
    if (isPresenceStatus(user?.status)) setStatus(user.status);
  }, [user?.status]);

  const applyStatus = async (next: PresenceStatus, text?: string) => {
    const prev = status;
    setStatus(next);
    try {
      // 只传显式给的 text：切在线状态（按钮）时 text 为 undefined，rest 不发 message 字段，
      // 服务器保留原有状态消息；之前用 `text ?? statusText` 会把空输入框的 '' 发出去，
      // 无声清掉用户写的「开会中」（P1-14）。只有点文案保存按钮才带上 message。
      await rest.setStatus(next, text);
      if (user?._id) savePresencePreference(getServerBase(), user._id, next);
      await refreshUser();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setStatus(prev); // 失败回滚，不再假装成功
      toast.error(err, t('settings.account.statusUpdateFailed'));
    }
  };

  const uploadAvatar = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      const msg = t('settings.account.avatarSelectImage');
      toast.error(new Error(msg), msg);
      return;
    }
    setAvatarBusy(true);
    try {
      await rest.setAvatar(file, file.name);
      bumpAvatar();
      await refreshUser();
      toast.success(t('settings.account.avatarUpdated'));
    } catch (err) {
      toast.error(err, t('settings.account.avatarUploadFailed'));
    } finally {
      setAvatarBusy(false);
    }
  };

  const saveName = async () => {
    const next = name.trim();
    if (!next || next === user?.name) return;
    setNameBusy(true);
    try {
      await rest.updateOwnBasicInfo({ name: next });
      await refreshUser();
      toast.success(t('settings.account.nameUpdated'));
    } catch (err) {
      setName(user?.name ?? '');
      toast.error(err, t('settings.account.nameUpdateFailed'));
    } finally {
      setNameBusy(false);
    }
  };

  const changePassword = async () => {
    setPwError(null);
    if (newPw !== newPw2) {
      setPwError({ key: 'settings.account.passwordMismatch' });
      return;
    }
    setPwBusy(true);
    try {
      // 一次请求带齐所有字段：这个接口限流很紧（每分钟一次），拆成多次调用会被 429 挡掉
      await rest.updateOwnBasicInfo({ newPassword: newPw, currentPassword: curPw });
      setCurPw('');
      setNewPw('');
      setNewPw2('');
      toast.success(t('settings.account.passwordChanged'));
    } catch (err) {
      // 服务器的密码强度策略是可配置的，猜不出来 —— 原样透出它的说法
      const raw = err instanceof Error ? err.message : String(err ?? '');
      setPwError(
        /totp/i.test(raw)
          ? { key: 'settings.account.passwordIncorrect' }
          : /too many requests|rate/i.test(raw)
            ? { key: 'settings.account.passwordRateLimited' }
            : raw
              ? { raw }
              : { key: 'settings.account.passwordChangeFailed' },
      );
    } finally {
      setPwBusy(false);
    }
  };

  const pwErrorText = pwError ? ('raw' in pwError ? pwError.raw : t(pwError.key)) : null;

  return (
    <>
      {localMode ? (
        <Row
          label={t('settings.account.localModeLabel')}
          hint={t('settings.account.localModeHint')}
        >
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => void exitLocalMode()}
              className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-white transition hover:bg-primary-hover"
            >
              {t('settings.account.connectAccount')}
            </button>
          </div>
        </Row>
      ) : null}
      {localMode ? null : (<>
      <Row label={t('settings.account.currentAccountLabel')} hint={t('settings.account.currentAccountHint')}>
        <div className="flex items-center gap-3">
          <button
            onClick={() => avatarInputRef.current?.click()}
            disabled={avatarBusy}
            title={t('settings.account.changeAvatar')}
            className="group relative shrink-0 overflow-hidden rounded-[10px]"
          >
            <Avatar
              name={user?.name || user?.username || '?'}
              username={user?.username}
              size={44}
            />
            <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-white opacity-0 transition group-hover:opacity-100">
              {avatarBusy ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Camera size={16} />
              )}
            </span>
          </button>
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void uploadAvatar(f);
            }}
          />
          <div>
            <div className="text-sm font-medium text-ink">{user?.name || user?.username}</div>
            <div className="text-xs text-ink-3">@{user?.username}</div>
          </div>
        </div>
      </Row>

      <Row
        label={t('settings.account.displayNameLabel')}
        hint={t('settings.account.displayNameHint', { username: user?.username ?? '' })}
      >
        <div className="flex items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void saveName()}
            placeholder={user?.username}
            maxLength={80}
            className={inputCls}
          />
          <button
            onClick={() => void saveName()}
            disabled={nameBusy || !name.trim() || name.trim() === user?.name}
            className="h-9 shrink-0 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {nameBusy ? t('settings.account.saving') : t('common.save')}
          </button>
        </div>
      </Row>

      <Row label={t('settings.account.changePasswordLabel')} hint={t('settings.account.changePasswordHint')}>
        <div className="flex max-w-md flex-col gap-2">
          <input
            type="password"
            value={curPw}
            onChange={(e) => setCurPw(e.target.value)}
            placeholder={t('settings.account.currentPasswordPlaceholder')}
            autoComplete="current-password"
            className={inputCls}
          />
          <input
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            placeholder={t('settings.account.newPasswordPlaceholder')}
            autoComplete="new-password"
            className={inputCls}
          />
          <input
            type="password"
            value={newPw2}
            onChange={(e) => setNewPw2(e.target.value)}
            placeholder={t('settings.account.confirmPasswordPlaceholder')}
            autoComplete="new-password"
            className={inputCls}
          />
          {pwErrorText && <div className="text-xs text-danger">{pwErrorText}</div>}
          <button
            onClick={() => void changePassword()}
            disabled={pwBusy || !curPw || !newPw || !newPw2}
            className="h-9 w-28 rounded-md bg-primary text-sm text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pwBusy ? t('settings.account.changingPassword') : t('settings.account.changePasswordLabel')}
          </button>
        </div>
      </Row>

      <Row label={t('settings.account.onlineStatusLabel')} hint={t('settings.account.onlineStatusHint')}>
        <div className="flex flex-wrap gap-2">
          {STATUSES.map(({ key, labelKey, color }) => {
            const active = status === key;
            return (
              <button
                key={key}
                onClick={() => void applyStatus(key)}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                  active
                    ? 'border-primary bg-primary-light font-medium text-primary'
                    : 'border-line text-ink hover:bg-fill-hover'
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${color}`} />
                {t(labelKey)}
              </button>
            );
          })}
        </div>
      </Row>

      <Row label={t('settings.account.statusMessageLabel')} hint={t('settings.account.statusMessageHint')}>
        <div className="flex items-center gap-2">
          <input
            value={statusText}
            onChange={(e) => setStatusText(e.target.value)}
            placeholder={t('settings.account.statusMessagePlaceholder')}
            maxLength={120}
            className={inputCls}
          />
          <button
            onClick={() => void applyStatus(status, statusText)}
            className="h-9 shrink-0 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover"
          >
            {saved ? t('settings.common.saved') : t('common.save')}
          </button>
        </div>
      </Row>

      <Row label={t('settings.account.nicknameLabel')} hint={t('settings.account.nicknameHint')}>
        <input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder={t('settings.account.nicknamePlaceholder')}
          maxLength={60}
          className={inputCls}
        />
      </Row>

      <Row label={t('settings.account.bioLabel')} hint={t('settings.account.bioHint')}>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          placeholder={t('settings.account.bioPlaceholder')}
          maxLength={240}
          rows={3}
          className={`${inputCls} h-auto resize-none py-2`}
        />
      </Row>

      <Row
        label={t('settings.account.saveProfileLabel')}
        hint={t('settings.account.saveProfileHint')}
      >
        <button
          onClick={() => void saveProfile()}
          disabled={profileBusy}
          className="h-9 rounded-md bg-primary px-4 text-sm text-white transition hover:bg-primary-hover disabled:opacity-50"
        >
          {profileBusy ? t('settings.account.saving') : t('settings.account.saveProfileAction')}
        </button>
      </Row>

      <Row
        label={t('settings.account.customStatusesLabel')}
        hint={t('settings.account.customStatusesHint')}
      >
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {statuses.length === 0 && (
              <span className="text-xs text-ink-3">{t('settings.account.customStatusesEmpty')}</span>
            )}
            {statuses.map((item) => (
              <span key={item._id} className="inline-flex items-center">
                <span className="h-8 rounded-l-md border border-line px-3 text-xs leading-8 text-ink-2">
                  {item.name}
                  {item.statusType ? <span className="ml-1 text-ink-3">· {item.statusType}</span> : null}
                </span>
                <button
                  title={t('settings.account.deleteCustomStatus')}
                  disabled={statusBusy}
                  onClick={() => void removeStatus(item._id)}
                  className="h-8 rounded-r-md border border-l-0 border-line px-1.5 text-ink-3 transition hover:text-danger disabled:opacity-40"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              value={newStatusName}
              onChange={(e) => setNewStatusName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createStatus();
              }}
              placeholder={t('settings.account.newCustomStatusPlaceholder')}
              maxLength={60}
              className="h-8 flex-1 rounded-md border border-line bg-surface-4 px-2.5 text-xs outline-none focus:border-primary"
            />
            <button
              disabled={statusBusy || !newStatusName.trim()}
              onClick={() => void createStatus()}
              className="h-8 shrink-0 rounded-md border border-line px-3 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-40"
            >
              {t('common.add')}
            </button>
          </div>
        </div>
      </Row>

      <Row label={t('settings.account.serverUrlLabel')} hint={t('settings.account.serverUrlHint')}>
        <input readOnly value={getServerBase() || location.origin} className={`${inputCls} bg-fill-2 text-ink-2`} />
      </Row>

      <Row label={t('settings.account.logoutLabel')} hint={t('settings.account.logoutHint')}>
        <button
          onClick={() => setConfirmLogout(true)}
          className="h-9 rounded-md border border-danger px-4 text-sm text-danger transition hover:bg-danger/10"
        >
          {t('settings.account.logoutLabel')}
        </button>
      </Row>

      </>)}
      <Row label={t('settings.account.onboardingLabel')} hint={t('settings.account.onboardingHint')}>
        <button
          onClick={() => setConfirmSetup(true)}
          className="h-9 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover"
        >
          {t('settings.account.rerunOnboarding')}
        </button>
      </Row>

      {confirmLogout && (
        <ConfirmDialog
          title={t('settings.account.logoutLabel')}
          message={t('settings.account.logoutConfirmMessage')}
          confirmLabel={t('settings.account.logoutConfirmAction')}
          onConfirm={() => void logout()}
          onClose={() => setConfirmLogout(false)}
        />
      )}
      {confirmSetup && (
        <ConfirmDialog
          title={t('settings.account.rerunOnboarding')}
          message={t('settings.account.rerunOnboardingConfirmMessage')}
          confirmLabel={t('settings.account.rerunOnboardingConfirmAction')}
          onConfirm={() => {
            resetFirstRun();
            useUI.getState().setModule('messages');
            void logout();
          }}
          onClose={() => setConfirmSetup(false)}
        />
      )}
    </>
  );
}

const THEMES: { key: ThemeMode; labelKey: MessageKey; icon: typeof Sun; descKey: MessageKey }[] = [
  { key: 'light', labelKey: 'settings.appearance.theme.light', icon: Sun, descKey: 'settings.appearance.theme.lightDesc' },
  { key: 'dark', labelKey: 'settings.appearance.theme.dark', icon: Moon, descKey: 'settings.appearance.theme.darkDesc' },
  { key: 'system', labelKey: 'settings.appearance.theme.system', icon: Monitor, descKey: 'settings.appearance.theme.systemDesc' },
];

/** 外观：主题与语言 */
function AppearanceSection() {
  const t = useT();
  const [theme, setTheme] = useState<ThemeMode>(loadTheme);

  return (
    <>
      <Row label={t('settings.appearance.themeLabel')} hint={t('settings.appearance.themeHint')}>
        <div className="flex gap-3">
          {THEMES.map(({ key, labelKey, icon: Icon, descKey }) => {
            const active = theme === key;
            return (
              <button
                key={key}
                onClick={() => {
                  setTheme(key);
                  saveTheme(key);
                }}
                className={`flex w-32 flex-col items-center gap-2 rounded-2xl border-2 p-4 shadow-raise transition ${
                  active
                    ? 'border-primary bg-primary-light/80'
                    : 'border-line bg-surface-3 hover:border-line-strong hover:bg-fill-hover'
                }`}
              >
                <Icon size={22} className={active ? 'text-primary' : 'text-ink-2'} />
                <span className={`text-sm font-medium ${active ? 'text-primary' : 'text-ink'}`}>
                  {t(labelKey)}
                </span>
                <span className="text-xs text-ink-3">{t(descKey)}</span>
              </button>
            );
          })}
        </div>
      </Row>
      <Row label={t('locale.label')} hint={t('locale.hint')}>
        <LanguageSelector variant="cards" />
      </Row>
    </>
  );
}

/** Windows 桌面端本机快捷键，不跟随 Rocket.Chat 账号同步。 */
function ShortcutSection() {
  const t = useT();
  const config = useGlobalShortcut((state) => state.config);
  const status = useGlobalShortcut((state) => state.status);
  const error = useGlobalShortcut((state) => state.error);
  const setEnabled = useGlobalShortcut((state) => state.setEnabled);
  const setShortcut = useGlobalShortcut((state) => state.setShortcut);
  const windowsDesktop =
    isTauri && typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

  const statusText = !windowsDesktop
    ? t('settings.shortcuts.windowsOnly')
    : !config.enabled || status === 'disabled'
      ? t('settings.shortcuts.disabled')
      : status === 'registered'
        ? t('settings.shortcuts.registered')
        : status === 'conflict'
          ? t('settings.shortcuts.conflict')
          : t('settings.shortcuts.registering');

  return (
    <>
      <Row
        label={t('settings.shortcuts.commandCenterLabel')}
        hint={t('settings.shortcuts.commandCenterHint')}
        inline
      >
        <Toggle
          checked={windowsDesktop && config.enabled}
          disabled={!windowsDesktop}
          onChange={setEnabled}
        />
      </Row>
      <Row label={t('settings.shortcuts.systemShortcutLabel')} hint={t('settings.shortcuts.systemShortcutHint')}>
        <select
          value={config.shortcut}
          disabled={!windowsDesktop || !config.enabled}
          onChange={(event) => setShortcut(event.target.value as GlobalShortcutValue)}
          className={`${inputCls} disabled:cursor-not-allowed disabled:opacity-60`}
        >
          {GLOBAL_SHORTCUT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <div
          title={error ?? undefined}
          className={`mt-2 text-xs ${status === 'conflict' ? 'text-danger' : 'text-ink-3'}`}
        >
          {statusText}
        </div>
      </Row>
    </>
  );
}

/** 操作系统级桌面偏好，不跟随 Rocket.Chat 账号同步。 */
function DesktopSection() {
  const t = useT();
  const [mode, setMode] = useState<RuntimeMode>(getRuntimeMode);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(autostartAvailable);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [lanStatus, setLanStatus] = useState({ peers: 0, trusted: 0 });
  const [scaleChanging, setScaleChanging] = useState(false);
  const uiScale = useUiPrefs((s) => s.uiScale);
  const setUiScale = useUiPrefs((s) => s.setUiScale);

  useEffect(() => {
    if (!autostartAvailable) return;
    let active = true;
    void readAutostartEnabled()
      .then((value) => {
        if (active && value !== null) setEnabled(value);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const refresh = () => {
      const peers = currentLanPeers();
      setLanStatus({
        peers: peers.length,
        trusted: peers.filter((peer) => peer.trusted).length,
      });
    };
    refresh();
    const timer = setInterval(refresh, 3_000);
    return () => clearInterval(timer);
  }, []);

  const changeAutostart = async (next: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const actual = await updateAutostartEnabled(next);
      setEnabled(actual);
      if (actual !== next) throw new Error(t('settings.desktop.autostartNotSaved'));
      toast.success(
        next ? t('settings.desktop.autostartEnabledToast') : t('settings.desktop.autostartDisabledToast'),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      toast.error(err, t('settings.desktop.autostartFailed'));
    } finally {
      setLoading(false);
    }
  };

  const statusText = !isTauri
    ? t('settings.desktop.autostartDesktopOnly')
    : !autostartAvailable
      ? t('settings.desktop.autostartDebugHint')
    : loading
      ? t('settings.desktop.autostartLoading')
      : error
        ? t('settings.desktop.autostartError', { error })
        : enabled
          ? t('settings.desktop.autostartActive')
          : t('settings.desktop.autostartOff');

  const changeUiScale = async (value: `${UiScale}`) => {
    const next = normalizeUiScale(Number(value));
    setScaleChanging(true);
    try {
      await applyDesktopUiScale(next);
      setUiScale(next);
      toast.success(t('settings.desktop.uiScaleSet', { scale: next }));
    } catch (err) {
      toast.error(err, t('settings.desktop.uiScaleFailed'));
    } finally {
      setScaleChanging(false);
    }
  };

  const exportLogs = async () => {
    setExporting(true);
    try {
      const server = getServerBase();
      let serverOrigin = 'not_configured';
      try {
        if (server) serverOrigin = new URL(server).origin;
      } catch {
        serverOrigin = 'invalid';
      }
      const ado = loadWorkbenchConfig();
      const saved = await exportDiagnostics({
        appVersion: APP_VERSION,
        authStatus: useAuth.getState().status,
        chatConnection: useChat.getState().connection,
        serverOrigin,
        adoConfigured: Boolean(ado?.adoBase),
      });
      if (saved) toast.success(t('settings.desktop.diagnosticsExported'));
    } catch (err) {
      toast.error(err, t('settings.desktop.diagnosticsExportFailed'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <Row
        label={t('settings.desktop.runtimeModeLabel')}
        hint={t('settings.desktop.runtimeModeHint')}
      >
        <RadioGroup
          value={mode}
          onChange={(next) => {
            if (next === mode) return;
            setMode(next);
            persistRuntimeMode(next);
            window.location.reload();
          }}
          options={[
            {
              key: 'standard',
              label: t('settings.desktop.runtimeModeStandard'),
              hint: t('settings.desktop.runtimeModeStandardHint'),
            },
            {
              key: 'performance',
              label: t('settings.desktop.runtimeModePerformance'),
              hint: t('settings.desktop.runtimeModePerformanceHint'),
            },
          ]}
        />
      </Row>
      <Row
        label={t('settings.desktop.autostartLabel')}
        hint={t('settings.desktop.autostartHint')}
        inline
      >
        <div className="flex min-w-0 flex-col items-end gap-1.5">
          <Toggle
            checked={autostartAvailable && enabled}
            disabled={!autostartAvailable || loading}
            onChange={(next) => void changeAutostart(next)}
          />
          <div
            title={error ?? undefined}
            className={`max-w-md text-right text-xs ${error ? 'text-danger' : 'text-ink-3'}`}
          >
            {statusText}
          </div>
        </div>
      </Row>
      {isTauri && (
        <Row
          label={t('settings.desktop.uiScaleLabel')}
          hint={t('settings.desktop.uiScaleHint')}
        >
          <div role="radiogroup" aria-label={t('settings.desktop.uiScaleLabel')} className="flex flex-wrap gap-3">
            {UI_SCALE_OPTIONS.map((scale) => {
              const selected = scale === uiScale;
              return (
                <button
                  key={scale}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={scaleChanging}
                  onClick={() => void changeUiScale(String(scale) as `${UiScale}`)}
                  className={`min-w-24 rounded-lg border px-3 py-2.5 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    selected
                      ? 'border-primary/70 bg-primary-light/60 font-medium text-primary'
                      : 'border-line text-ink hover:border-ink-3 hover:bg-fill-hover'
                  }`}
                >
                  {scale}%
                </button>
              );
            })}
          </div>
        </Row>
      )}
      <Row
        label={t('settings.desktop.lanP2pLabel')}
        hint={t('settings.desktop.lanP2pHint')}
      >
        <div className="max-w-md text-sm text-ink-2">
          {!isTauri ? (
            t('settings.desktop.lanP2pWebOnly')
          ) : (
            <>
              <div>
                {t('settings.desktop.lanP2pPeers', {
                  peers: lanStatus.peers,
                  trusted: lanStatus.trusted,
                })}
              </div>
              <div className="mt-1 text-xs text-ink-3">{t('settings.desktop.lanP2pManualOnly')}</div>
            </>
          )}
        </div>
      </Row>
      <Row
        label={t('settings.desktop.exportLogsLabel')}
        hint={t('settings.desktop.exportLogsHint')}
        inline
      >
        <button
          type="button"
          disabled={!isTauri || exporting}
          onClick={() => void exportLogs()}
          className="flex h-9 items-center gap-2 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {exporting ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} />}
          {exporting ? t('settings.desktop.exportingLogs') : t('settings.desktop.exportLogsAction')}
        </button>
      </Row>
    </>
  );
}

type AliasFileResultState =
  | { kind: 'exported'; count: number }
  | { kind: 'invalid' }
  | { kind: 'imported'; added: number; skippedRooms: number }
  | null;

type ArchivedAliasResultState = { serverBase: string; added: number } | null;

/** 侧栏偏好（服务端同步，跨设备生效） */
function SidebarSection() {
  const { t, tp } = useI18n();
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);
  const nameFormat = useAliases((s) => s.nameFormat);
  const setNameFormat = useAliases((s) => s.setNameFormat);
  const importArchived = useAliases((s) => s.importArchived);
  const importAliases = useAliases((s) => s.importAliases);
  // 换过服务器地址（如 IP 变了）前的备注被账号隔离机制归档，提供找回入口
  const [archives, setArchives] = useState<ArchivedAliases[]>(() => listArchivedAliases());
  const [importResult, setImportResult] = useState<ArchivedAliasResultState>(null);
  const aliasFileRef = useRef<HTMLInputElement>(null);
  const [fileResult, setFileResult] = useState<AliasFileResultState>(null);
  // 导出只含人的备注（u: 键）；会话备注（r: 键）走账号同步，不进导出文件
  const userAliasCount = useAliases(
    (s) => Object.keys(s.aliases).filter((k) => k.startsWith('u:')).length,
  );

  const exportAliases = async () => {
    const text = buildAliasExport(useAliases.getState().aliases);
    const saved = await saveTextFile(text, `rcx-aliases-${new Date().toISOString().slice(0, 10)}.json`, {
      filterName: 'JSON',
      extension: 'json',
      mimeType: 'application/json',
    });
    if (saved) setFileResult({ kind: 'exported', count: userAliasCount });
  };

  const importAliasFile = async (file: File) => {
    const parsed = parseAliasExport(await file.text());
    if (!parsed) {
      setFileResult({ kind: 'invalid' });
      return;
    }
    const added = await importAliases(parsed.aliases);
    setFileResult({ kind: 'imported', added, skippedRooms: parsed.skippedRooms });
  };

  const fileResultText = fileResult
    ? fileResult.kind === 'exported'
      ? tp(
          fileResult.count,
          'settings.sidebar.aliasesExportedOne',
          'settings.sidebar.aliasesExportedOther',
          { count: fileResult.count },
        )
      : fileResult.kind === 'invalid'
        ? t('settings.sidebar.aliasesInvalidFile')
        : (() => {
            const skipped = fileResult.skippedRooms > 0
              ? tp(
                  fileResult.skippedRooms,
                  'settings.sidebar.aliasesSkippedRoomsOne',
                  'settings.sidebar.aliasesSkippedRoomsOther',
                  { count: fileResult.skippedRooms },
                )
              : '';
            return fileResult.added > 0
              ? tp(
                  fileResult.added,
                  'settings.sidebar.aliasesImportedOne',
                  'settings.sidebar.aliasesImportedOther',
                  { count: fileResult.added, skipped },
                )
              : t('settings.sidebar.aliasesNoneImported', { skipped });
          })()
    : null;

  const importResultText = importResult
    ? tp(
        importResult.added,
        'settings.sidebar.archivedAliasesImportedOne',
        'settings.sidebar.archivedAliasesImportedOther',
        { server: importResult.serverBase, count: importResult.added },
      )
    : null;

  return (
    <>
      <Row label={t('settings.sidebar.densityLabel')} hint={t('settings.sidebar.densityHint')}>
        <RadioGroup
          value={prefs.sidebarViewMode}
          onChange={(v) => void update({ sidebarViewMode: v })}
          options={[
            {
              key: 'extended',
              label: t('settings.sidebar.densityExtended'),
              hint: t('settings.sidebar.densityExtendedHint'),
            },
            {
              key: 'medium',
              label: t('settings.sidebar.densityMedium'),
              hint: t('settings.sidebar.densityMediumHint'),
            },
            {
              key: 'condensed',
              label: t('settings.sidebar.densityCondensed'),
              hint: t('settings.sidebar.densityCondensedHint'),
            },
          ]}
        />
      </Row>

      <Row label={t('settings.sidebar.sortByLabel')}>
        <RadioGroup
          value={prefs.sidebarSortby}
          onChange={(v) => void update({ sidebarSortby: v })}
          options={[
            { key: 'activity', label: t('settings.sidebar.sortByActivity') },
            { key: 'alphabetical', label: t('settings.sidebar.sortByAlphabetical') },
          ]}
        />
      </Row>

      <Row label={t('settings.sidebar.nameFormatLabel')} hint={t('settings.sidebar.nameFormatHint')}>
        <RadioGroup
          value={nameFormat}
          onChange={(v) => setNameFormat(v)}
          options={[
            { key: 'alias', label: t('settings.sidebar.nameFormatAlias') },
            { key: 'aliasWithReal', label: t('settings.sidebar.nameFormatAliasWithReal') },
          ]}
        />
      </Row>

      <Row label={t('settings.sidebar.aliasesImportExportLabel')} hint={t('settings.sidebar.aliasesImportExportHint')}>
        <div className="flex max-w-md flex-col gap-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => void exportAliases()}
              disabled={userAliasCount === 0}
              className="h-7 rounded-md border border-line px-3 text-xs text-primary transition hover:bg-fill-hover disabled:opacity-40"
            >
              {t('settings.sidebar.exportJson')}
            </button>
            <button
              onClick={() => aliasFileRef.current?.click()}
              className="h-7 rounded-md border border-line px-3 text-xs text-primary transition hover:bg-fill-hover"
            >
              {t('settings.sidebar.importFromFile')}
            </button>
            <input
              ref={aliasFileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importAliasFile(file);
                e.target.value = '';
              }}
            />
          </div>
          {fileResultText && <div className="text-xs text-ink-3">{fileResultText}</div>}
        </div>
      </Row>

      {/* importResult 留在条件里：导入成功后归档被消费、archives 清空，结果提示仍需可见 */}
      {(archives.length > 0 || importResultText) && (
        <Row label={t('settings.sidebar.archivedAliasesLabel')} hint={t('settings.sidebar.archivedAliasesHint')}>
          <div className="flex max-w-md flex-col gap-2">
            {archives.map((a) => (
              <div
                key={a.owner}
                className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2"
              >
                <span className="min-w-0 truncate text-sm text-ink-2">
                  {tp(
                    a.count,
                    'settings.sidebar.archivedAliasesItemOne',
                    'settings.sidebar.archivedAliasesItemOther',
                    { server: a.serverBase, count: a.count },
                  )}
                </span>
                <button
                  onClick={async () => {
                    const added = await importArchived(a.owner);
                    setImportResult({ serverBase: a.serverBase, added });
                    setArchives(listArchivedAliases());
                  }}
                  className="h-7 shrink-0 rounded-md border border-line px-3 text-xs text-primary transition hover:bg-fill-hover"
                >
                  {t('settings.sidebar.importAction')}
                </button>
              </div>
            ))}
            {importResultText && <div className="text-xs text-ink-3">{importResultText}</div>}
          </div>
        </Row>
      )}

      <Row label={t('settings.sidebar.groupByTypeLabel')} hint={t('settings.sidebar.groupByTypeHint')} inline>
        <Toggle
          checked={prefs.sidebarGroupByType}
          onChange={(v) => void update({ sidebarGroupByType: v })}
        />
      </Row>

      <Row label={t('settings.sidebar.showFavoritesLabel')} hint={t('settings.sidebar.showFavoritesHint')} inline>
        <Toggle
          checked={prefs.sidebarShowFavorites}
          onChange={(v) => void update({ sidebarShowFavorites: v })}
        />
      </Row>

      <Row label={t('settings.sidebar.showUnreadLabel')} hint={t('settings.sidebar.showUnreadHint')} inline>
        <Toggle
          checked={prefs.sidebarShowUnread}
          onChange={(v) => void update({ sidebarShowUnread: v })}
        />
      </Row>

      <Row label={t('settings.sidebar.displayAvatarLabel')} hint={t('settings.sidebar.displayAvatarHint')} inline>
        <Toggle
          checked={prefs.sidebarDisplayAvatar}
          onChange={(v) => void update({ sidebarDisplayAvatar: v })}
        />
      </Row>
    </>
  );
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function AttachmentArchiveSettings() {
  const { t, tp } = useI18n();
  const [snapshot, setSnapshot] = useState(readAttachmentArchiveSnapshot);
  const [deleteRid, setDeleteRid] = useState<string | null>(null);
  const rooms = roomArchiveSummaries(snapshot.archive);
  const totalBytes = snapshot.archive.records.reduce((sum, item) => sum + item.size, 0);

  useEffect(() => {
    const refresh = () => setSnapshot(readAttachmentArchiveSnapshot());
    window.addEventListener(ATTACHMENT_ARCHIVE_CHANGED, refresh);
    refresh();
    return () => window.removeEventListener(ATTACHMENT_ARCHIVE_CHANGED, refresh);
  }, []);

  const updateSettings = (patch: Partial<AttachmentArchiveSettingsV1>) => {
    const settings = { ...snapshot.settings, ...patch };
    saveAttachmentArchiveSettings(settings);
    setSnapshot((current) => ({ ...current, settings }));
    if (patch.enabled === true) {
      const chat = useChat.getState();
      for (const [rid, messages] of Object.entries(chat.messages)) {
        const roomName = chat.subscriptions[rid]?.fname || chat.subscriptions[rid]?.name ||
          chat.rooms[rid]?.fname || chat.rooms[rid]?.name || t('settings.message.archive.roomFallback');
        enqueueAttachmentArchives(messages, roomName);
      }
    }
  };

  return (
    <>
      <Row
        label={t('settings.message.archive.autoLabel')}
        hint={isTauri
          ? t('settings.message.archive.autoHintDesktop')
          : t('settings.message.archive.autoHintWeb')}
        inline
      >
        <Toggle
          checked={isTauri && snapshot.settings.enabled}
          disabled={!isTauri}
          onChange={(enabled) => updateSettings({ enabled })}
        />
      </Row>

      {isTauri && snapshot.settings.enabled && (
        <Row label={t('settings.message.archive.limitsLabel')} hint={t('settings.message.archive.limitsHint')}>
          <div className="grid max-w-2xl grid-cols-3 gap-3">
            <label className="text-xs text-ink-3">
              {t('settings.message.archive.maxFileLabel')}
              <select
                aria-label={t('settings.message.archive.maxFileAriaLabel')}
                value={snapshot.settings.maxFileBytes}
                onChange={(event) => updateSettings({ maxFileBytes: Number(event.target.value) })}
                className={`${inputCls} mt-1 max-w-none`}
              >
                {[10, 25, 50, 100].map((value) => (
                  <option key={value} value={value * MIB}>{value} MB</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-3">
              {t('settings.message.archive.maxTotalLabel')}
              <select
                aria-label={t('settings.message.archive.maxTotalAriaLabel')}
                value={snapshot.settings.maxTotalBytes}
                onChange={(event) => updateSettings({ maxTotalBytes: Number(event.target.value) })}
                className={`${inputCls} mt-1 max-w-none`}
              >
                {[1, 2, 5, 10].map((value) => (
                  <option key={value} value={value * GIB}>{value} GB</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-3">
              {t('settings.message.archive.retentionLabel')}
              <select
                aria-label={t('settings.message.archive.retentionAriaLabel')}
                value={snapshot.settings.retentionDays}
                onChange={(event) => updateSettings({ retentionDays: Number(event.target.value) })}
                className={`${inputCls} mt-1 max-w-none`}
              >
                {[7, 30, 90, 365].map((value) => (
                  <option key={value} value={value}>
                    {tp(value, 'settings.message.archive.daysOne', 'settings.message.archive.daysOther', { count: value })}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </Row>
      )}

      {isTauri && rooms.length > 0 && (
        <Row
          label={tp(
            snapshot.archive.records.length,
            'settings.message.archive.localFilesLabelOne',
            'settings.message.archive.localFilesLabelOther',
            { count: snapshot.archive.records.length, size: fmtSize(totalBytes) },
          )}
          hint={t('settings.message.archive.localFilesHint')}
        >
          <div className="max-w-2xl overflow-hidden rounded-lg border border-line">
            {rooms.map((room) => (
              <div key={room.rid} className="flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-ink">{room.roomName}</div>
                  <div className="text-xs text-ink-3">
                    {tp(
                      room.files,
                      'settings.message.archive.roomFilesOne',
                      'settings.message.archive.roomFilesOther',
                      { count: room.files, size: fmtSize(room.bytes) },
                    )}
                  </div>
                </div>
                <button
                  onClick={() => void openRoomAttachmentArchive(room.rid).catch((error) => toast.error(error, t('settings.message.archive.openDirFailed')))}
                  className="h-8 rounded-md border border-line px-3 text-xs text-ink-2 hover:bg-fill-hover"
                >
                  {t('settings.message.archive.openDir')}
                </button>
                <button
                  onClick={() => setDeleteRid(room.rid)}
                  className="h-8 rounded-md border border-danger px-3 text-xs text-danger hover:bg-danger/10"
                >
                  {t('settings.message.archive.deleteLocalCopies')}
                </button>
              </div>
            ))}
          </div>
        </Row>
      )}

      {deleteRid && (
        <ConfirmDialog
          title={t('settings.message.archive.deleteConfirmTitle')}
          message={t('settings.message.archive.deleteConfirmMessage')}
          confirmLabel={t('settings.message.archive.deleteLocalCopies')}
          onConfirm={() => void deleteRoomAttachmentArchive(deleteRid).catch((error) => toast.error(error, t('settings.message.archive.deleteFailed')))}
          onClose={() => setDeleteRid(null)}
        />
      )}
    </>
  );
}

/** 消息偏好 */
function MessageSection() {
  const t = useT();
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);
  const hoverDelayMs = useUiPrefs((s) => s.hoverDelayMs);
  const setHoverDelayMs = useUiPrefs((s) => s.setHoverDelayMs);

  return (
    <>
      <Row label={t('settings.message.hoverDelayLabel')} hint={t('settings.message.hoverDelayHint')}>
        <RadioGroup
          value={String(hoverDelayMs)}
          onChange={(v) => setHoverDelayMs(Number(v))}
          options={[
            { key: '500', label: t('settings.message.hoverDelay500') },
            { key: '1000', label: t('settings.message.hoverDelay1000') },
            { key: '2000', label: t('settings.message.hoverDelay2000') },
            { key: '3000', label: t('settings.message.hoverDelay3000') },
          ]}
        />
      </Row>

      <Row label={t('settings.message.sendModeLabel')} hint={t('settings.message.sendModeHint')}>
        <RadioGroup
          value={prefs.sendOnEnter}
          onChange={(v) => void update({ sendOnEnter: v })}
          options={[
            {
              key: 'normal',
              label: t('settings.message.sendModeNormal'),
              hint: t('settings.message.sendModeNormalHint'),
            },
            {
              key: 'alternative',
              label: t('settings.message.sendModeAlt'),
              hint: t('settings.message.sendModeAltHint'),
            },
          ]}
        />
      </Row>

      <Row
        label={t('settings.message.mixedSpaceLabel')}
        hint={t('settings.message.mixedSpaceHint')}
        inline
      >
        <Toggle
          checked={prefs.rcxAutoFormatMixedLanguage}
          onChange={(v) => void update({ rcxAutoFormatMixedLanguage: v })}
        />
      </Row>

      <Row label={t('settings.message.collapseLongLabel')} hint={t('settings.message.collapseLongHint')} inline>
        <Toggle
          checked={prefs.rcxCollapseLongMessages}
          onChange={(v) => void update({ rcxCollapseLongMessages: v })}
        />
      </Row>

      {prefs.rcxCollapseLongMessages && (
        <Row label={t('settings.message.foldAtLabel')} hint={t('settings.message.foldAtHint')}>
          <RadioGroup
            value={prefs.rcxLongMessageFoldAt}
            onChange={(v) => void update({ rcxLongMessageFoldAt: v })}
            options={[
              {
                key: 'half',
                label: t('settings.message.foldAtHalf'),
                hint: t('settings.message.foldAtHalfHint'),
              },
              { key: 'one', label: t('settings.message.foldAtOne') },
              { key: 'two', label: t('settings.message.foldAtTwo') },
            ]}
          />
        </Row>
      )}

      <Row label={t('settings.message.autoImageLoadLabel')} hint={t('settings.message.autoImageLoadHint')} inline>
        <Toggle
          checked={prefs.autoImageLoad}
          onChange={(v) => void update({ autoImageLoad: v })}
        />
      </Row>

      <AttachmentArchiveSettings />

      <Row label={t('settings.message.displayAvatarsLabel')} inline>
        <Toggle
          checked={prefs.displayAvatars}
          onChange={(v) => void update({ displayAvatars: v })}
        />
      </Row>

      <Row label={t('settings.message.useEmojisLabel')} hint={t('settings.message.useEmojisHint')} inline>
        <Toggle checked={prefs.useEmojis} onChange={(v) => void update({ useEmojis: v })} />
      </Row>

      <Row label={t('settings.message.threadsInMainLabel')} hint={t('settings.message.threadsInMainHint')} inline>
        <Toggle
          checked={prefs.showThreadsInMainChannel}
          onChange={(v) => void update({ showThreadsInMainChannel: v })}
        />
      </Row>
    </>
  );
}

/** 通知偏好 */
function NotificationSection() {
  const { t, tp } = useI18n();
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);
  const markChecklist = useOnboarding((s) => s.markChecklist);
  const taskbarFlash = useUiPrefs((s) => s.taskbarFlash);
  const setTaskbarFlash = useUiPrefs((s) => s.setTaskbarFlash);
  const userId = useAuth((s) => s.user?._id);
  const aggregationState = useNotificationAggregation((s) => s.state);
  const updateAggregation = useNotificationAggregation((s) => s.updateConfig);
  const beginMeasurement = useNotificationAggregation((s) => s.beginMeasurement);
  // granted / default(未开启,可申请)。桌面端无法区分 denied,统一按可申请处理
  const [permission, setPermission] = useState<'granted' | 'default'>('default');

  useEffect(() => {
    void notifyPermissionGranted().then((ok) => setPermission(ok ? 'granted' : 'default'));
  }, []);

  useEffect(() => {
    if (userId) useNotificationAggregation.getState().hydrate(userId);
  }, [userId]);

  const today = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  })();
  const reduction = aggregationState ? attentionReduction(aggregationState.metrics, today) : null;

  return (
    <>
      <Row label={t('settings.notification.systemPermLabel')} hint={t('settings.notification.systemPermHint')} inline>
        <div className="flex items-center gap-2">
          <span
            className={`rounded px-2 py-1 text-xs ${
              permission === 'granted' ? 'bg-success/15 text-success' : 'bg-fill-1 text-ink-2'
            }`}
          >
            {permission === 'granted' ? t('settings.notification.permGranted') : t('settings.notification.permOff')}
          </span>
          {permission === 'default' && (
            <button
              onClick={() =>
                void requestNotifyPermission().then((ok) => {
                  setPermission(ok ? 'granted' : 'default');
                  if (ok) markChecklist('notificationsEnabled');
                })
              }
              className="h-8 rounded-md bg-primary px-3 text-xs text-white hover:bg-primary-hover"
            >
              {t('settings.notification.enableAction')}
            </button>
          )}
          {permission === 'granted' && (
            <button
              onClick={() =>
                void update({
                  desktopNotifications: prefs.desktopNotifications === 'nothing' ? 'all' : 'nothing',
                })
              }
              className="h-8 rounded-md border border-line px-3 text-xs text-ink-2 hover:bg-fill-hover"
            >
              {prefs.desktopNotifications === 'nothing'
                ? t('settings.notification.enableDesktop')
                : t('settings.notification.disableDesktop')}
            </button>
          )}
        </div>
      </Row>

      <Row
        label={t('settings.notification.desktopNotifyLabel')}
        hint={t('settings.notification.desktopNotifyHint')}
      >
        <RadioGroup
          value={prefs.desktopNotifications}
          onChange={(v) => void update({ desktopNotifications: v })}
          options={[
            { key: 'all', label: t('settings.notification.desktopNotifyAll') },
            {
              key: 'mentions',
              label: t('settings.notification.desktopNotifyMentions'),
              hint: t('settings.notification.desktopNotifyMentionsHint'),
            },
            { key: 'nothing', label: t('settings.notification.desktopNotifyNothing') },
          ]}
        />
      </Row>

      {aggregationState && (
        <>
          <Row label={t('settings.notification.zenModeLabel')} hint={t('settings.notification.zenModeHint')} inline>
            <Toggle
              checked={aggregationState.config.enabled}
              onChange={(enabled) => updateAggregation({ enabled })}
            />
          </Row>
          <Row label={t('settings.notification.windowLabel')} hint={t('settings.notification.windowHint')}>
            <select
              value={aggregationState.config.windowMinutes}
              onChange={(event) => updateAggregation({ windowMinutes: Number(event.target.value) })}
              className="h-8 rounded-md border border-line bg-surface-4 px-2 text-sm text-ink outline-none"
            >
              {[1, 3, 5, 10, 15, 30].map((minutes) => (
                <option key={minutes} value={minutes}>
                  {tp(minutes, 'settings.notification.minutesOne', 'settings.notification.minutesOther', {
                    count: minutes,
                  })}
                </option>
              ))}
            </select>
          </Row>
          <Row label={t('settings.notification.urgentLabel')} hint={t('settings.notification.urgentHint')}>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-ink-2">
              {([
                ['directMentions', 'settings.notification.urgentDirectMentions'],
                ['directMessages', 'settings.notification.urgentDirectMessages'],
                ['broadcastMentions', 'settings.notification.urgentBroadcast'],
                ['priorityOne', 'settings.notification.urgentP1'],
              ] as const).map(([key, labelKey]) => (
                <label key={key} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={aggregationState.config.urgent[key]}
                    onChange={(event) => updateAggregation({ urgent: { [key]: event.target.checked } })}
                  />
                  {t(labelKey)}
                </label>
              ))}
            </div>
            <input
              value={aggregationState.config.urgent.keywords.join(t('settings.notification.keywordSeparator'))}
              onChange={(event) => updateAggregation({
                urgent: { keywords: event.target.value.split(/[;；]/) },
              })}
              placeholder={t('settings.notification.keywordsPlaceholder')}
              className="mt-2 h-8 w-full max-w-md rounded-md border border-line bg-surface-4 px-2 text-xs text-ink outline-none"
            />
          </Row>
          <Row label={t('settings.notification.measureLabel')} hint={t('settings.notification.measureHint')}>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => beginMeasurement('baseline', today)}
                className="h-8 rounded-md border border-line px-3 text-xs text-ink-2 hover:bg-fill-hover"
              >
                {t('settings.notification.startBaseline')}
              </button>
              <button
                onClick={() => beginMeasurement('dogfood', today)}
                className="h-8 rounded-md border border-line px-3 text-xs text-ink-2 hover:bg-fill-hover"
              >
                {t('settings.notification.startDogfood')}
              </button>
              <span className="text-xs text-ink-3">
                {reduction?.reductionRate == null
                  ? t('settings.notification.measureProgress', {
                      baselineDays: reduction?.baselineDays ?? 0,
                      dogfoodDays: reduction?.dogfoodDays ?? 0,
                    })
                  : reduction.eligible
                    ? t('settings.notification.measureResult', {
                        rate: Math.round(reduction.reductionRate * 100),
                      })
                    : t('settings.notification.measureResultPending', {
                        rate: Math.round(reduction.reductionRate * 100),
                      })}
              </span>
            </div>
          </Row>
        </>
      )}

      <Row label={t('settings.notification.soundVolumeLabel')}>
        <Slider
          value={prefs.notificationsSoundVolume ?? 100}
          onChange={(v) => void update({ notificationsSoundVolume: v })}
          suffix="%"
        />
      </Row>

      <Row label={t('settings.notification.muteFocusedLabel')} hint={t('settings.notification.muteFocusedHint')} inline>
        <Toggle
          checked={prefs.muteFocusedConversations}
          onChange={(v) => void update({ muteFocusedConversations: v })}
        />
      </Row>

      <Row label={t('settings.notification.taskbarFlashLabel')} hint={t('settings.notification.taskbarFlashHint')} inline>
        <Toggle
          checked={taskbarFlash}
          onChange={(enabled) => {
            setTaskbarFlash(enabled);
            if (!enabled) void clearTaskbarFlash();
          }}
        />
      </Row>

      <Row label={t('settings.notification.unreadAlertLabel')} hint={t('settings.notification.unreadAlertHint')} inline>
        <Toggle
          checked={prefs.unreadAlert}
          onChange={(v) => void update({ unreadAlert: v })}
        />
      </Row>

      <Row label={t('settings.notification.autoAwayLabel')} hint={t('settings.notification.autoAwayHint')} inline>
        <Toggle
          checked={prefs.enableAutoAway}
          onChange={(v) => void update({ enableAutoAway: v })}
        />
      </Row>

      {(prefs.enableAutoAway) && (
        <Row label={t('settings.notification.idleTimeLabel')}>
          <Slider
            value={Math.round((prefs.idleTimeLimit ?? 300) / 60)}
            onChange={(v) => void update({ idleTimeLimit: v * 60 })}
            min={1}
            max={60}
            suffix={t('settings.notification.minutesSuffix')}
          />
        </Row>
      )}
    </>
  );
}

const AUTH_LABEL_KEYS: Record<string, MessageKey> = {
  ntlm: 'settings.workbench.auth.ntlm',
  pat: 'settings.workbench.auth.pat',
  bearer: 'settings.workbench.auth.bearer',
  none: 'settings.workbench.auth.none',
};

/** 工作台（Azure DevOps） */
function WorkbenchSection() {
  const { t, tp } = useI18n();
  const authLabelText = (auth: string): string =>
    AUTH_LABEL_KEYS[auth] ? t(AUTH_LABEL_KEYS[auth]) : auth;
  const initialIssue = loadWorkbenchConfigIssue();
  const [config, setConfig] = useState<WorkbenchConfig>(
    () =>
      loadWorkbenchConfig() ?? {
        adoBase: '',
        pat: '',
        account: '',
      },
  );
  const setWorkbenchConfig = useWorkbench((s) => s.setConfig);
  const setOnboardingAdo = useOnboarding((s) => s.setAdo);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(
    initialIssue ? { ok: false, msg: initialIssue } : null,
  );
  const [steps, setSteps] = useState<ProbeStep[]>([]);
  const [saved, setSaved] = useState(false);
  // 其他设置项都是改完即存，只有这里是「填完再保存」（半截的地址存下去没意义），
  // 所以必须显式告诉用户「还没保存」，否则切走就白填了。
  const [dirty, setDirty] = useState(false);
  const usesInsecureAdoHttp = /^http:\/\//i.test(config.adoBase?.trim() ?? '')
    && config.auth !== 'none'
    && config.auth !== 'bearer';

  const update = (patch: Partial<WorkbenchConfig>) => {
    setConfig((c) => ({ ...c, ...patch }));
    setResult(null);
    setSteps([]);
    setSaved(false);
    setDirty(true);
  };

  // 有未保存改动时，关标签页/刷新前拦一下
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  /**
   * 直连模式：自动探测。用户填的地址可以是项目页地址、带或不带 /tfs，
   * 程序逐级向上找集合根，桌面端优先试 Windows 集成认证，再试 PAT / Bearer。
   */
  const test = async () => {
    setTesting(true);
    setResult(null);
    setSteps([]);
    try {
      if (!config.adoBase?.trim()) throw new Error(t('settings.workbench.adoBaseRequired'));
      const { probeAdo, directGetIdentity } = await import('../lib/adoDirect');
      const found: ProbeStep[] = [];
      const res = await probeAdo(config.adoBase.trim(), config.pat?.trim() ?? '', (s) => {
        found.push(s);
        setSteps([...found]);
      });
      if (res.found) {
        const { adoBase, auth } = res.found;
        let account = config.account.trim();
        let who = '';
        if (!account) {
          try {
            const id = await directGetIdentity({ adoBase, pat: config.pat ?? '', auth });
            account = id.account;
            who = id.displayName;
          } catch {
            /* 拿不到就算了，留空也能用（工作项查询会用 @Me 宏） */
          }
        }
        setConfig((c) => {
          const previousBase = c.adoBase?.trim().replace(/\/+$/, '').toLocaleLowerCase();
          const nextBase = adoBase.replace(/\/+$/, '').toLocaleLowerCase();
          return {
            ...c,
            adoBase,
            auth,
            account: account || c.account,
            allowInsecureAdoHttp: /^http:\/\//i.test(adoBase) && previousBase === nextBase
              ? c.allowInsecureAdoHttp
              : undefined,
          };
        });
        const authLabel =
          auth === 'ntlm'
            ? t('settings.workbench.authNtlmNoPat')
            : authLabelText(auth);
        const listSep = t('settings.common.listSeparator');
        setResult({
          ok: true,
          msg: t('settings.workbench.probeSuccess', {
            adoBase,
            authLabel,
            projectCount: res.found.projects.length,
            projects: res.found.projects.slice(0, 3).join(listSep),
            accountPart: account
              ? t('settings.workbench.probeDetectedAccount', { account: who || account })
              : '',
          }),
        });
      } else {
        const tried = [...new Set(found.map((s) => s.auth))];
        const triedLabel =
          tried.map((a) => authLabelText(a)).join(t('settings.common.listSeparator'))
          || t('settings.workbench.probeNoneTried');
        const hint = !canUseNtlm
          ? t('settings.workbench.probeHintNeedPat')
          : !config.pat?.trim()
            ? t('settings.workbench.probeHintNtlmRejected')
            : t('settings.workbench.probeHintPatFailed');
        setResult({
          ok: false,
          msg: t('settings.workbench.probeFailed', { tried: triedLabel, hint }),
        });
      }
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <Row
        label={t('settings.workbench.adoBaseLabel')}
        hint={
          isTauri
            ? t('settings.workbench.adoBaseHintDesktop')
            : t('settings.workbench.adoBaseHintWeb')
        }
      >
        <input
          value={config.adoBase ?? ''}
          onChange={(e) => update({
            adoBase: e.target.value,
            allowInsecureAdoHttp: undefined,
          })}
          placeholder={t('settings.workbench.adoBasePlaceholder')}
          className={inputCls}
        />
      </Row>
      <Row
        label={t('settings.workbench.patLabel')}
        hint={
          isTauri
            ? t('settings.workbench.patHintDesktop')
            : t('settings.workbench.patHintWeb')
        }
      >
        <input
          type="password"
          value={config.pat ?? ''}
          onChange={(e) => update({ pat: e.target.value })}
          placeholder={t('settings.workbench.patPlaceholder')}
          className={inputCls}
        />
      </Row>
      {config.auth && (
        <Row label={t('settings.workbench.authMethodLabel')} hint={t('settings.workbench.authMethodHint')}>
          <div className="text-sm text-ink-2">
            {config.auth === 'pat'
              ? t('settings.workbench.authMethodPatBasic')
              : config.auth === 'bearer'
                ? t('settings.workbench.authMethodBearer')
                : t('settings.workbench.authMethodNtlmFree')}
          </div>
        </Row>
      )}

      {usesInsecureAdoHttp && (
        <Row
          label={t('settings.workbench.allowInsecureHttpLabel')}
          hint={t('settings.workbench.allowInsecureHttpHint')}
          inline
        >
          <Toggle
            checked={config.allowInsecureAdoHttp === true}
            onChange={(value) => update({ allowInsecureAdoHttp: value || undefined })}
            label={t('settings.workbench.allowInsecureHttpToggle')}
          />
        </Row>
      )}

      <Row
        label={t('settings.workbench.accountLabel')}
        hint={t('settings.workbench.accountHint')}
      >
        <input
          value={config.account}
          onChange={(e) => update({ account: e.target.value })}
          placeholder={t('settings.workbench.accountPlaceholder')}
          className={inputCls}
        />
      </Row>

      <div className="flex items-center gap-2 pt-4">
        <button
          onClick={() => void test()}
          disabled={testing}
          className="flex h-9 items-center gap-2 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover disabled:opacity-50"
        >
          {testing && <Loader2 size={14} className="animate-spin" />}
          {t('settings.workbench.autoDetect')}
        </button>
        <button
          onClick={() => {
            // 走 store 而不是直接写 localStorage：工作台在监听它，保存后立刻重新拉数据
            setWorkbenchConfig({
              adoBase: config.adoBase?.trim().replace(/\/+$/, '') || undefined,
              pat: config.pat?.trim() || undefined,
              auth: config.auth,
              allowInsecureAdoHttp: usesInsecureAdoHttp && config.allowInsecureAdoHttp === true
                ? true
                : undefined,
              account: config.account.trim(),
            });
            setOnboardingAdo('configured');
            setSaved(true);
            setDirty(false);
            toast.success(t('settings.workbench.savedToast'));
            setTimeout(() => setSaved(false), 2500);
          }}
          // 账号不再是必填：Windows 集成认证下由服务器识别，工作项查询用 @Me 宏。
          // 真正的必填是「连到哪儿」——这里只要 ADO 地址。
          disabled={!config.adoBase?.trim()
            || (usesInsecureAdoHttp && config.allowInsecureAdoHttp !== true)}
          className={`h-9 rounded-md px-4 text-sm text-white transition disabled:opacity-40 ${
            dirty ? 'bg-primary hover:bg-primary-hover' : 'bg-primary/70 hover:bg-primary'
          }`}
        >
          {saved ? t('settings.common.saved') : t('common.save')}
        </button>
        {dirty && <span className="text-xs text-warning">{t('settings.workbench.unsavedChanges')}</span>}
      </div>

      {result && (
        <div
          className={`mt-3 flex max-w-2xl items-start gap-2 rounded-lg px-3 py-2.5 text-sm ${
            result.ok ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'
          }`}
        >
          {result.ok ? (
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          ) : (
            <XCircle size={16} className="mt-0.5 shrink-0" />
          )}
          <span className="leading-relaxed break-words">{result.msg}</span>
        </div>
      )}

      {/* 探测过程：每一步试了什么地址、什么认证、结果如何 */}
      <TemplateUrlSection />

      {steps.length > 0 && (
        <div className="mt-3 max-w-2xl overflow-hidden rounded-lg border border-line">
          <div className="border-b border-line bg-fill-2 px-3 py-2 text-xs font-medium text-ink-2">
            {tp(
              steps.length,
              'settings.workbench.probeLogTitleOne',
              'settings.workbench.probeLogTitleOther',
              { count: steps.length },
            )}
          </div>
          <div className="max-h-64 overflow-y-auto">
            {steps.map((s, i) => (
              <div
                key={i}
                className="flex items-start gap-2 border-b border-line px-3 py-2 text-xs last:border-b-0"
              >
                {s.ok ? (
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" />
                ) : (
                  <XCircle size={14} className="mt-0.5 shrink-0 text-ink-3" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs text-ink-2">{s.url}</div>
                  <div className={`mt-0.5 break-words ${s.ok ? 'text-success' : 'text-ink-3'}`}>
                    {/* 这里以前把 none（不带凭据）也写成「Windows 集成认证」，
                        看日志的人会以为试过集成认证了，其实压根没试 */}
                    {authLabelText(s.auth)}：{s.detail}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function TemplateUrlSection() {
  const { t, tp } = useI18n();
  const url = useWiTemplates((s) => s.url);
  const setUrl = useWiTemplates((s) => s.setUrl);
  const templates = useWiTemplates((s) => s.templates);
  const loading = useWiTemplates((s) => s.loading);
  const error = useWiTemplates((s) => s.error);
  const fetchTpl = useWiTemplates((s) => s.fetch);
  const [draft, setDraft] = useState(url);

  return (
    <div className="mt-6 max-w-2xl border-t border-line pt-4">
      <h3 className="text-sm font-semibold text-ink">{t('settings.workbench.templatesHeading')}</h3>
      <p className="mt-1 text-xs text-ink-3">
        {t('settings.workbench.templatesHint')}
      </p>
      <div className="mt-2 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('settings.workbench.templatesUrlPlaceholder')}
          className="h-8 flex-1 rounded-md border border-line bg-surface-4 px-3 text-sm text-ink outline-none focus:border-primary"
        />
        <button
          onClick={() => setUrl(draft.trim())}
          className="h-8 rounded-md bg-primary px-3 text-sm text-white transition hover:bg-primary-hover"
        >
          {t('common.save')}
        </button>
        {url && (
          <button
            onClick={() => void fetchTpl()}
            disabled={loading}
            className="h-8 rounded-md border border-line px-3 text-sm text-ink-2 transition hover:bg-fill-hover disabled:opacity-40"
          >
            {loading ? t('settings.workbench.templatesFetching') : t('settings.workbench.templatesRefetch')}
          </button>
        )}
      </div>
      {error && <div className="mt-1 text-xs text-danger">{error}</div>}
      <div className="mt-2 text-xs text-ink-3">
        {tp(
          templates.length,
          'settings.workbench.templatesCountOne',
          'settings.workbench.templatesCountOther',
          {
            count: templates.length,
            names: templates.map((item) => item.name).join(t('settings.common.listSeparator')),
          },
        )}
      </div>
    </div>
  );
}

const PERMISSION_LABEL_KEYS: Partial<Record<AppPermission, MessageKey>> = {
  'chat:read': 'settings.apps.perm.chatRead',
  'rooms:list': 'settings.apps.perm.roomsList',
  'users:read': 'settings.apps.perm.usersRead',
  'storage:local': 'settings.apps.perm.storageLocal',
  'ui:notify': 'settings.apps.perm.uiNotify',
  'app:info': 'settings.apps.perm.appInfo',
  'chat:write': 'settings.apps.perm.chatWrite',
  'chat:history': 'settings.apps.perm.chatHistory',
  'files:read': 'settings.apps.perm.filesRead',
  'files:write': 'settings.apps.perm.filesWrite',
  'net:fetch': 'settings.apps.perm.netFetch',
  'ai:invoke': 'settings.apps.perm.aiInvoke',
  'lan:discover': 'settings.apps.perm.lanDiscover',
  'agent:spawn': 'settings.apps.perm.agentSpawn',
  'process:spawn': 'settings.apps.perm.processSpawn',
  'native:service': 'settings.apps.perm.nativeService',
  'config:read': 'settings.apps.perm.configRead',
  'secrets:use': 'settings.apps.perm.secretsUse',
};

function AppPermissionPicker({
  manifest,
  selected,
  onChange,
}: {
  manifest: RcxAppManifest;
  selected: AppPermission[];
  onChange: (permissions: AppPermission[]) => void;
}) {
  const t = useT();
  const permissionLabel = (permission: AppPermission): string => {
    const key = PERMISSION_LABEL_KEYS[permission];
    return key ? t(key) : permission;
  };
  const sensitive = manifest.permissions.filter((permission) =>
    SENSITIVE_PERMISSIONS.includes(permission),
  );
  return (
    <div className="mt-3 rounded-md border border-line bg-surface-2 p-3">
      <div className="text-sm font-medium text-ink">
        {manifest.name} <span className="text-xs font-normal text-ink-3">v{manifest.version}</span>
      </div>
      <div className="mt-1 text-xs text-ink-3">
        {t('settings.apps.publisher', { publisher: manifest.publisher })}
      </div>
      {manifest.runtime === 'worker' && (
        <div className="mt-2 text-xs text-warning">
          {t('settings.apps.workerWarning')}
        </div>
      )}
      <div className="mt-3 text-xs font-medium text-ink-2">{t('settings.apps.basicPermissionsTitle')}</div>
      <div className="mt-1 text-xs text-ink-3">
        {manifest.permissions
          .filter((permission) => !SENSITIVE_PERMISSIONS.includes(permission))
          .map((permission) => permissionLabel(permission))
          .join(t('settings.common.listSeparator')) || t('settings.apps.noPermissions')}
      </div>
      {sensitive.length > 0 && (
        <>
          <div className="mt-3 text-xs font-medium text-ink-2">{t('settings.apps.sensitivePermissionsTitle')}</div>
          <div className="mt-1 flex flex-col gap-1.5">
            {sensitive.map((permission) => (
              <label key={permission} className="flex items-center gap-2 text-xs text-ink-2">
                <input
                  type="checkbox"
                  checked={selected.includes(permission)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...selected, permission]
                        : selected.filter((item) => item !== permission),
                    )
                  }
                />
                {permissionLabel(permission)}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function AppsSection() {
  const t = useT();
  const apps = useInstalledApps();
  const directoryInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<
    | { kind: 'directory'; manifest: RcxAppManifest; files: File[] }
    | { kind: 'url'; manifest: RcxAppManifest; url: string; hash: string }
    | null
  >(null);
  const [sensitiveGrants, setSensitiveGrants] = useState<AppPermission[]>([]);
  const [manifestUrl, setManifestUrl] = useState('');
  const [expectedHash, setExpectedHash] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [editingPermissions, setEditingPermissions] = useState<string | null>(null);
  const [editedGrants, setEditedGrants] = useState<AppPermission[]>([]);

  useEffect(() => {
    directoryInput.current?.setAttribute('webkitdirectory', '');
  }, []);

  const chooseDirectory = async (files: File[]) => {
    const manifestFile = files.find((file) => /(^|\/)rcx\.app\.json$/i.test(file.webkitRelativePath || file.name));
    if (!manifestFile) {
      toast.error(t('settings.apps.missingManifest'));
      return;
    }
    try {
      setPending({ kind: 'directory', manifest: parseManifestJson(await manifestFile.text()), files });
      setSensitiveGrants([]);
    } catch (error) {
      toast.error(error, t('settings.apps.invalidManifest'));
    }
  };

  const inspectUrl = async () => {
    try {
      await ensureHttpOrigin(manifestUrl);
      const response = await httpFetch(new URL(manifestUrl));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setPending({ kind: 'url', manifest: parseManifestJson(await response.text()), url: manifestUrl, hash: expectedHash });
      setSensitiveGrants([]);
    } catch (error) {
      toast.error(error, t('settings.apps.fetchManifestFailed'));
    }
  };

  const install = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const app = pending.kind === 'directory'
        ? await appManager().installDirectory(pending.files, { sensitiveGrants })
        : await appManager().installUrl(pending.url, pending.hash, { sensitiveGrants });
      toast.success(t('settings.apps.installedToast', { name: app.manifest.name }));
      setPending(null);
      setSensitiveGrants([]);
      if (directoryInput.current) directoryInput.current.value = '';
    } catch (error) {
      toast.error(error, t('settings.apps.installFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <section>
        <div className="text-sm font-medium text-ink">{t('settings.apps.installLocalHeading')}</div>
        <div className="mt-1 text-xs text-ink-3">
          {t('settings.apps.installLocalHint')}
        </div>
        <input
          ref={directoryInput}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => void chooseDirectory(Array.from(event.target.files ?? []))}
        />
        <button
          onClick={() => directoryInput.current?.click()}
          className="mt-2 inline-flex h-8 items-center gap-2 rounded-md border border-line px-3 text-xs text-ink hover:bg-fill-hover"
        >
          <FolderOpen size={14} /> {t('settings.apps.chooseDirectory')}
        </button>
      </section>

      <section>
        <div className="text-sm font-medium text-ink">{t('settings.apps.installUrlHeading')}</div>
        <div className="mt-1 text-xs text-ink-3">{t('settings.apps.installUrlHint')}</div>
        <input
          value={manifestUrl}
          onChange={(event) => setManifestUrl(event.target.value)}
          placeholder="https://example.com/rcx.app.json"
          className={`${inputCls} mt-2`}
        />
        <input
          value={expectedHash}
          onChange={(event) => setExpectedHash(event.target.value.trim())}
          placeholder={t('settings.apps.sha256Placeholder')}
          className={`${inputCls} mt-2 font-mono text-xs`}
        />
        <button
          onClick={() => void inspectUrl()}
          disabled={!manifestUrl || !/^[a-f0-9]{64}$/i.test(expectedHash)}
          className="mt-2 h-8 rounded-md border border-line px-3 text-xs text-ink hover:bg-fill-hover disabled:opacity-40"
        >
          {t('settings.apps.inspectManifest')}
        </button>
      </section>

      {pending && (
        <section>
          <AppPermissionPicker
            manifest={pending.manifest}
            selected={sensitiveGrants}
            onChange={setSensitiveGrants}
          />
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => void install()}
              disabled={busy}
              className="h-8 rounded-md bg-primary px-4 text-xs text-white disabled:opacity-50"
            >
              {busy ? t('settings.apps.installing') : t('settings.apps.installAction')}
            </button>
            <button onClick={() => setPending(null)} className="h-8 rounded-md border border-line px-4 text-xs">
              {t('common.cancel')}
            </button>
          </div>
        </section>
      )}

      <section>
        <div className="text-sm font-medium text-ink">{t('settings.apps.installedHeading')}</div>
        {apps.length === 0 ? (
          <div className="mt-2 text-xs text-ink-3">{t('settings.apps.noneInstalled')}</div>
        ) : (
          <div className="mt-2 divide-y divide-line rounded-md border border-line bg-surface-2">
            {apps.map((app) => {
              const bundled = app.source.kind === 'bundled';
              const sensitive = app.manifest.permissions.filter((permission) =>
                SENSITIVE_PERMISSIONS.includes(permission),
              );
              return (
                <div key={app.manifest.id} className="p-3">
                  <div className="flex items-center gap-3">
                    <Blocks size={16} className="text-primary" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-ink">
                        {app.manifest.name} · v{app.manifest.version}
                        {bundled && (
                          <span className="ml-2 text-xs text-primary">{t('settings.apps.bundledDefaultOff')}</span>
                        )}
                      </div>
                      <div className="truncate font-mono text-xs text-ink-3" title={app.bundleHash}>
                        SHA-256 {app.bundleHash}
                      </div>
                    </div>
                    {!bundled && sensitive.length > 0 && (
                      <button
                        title={t('settings.apps.permissionsAction')}
                        onClick={() => {
                          setEditingPermissions(editingPermissions === app.manifest.id ? null : app.manifest.id);
                          setEditedGrants(app.granted.filter((permission) => SENSITIVE_PERMISSIONS.includes(permission)));
                        }}
                        className="flex h-7 w-7 items-center justify-center rounded text-ink-3 hover:bg-fill-hover hover:text-primary"
                      >
                        <ShieldCheck size={14} />
                      </button>
                    )}
                    <Toggle
                      checked={app.enabled}
                      onChange={(enabled) => void appManager().setEnabled(app.manifest.id, enabled)}
                    />
                    {!bundled && (
                      <button
                        title={t('settings.apps.uninstallAction')}
                        onClick={() => setRemoving(app.manifest.id)}
                        className="flex h-7 w-7 items-center justify-center rounded text-ink-3 hover:bg-fill-hover hover:text-danger"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                  {editingPermissions === app.manifest.id && (
                    <div className="mt-3 border-t border-line pt-3">
                      <AppPermissionPicker
                        manifest={app.manifest}
                        selected={editedGrants}
                        onChange={setEditedGrants}
                      />
                      <button
                        onClick={() => {
                          void appManager()
                            .setSensitiveGrants(app.manifest.id, editedGrants)
                            .then(() => {
                              toast.success(t('settings.apps.permissionsUpdated'));
                              setEditingPermissions(null);
                            })
                            .catch((error) => toast.error(error, t('settings.apps.permissionsUpdateFailed')));
                        }}
                        className="mt-2 h-8 rounded-md bg-primary px-4 text-xs text-white"
                      >
                        {t('settings.apps.savePermissions')}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {removing && (
        <ConfirmDialog
          title={t('settings.apps.uninstallTitle')}
          message={t('settings.apps.uninstallConfirmMessage')}
          confirmLabel={t('settings.apps.uninstallAction')}
          danger
          onConfirm={() => {
            void appManager()
              .uninstall(removing)
              .then(() => toast.success(t('settings.apps.uninstalledToast')))
              .catch((error) => toast.error(error, t('settings.apps.uninstallFailed')));
            setRemoving(null);
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

const UPDATE_SOURCE_OPTIONS: { value: UpdateSourceKind; labelKey: MessageKey }[] = [
  { value: 'github', labelKey: 'settings.about.updateSource.github' },
  { value: 'http', labelKey: 'settings.about.updateSource.http' },
  { value: 'dir', labelKey: 'settings.about.updateSource.dir' },
];

type UpdateStatusState =
  | { kind: 'upToDate' }
  | { kind: 'upToDateSource'; version: string }
  | { kind: 'error'; message: string }
  | null;

/** 更新源配置 + 手动检查（issue #106）：内网/受限网络用 HTTP 源或共享目录替代 GitHub */
function UpdateSourceRow() {
  const t = useT();
  const [config, setConfig] = useState(() => loadUpdateSource());
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [status, setStatus] = useState<UpdateStatusState>(null);
  const [probe, setProbe] = useState<UpdateProbe | null>(null);

  function update(next: Partial<UpdateSourceConfig>): void {
    const merged = { ...config, ...next };
    setConfig(merged);
    saveUpdateSource(merged);
    setProbe(null);
    setStatus(null);
  }

  async function checkNow(): Promise<void> {
    setChecking(true);
    setStatus(null);
    setProbe(null);
    try {
      // 与启动检查同一判据：以运行时版本比较，构建期常量只作兜底（issue #376）
      const installed = await installedAppVersion(APP_VERSION);
      if (config.kind === 'github') {
        const found = await checkGithubUpdate(installed);
        if (found) {
          setProbe({ hasUpdate: true, version: found.version });
        }
        else setStatus({ kind: 'upToDate' });
      } else if (config.kind === 'http') {
        const found = await checkHttpUpdate(config.location, installed);
        if (found) {
          setProbe({ hasUpdate: true, version: found.version });
        } else {
          setStatus({ kind: 'upToDate' });
        }
      } else {
        const result = await probeConfiguredSource(config, installed);
        if (result.hasUpdate) setProbe(result);
        else setStatus({ kind: 'upToDateSource', version: result.version });
      }
    } catch (error) {
      setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setChecking(false);
    }
  }

  async function applyUpdate(): Promise<void> {
    if (!probe || updating) return;
    setUpdating(true);
    try {
      if (config.kind === 'github' || config.kind === 'http') {
        const installed = await installedAppVersion(APP_VERSION);
        const found = config.kind === 'github'
          ? await checkGithubUpdate(installed)
          : await checkHttpUpdate(config.location, installed);
        if (!found) return;
        const toastId = toast.loading(t('settings.about.downloadingUpdate', { version: found.version }));
        try {
          await found.downloadAndInstall();
          toast.update(toastId, { kind: 'success', message: t('settings.about.updateInstalledRestarting') });
          await relaunchDesktop();
        } catch (error) {
          toast.update(toastId, { kind: 'error', message: humanError(error, t('settings.about.updateFailed')) });
        }
      } else if (probe.installerPath) {
        if (!probe.sha256) throw new Error(t('settings.about.missingSha256'));
        if (!probe.installerType) throw new Error(t('settings.about.unknownInstallerType'));
        const toastId = toast.loading(t('settings.about.installingDirUpdate', { version: probe.version }));
        try {
          await launchDirInstaller({
            dir: config.location,
            path: probe.installerPath,
            signature: probe.signature,
            sha256: probe.sha256,
            expectedVersion: probe.version,
            installerType: probe.installerType,
          });
        } catch (error) {
          toast.update(toastId, { kind: 'error', message: String(error) });
        }
      }
    } catch (error) {
      toast.error(error, t('settings.about.updateFailed'));
    } finally {
      setUpdating(false);
    }
  }

  const statusText = status === null
    ? null
    : status.kind === 'upToDate'
      ? t('settings.about.upToDate')
      : status.kind === 'upToDateSource'
        ? t('settings.about.upToDateWithSource', { version: status.version })
        : status.message;

  return (
    <Row label={t('settings.about.updateLabel')} hint={t('settings.about.updateHint')}>
      <div className="flex flex-col gap-2">
        <select
          value={config.kind}
          onChange={(event) => update({ kind: event.target.value as UpdateSourceKind })}
          className="w-64 rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
        >
          {UPDATE_SOURCE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
          ))}
        </select>
        {config.kind !== 'github' && (
          <input
            value={config.location}
            onChange={(event) => update({ location: event.target.value })}
            placeholder={config.kind === 'http'
              ? t('settings.about.httpPlaceholder')
              : t('settings.about.dirPlaceholder')}
            className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-3"
          />
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={() => void checkNow()}
            disabled={checking || updating}
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-fill-hover disabled:opacity-50"
          >
            {checking ? t('settings.about.checkingUpdate') : t('settings.about.checkUpdate')}
          </button>
          {probe?.hasUpdate && (
            <button
              onClick={() => void applyUpdate()}
              disabled={updating}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
            >
              {updating
                ? t('settings.about.updating')
                : config.kind === 'github' || config.kind === 'http'
                ? t('settings.about.updateAndRestart', { version: probe.version })
                : probe.installerPath
                  ? t('settings.about.updateAndRestart', { version: probe.version })
                  : t('settings.about.downloadVersion', { version: probe.version })}
            </button>
          )}
          {statusText && <span className="text-xs text-ink-3">{statusText}</span>}
        </div>
      </div>
    </Row>
  );
}

type RcVersionState =
  | { state: 'loading' | 'unknown' | 'error' }
  | { state: 'ready'; value: string };

function AboutSection() {
  const t = useT();
  const localMode = useAuth((s) => s.localMode);
  const [rcVersion, setRcVersion] = useState<RcVersionState>({
    state: localMode ? 'unknown' : 'loading',
  });

  useEffect(() => {
    const base = getServerBase().trim();
    if (localMode || !base) {
      setRcVersion({ state: 'unknown' });
      return;
    }
    let active = true;
    setRcVersion({ state: 'loading' });
    void (async () => {
      try {
        const target = new URL(`${base}/api/info`);
        const res = await httpFetch(target);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json() as { version?: string; info?: { version?: string } };
        if (!active) return;
        const version = d.version ?? d.info?.version;
        setRcVersion(version ? { state: 'ready', value: version } : { state: 'unknown' });
      } catch {
        if (active) setRcVersion({ state: 'error' });
      }
    })();
    return () => {
      active = false;
    };
  }, [localMode]);

  const rcVersionText = rcVersion.state === 'ready'
    ? rcVersion.value
    : rcVersion.state === 'loading'
      ? t('settings.about.serverVersionQuerying')
      : rcVersion.state === 'unknown'
        ? t('settings.about.serverVersionUnknown')
        : t('settings.about.serverVersionUnavailable');

  return (
    <>
      <Row label={t('app.name')}>
        <div className="text-sm text-ink-2">
          {t('settings.about.appVersionLine', {
            version: APP_VERSION,
            platform: isTauri ? t('settings.about.platformDesktop') : t('settings.about.platformWeb'),
          })}
        </div>
        <div className="mt-1 text-xs text-ink-3">{t('settings.about.tagline')}</div>
      </Row>
      {isTauri && <UpdateSourceRow />}
      <Row label={t('settings.about.serverLabel')}>
        <div className="text-sm text-ink-2">
          {t('settings.about.serverVersionLine', {
            url: getServerBase() || location.origin,
            version: rcVersionText,
          })}
        </div>
      </Row>
      <Row label={t('settings.about.repoLabel')}>
        <a
          href="https://github.com/lusipad/RocketX"
          target="_blank"
          rel="noreferrer"
          className="text-sm text-primary hover:underline"
        >
          github.com/lusipad/RocketX
        </a>
      </Row>
    </>
  );
}

export default function SettingsPage({ initialSection = 'account' }: { initialSection?: Section }) {
  const t = useT();
  const [section, setSection] = useState<Section>(initialSection);
  const loaded = usePrefs((s) => s.loaded);
  const prefsError = usePrefs((s) => s.error);
  const loadPrefs = usePrefs((s) => s.load);
  const aiSettingsVisible = getRuntimeMode() !== 'performance';
  const visibleSections = useMemo(
    () => SECTIONS.filter((item) => aiSettingsVisible || item.key !== 'ai'),
    [aiSettingsVisible],
  );

  // 自己负责把偏好拉起来，不指望 MainPage 挂载时那一次。
  // load() 内部有「已加载就直接返回」和「同一时刻只发一个请求」的保护，重复调用不会多打请求。
  useEffect(() => {
    void loadPrefs();
  }, [loadPrefs]);

  useEffect(() => {
    if (visibleSections.some((item) => item.key === section)) return;
    setSection(visibleSections[0]?.key ?? 'account');
  }, [section, visibleSections]);

  const needsPrefs = ['sidebar', 'message', 'notification'].includes(section);

  const activeSectionMeta = visibleSections.find((s) => s.key === section);

  return (
    <div className="flex min-w-0 flex-1">
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-line bg-surface-2 p-3">
        <div className="px-2.5 py-2 text-base font-semibold text-ink">{t('settings.title')}</div>
        <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
          {visibleSections.map(({ key, labelKey, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setSection(key)}
              aria-current={section === key ? 'page' : undefined}
              className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition ${
                section === key
                  ? 'bg-surface-4 font-medium text-ink shadow-raise ring-1 ring-line/80'
                  : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
              }`}
            >
              <Icon size={16} className={section === key ? 'text-primary' : ''} />
              <span className="truncate">{t(labelKey)}</span>
            </button>
          ))}
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col bg-surface-3">
        <header className="rcx-glass-header flex h-14 shrink-0 items-center justify-between border-b border-line px-8">
          <div className="flex items-center gap-2.5">
            {activeSectionMeta && <activeSectionMeta.icon size={18} className="text-primary" />}
            <h1 className="text-base font-semibold text-ink">
              {activeSectionMeta ? t(activeSectionMeta.labelKey) : ''}
            </h1>
          </div>
          {needsPrefs && (
            <span className="rounded-full border border-line-soft bg-surface-2 px-3 py-1 text-xs text-ink-3">
              {t('settings.serverSyncedBadge')}
            </span>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
          <div className="mx-auto max-w-4xl">
            {needsPrefs && prefsError ? (
              // 拉失败要说人话并给重试，不能挂着「加载中…」装死
              <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface-4 py-12 text-center shadow-card">
                <XCircle size={22} className="text-danger" />
                <div className="max-w-sm text-sm break-words text-ink-2">{prefsError}</div>
                <button
                  onClick={() => void loadPrefs()}
                  className="h-8 rounded-xl border border-line bg-surface-3 px-4 text-sm text-ink shadow-raise transition hover:bg-fill-hover"
                >
                  {t('common.retry')}
                </button>
              </div>
            ) : needsPrefs && !loaded ? (
              <div className="flex items-center justify-center gap-2 rounded-2xl border border-line bg-surface-4 py-12 text-sm text-ink-3 shadow-card">
                <Loader2 size={14} className="animate-spin" />
                {t('settings.loadingPrefs')}
              </div>
            ) : section === 'ai' && aiSettingsVisible ? (
              <Suspense
                fallback={
                  <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface-4 px-6 py-10 text-sm text-ink-3 shadow-card">
                    <Loader2 size={14} className="animate-spin" />
                    {t('settings.loadingAi')}
                  </div>
                }
              >
                <AiSettings />
              </Suspense>
            ) : (
              <div className="rounded-2xl border border-line bg-surface-4 px-6 py-2 shadow-card">
                {section === 'account' && <AccountSection />}
                {section === 'workspace' && (
                  <WorkspaceConfigSection />
                )}
                {section === 'appearance' && <AppearanceSection />}
                {section === 'sidebar' && <SidebarSection />}
                {section === 'message' && <MessageSection />}
                {section === 'notification' && <NotificationSection />}
                {section === 'desktop' && <DesktopSection />}
                {section === 'shortcuts' && <ShortcutSection />}
                {section === 'workbench' && <WorkbenchSection />}
                {section === 'apps' && <AppsSection />}
                {section === 'about' && <AboutSection />}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
