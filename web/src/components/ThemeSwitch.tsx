import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import type { ThemeSetting } from "../lib/theme";

const OPTIONS: { value: ThemeSetting; label: string; Icon: LucideIcon }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

/** The theme control: 3 icon buttons that act as one radio group. */
export function ThemeSwitch({
  value,
  onChange,
}: {
  value: ThemeSetting;
  onChange: (value: ThemeSetting) => void;
}) {
  return (
    <div
      className="segmented theme-switch"
      role="radiogroup"
      aria-label="Theme"
    >
      {OPTIONS.map(({ value: v, label, Icon }) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          className={value === v ? "is-on" : ""}
          onClick={() => onChange(v)}
          title={`${label} theme`}
          aria-label={`${label} theme`}
        >
          <Icon size={14} aria-hidden />
        </button>
      ))}
    </div>
  );
}
