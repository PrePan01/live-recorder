import { useId, type ReactNode } from "react";
import { Slider, Switch } from "antd";
import MemphisRadioGroup from "./MemphisRadioGroup";
import { DANMUKU_DENSITY_OPTIONS } from "../utils/danmakuPrefs";
import "../styles/danmaku-player.css";

const DENSITY_OPTIONS = DANMUKU_DENSITY_OPTIONS.map((value, index) => ({
  label: ["低", "中", "高"][index],
  value,
}));

interface DanmakuSettingsProps {
  visible: boolean;
  opacity: number;
  density: number;
  statusText?: string;
  compact?: boolean;
  actions?: ReactNode;
  onVisibleChange: (visible: boolean) => void;
  onOpacityChange: (opacity: number) => void;
  onDensityChange: (density: number) => void;
}

/** 回看与直播预览共用的显示设置；持久化由宿主处理。 */
export default function DanmakuSettings({
  visible,
  opacity,
  density,
  statusText,
  compact = false,
  actions,
  onVisibleChange,
  onOpacityChange,
  onDensityChange,
}: DanmakuSettingsProps) {
  const id = useId();
  return (
    <section
      className={`lr-danmaku-settings${compact ? " lr-danmaku-settings--compact" : ""}`}
      aria-labelledby={`${id}-title`}
    >
      <div className="lr-danmaku-settings__heading">
        <span id={`${id}-title`}>弹幕设置</span>
        {statusText ? (
          <span className="lr-danmaku-settings__status">{statusText}</span>
        ) : null}
        {actions ? (
          <div className="lr-danmaku-settings__actions">{actions}</div>
        ) : null}
      </div>
      <div className="lr-danmaku-settings__fields">
        <div className="lr-danmaku-settings__field lr-danmaku-settings__visibility">
          <label htmlFor={`${id}-visible`}>显示弹幕</label>
          <Switch
            id={`${id}-visible`}
            aria-label="显示弹幕"
            checked={visible}
            onChange={onVisibleChange}
          />
        </div>
        <div className="lr-danmaku-settings__field">
          <div className="lr-danmaku-settings__label">
            <span id={`${id}-opacity`}>弹幕透明度</span>
            <output>{Math.round(opacity * 100)}%</output>
          </div>
          <Slider
            min={0.2}
            max={1}
            step={0.1}
            value={opacity}
            ariaLabelledByForHandle={`${id}-opacity`}
            ariaValueTextFormatterForHandle={(value) =>
              `${Math.round(value * 100)}%`
            }
            tooltip={{
              formatter: (value) => `${Math.round((value ?? 0) * 100)}%`,
            }}
            onChange={onOpacityChange}
          />
        </div>
        <div className="lr-danmaku-settings__field">
          <span id={`${id}-density`}>同屏密度</span>
          <MemphisRadioGroup
            aria-labelledby={`${id}-density`}
            value={density}
            options={DENSITY_OPTIONS}
            onChange={(event) => onDensityChange(event.target.value)}
          />
        </div>
      </div>
    </section>
  );
}
