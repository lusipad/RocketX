/**
 * 通知提示音：WebAudio 振荡器现场合成短促「叮」声，不引入音频资源文件。
 *
 * 设置页「提示音音量」（notificationsSoundVolume，0-100）此前是死设置——只存不用。
 * 发声时机由调用方把控：只有真正会弹系统通知的分支才调用本模块
 * （免打扰/聚合/当前会话不打扰等抑制分支根本不会走到这里）。
 */

/** 复用同一个 AudioContext：浏览器对同时存在的 AudioContext 数量有限制（约 6 个） */
let ctx: AudioContext | null = null;

/** 读 globalThis 而不是 window：浏览器里两者相同，测试（node）可以直接 stub */
function audioContextCtor(): typeof AudioContext | undefined {
  return (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
}

/**
 * 按音量（0-100）播放一次提示音。音量 0 / 环境不支持 WebAudio 时静默返回。
 * 所有异常都吞掉——提示音不是关键路径，不能因为发不出声把通知链路炸了。
 */
export function playNotificationSound(volume: number | undefined): void {
  const raw = typeof volume === 'number' && Number.isFinite(volume) ? volume : 100;
  const gain = Math.min(100, Math.max(0, Math.round(raw))) / 100;
  if (gain <= 0) return;
  try {
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    if (!ctx || ctx.state === 'closed') ctx = new Ctor();
    // 浏览器自动播放策略：首次用户交互前 AudioContext 是 suspended。
    // 调 resume 等手势落地后出声；被拒绝（少见）也照常调度，不出声但不报错。
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    // 10ms 淡入防爆音，250ms 指数衰减收尾（指数斜坡不能到 0，落到 0.0001）
    amp.gain.setValueAtTime(0, now);
    amp.gain.linearRampToValueAtTime(gain, now + 0.01);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);
    osc.connect(amp);
    amp.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.3);
  } catch {
    // 无音频设备 / 策略拦截导致构造或调度抛错：静默
  }
}

/** 测试用：丢弃缓存的 AudioContext，让下一个用例拿到干净的 mock */
export function resetNotificationSoundForTests(): void {
  ctx = null;
}
