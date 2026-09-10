import { Radio } from "antd";
import type { ComponentProps, CSSProperties } from "react";

type RadioGroupProps = ComponentProps<typeof Radio.Group>;

/**
 * The application's shared segmented control.  Keeping the class and the
 * selected index together means every radio group uses the same themed slide.
 */
export default function MemphisRadioGroup({
  className,
  options,
  value,
  defaultValue,
  style,
  ...props
}: RadioGroupProps) {
  const values = (options ?? []).map((option) =>
    typeof option === "object" && option !== null ? option.value : option,
  );
  const current = value ?? defaultValue;
  const selectedIndex = Math.max(0, values.findIndex((item) => item === current));
  const count = Math.max(values.length, 1);

  return (
    <Radio.Group
      {...props}
      className={["lr-memphis-radio-group", className].filter(Boolean).join(" ")}
      options={options}
      value={value}
      defaultValue={defaultValue}
      optionType="button"
      buttonStyle="solid"
      style={{
        ...style,
        "--lr-radio-count": count,
        "--lr-radio-index": selectedIndex,
      } as CSSProperties}
    />
  );
}
