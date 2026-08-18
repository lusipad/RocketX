import { rest } from './client';
import { isPresenceStatus } from './presencePreference';
import { useAuth } from '../stores/auth';
import { usePrefs } from '../stores/prefs';

/**
 * 自动离开（enableAutoAway / idleTimeLimit 的执行端）。
 *
 * 设置页此前只有开关和分钟数，没有任何消费方：这里监听用户活动，超过
 * idleTimeLimit 无操作就把在线状态置为 away，下一次活动再恢复 online。
 *
 * 与手动状态的边界（不和用户打架）：
 * - 只在当前状态是 online 时才自动置 away——用户手动 busy/away/offline 不动；
 * - 自动 away 期间用户手动改了状态，恢复逻辑失效（恢复前再确认本地状态仍是 away）；
 * - 自动 away/恢复都不写 presencePreference 的显式偏好——那是手动选择才写的，
 *   否则重启后 applyStartupPresence 会把「碰巧赶上自动 away」当成用户的选择复活。
 */

/** 防误设下限：接口或旧数据可能写进 0 / 负数，那样的「自动离开」一启动就触发 */
export const MIN_IDLE_SECONDS = 30;

/** 连续输入（鼠标滑动、滚动）每秒最多重置一次计时器 */
const ACTIVITY_THROTTLE_MS = 1000;

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

/**
 * 开始自动离开监听，返回清理函数（移除事件监听、计时器和偏好订阅）。
 * 挂载点：登录后的 MainPage；target 可注入，测试用 EventTarget。
 */
export function startAutoAway(target: EventTarget = window): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 这次 away 是本模块置的——只有这时后续活动才触发恢复 */
  let autoAway = false;
  let disposed = false;
  let lastArmAt = 0;
  let lastActivityAt = Date.now();
  /** 置 away 请求发出的时刻：请求在飞期间来了活动要直接撤回，不进入 autoAway 态 */
  let awayRequestStartedAt = 0;

  const idleMs = () => Math.max(MIN_IDLE_SECONDS, usePrefs.getState().prefs.idleTimeLimit) * 1000;
  const enabled = () => usePrefs.getState().prefs.enableAutoAway;
  const currentStatus = () => {
    const status = useAuth.getState().user?.status;
    return isPresenceStatus(status) ? status : null;
  };
  /** 只动内存里的 auth store，让界面立刻反映；不写显式偏好（见文件头注释） */
  const applyLocalStatus = (status: 'online' | 'away') => {
    const user = useAuth.getState().user;
    if (user && user.status !== status) useAuth.setState({ user: { ...user, status } });
  };

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const arm = () => {
    clearTimer();
    if (disposed || !enabled()) return;
    timer = setTimeout(() => {
      timer = null;
      void onIdle();
    }, idleMs());
  };

  const onIdle = async () => {
    if (disposed || !enabled() || currentStatus() !== 'online') return;
    awayRequestStartedAt = Date.now();
    try {
      await rest.setStatus('away');
    } catch {
      arm(); // 网络抖动不置 away，重新计时下轮再试
      return;
    }
    if (disposed) return;
    // 请求在飞期间用户已经动了（甚至可能手动改了状态）：立刻撤回这次 away
    if (lastActivityAt > awayRequestStartedAt || currentStatus() !== 'online') {
      await rest.setStatus('online').catch(() => {});
      arm();
      return;
    }
    autoAway = true;
    applyLocalStatus('away');
  };

  const onActivity = () => {
    if (disposed) return;
    lastActivityAt = Date.now();
    if (autoAway) {
      // 恢复不节流：自动 away 后的第一次活动就该回 online
      if (currentStatus() === 'away') {
        autoAway = false;
        void rest
          .setStatus('online')
          .then(() => {
            // 恢复请求在飞期间用户又手动改了状态：不盖回去
            if (currentStatus() === 'away') applyLocalStatus('online');
          })
          .catch(() => {
            autoAway = true; // 恢复失败：下一次活动再试
          });
      } else {
        // 自动 away 期间手动改了状态（本地已不再是 away）→ 恢复失效
        autoAway = false;
      }
    }
    const now = Date.now();
    if (now - lastArmAt < ACTIVITY_THROTTLE_MS) return;
    lastArmAt = now;
    arm();
  };

  for (const event of ACTIVITY_EVENTS) {
    target.addEventListener(event, onActivity, { passive: true });
  }
  // 偏好实时生效：开关关掉立刻停表；时长变化按新值重新计时
  const unsubscribe = usePrefs.subscribe((state, prev) => {
    if (disposed) return;
    if (
      state.prefs.enableAutoAway !== prev.prefs.enableAutoAway ||
      state.prefs.idleTimeLimit !== prev.prefs.idleTimeLimit
    ) {
      arm();
    }
  });
  arm();

  return () => {
    disposed = true;
    clearTimer();
    unsubscribe();
    for (const event of ACTIVITY_EVENTS) {
      target.removeEventListener(event, onActivity);
    }
  };
}
