/** 设置页通用控件：开关、单选组、滑块、下拉 */

export function Row({
  label,
  hint,
  children,
  inline,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  /** 控件与标题同行（开关类用） */
  inline?: boolean;
}) {
  if (inline) {
    return (
      <div className="flex items-center justify-between gap-6 border-b border-line py-3.5 last:border-b-0">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink">{label}</div>
          {hint && <div className="mt-0.5 text-xs leading-relaxed text-ink-3">{hint}</div>}
        </div>
        <div className="shrink-0">{children}</div>
      </div>
    );
  }
  return (
    <div className="border-b border-line py-4 last:border-b-0">
      <div className="mb-1.5 text-sm font-medium text-ink">{label}</div>
      {hint && <div className="mb-2 text-xs leading-relaxed text-ink-3">{hint}</div>}
      {children}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition ${
        checked ? 'bg-primary' : 'bg-fill-active'
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all ${
          checked ? 'left-[22px]' : 'left-0.5'
        }`}
      />
    </button>
  );
}

export function RadioGroup<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { key: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(({ key, label, hint }) => {
        const active = value === key;
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            className={`min-w-24 rounded-lg border px-3 py-2 text-left transition ${
              active
                ? 'border-primary bg-primary-light'
                : 'border-line hover:border-ink-3 hover:bg-fill-hover'
            }`}
          >
            <div className={`text-sm ${active ? 'font-medium text-primary' : 'text-ink'}`}>
              {label}
            </div>
            {hint && <div className="mt-0.5 text-2xs text-ink-3">{hint}</div>}
          </button>
        );
      })}
    </div>
  );
}

export function Slider({
  value,
  onChange,
  min = 0,
  max = 100,
  suffix = '',
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  return (
    <div className="flex w-64 items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-fill-active accent-primary"
      />
      <span className="w-12 shrink-0 text-right text-xs text-ink-2">
        {value}
        {suffix}
      </span>
    </div>
  );
}
