import type { ReactNode } from "react";

interface SegmentedRowProps<T extends string> {
  /** Names the radio group; unique within the dialog. */
  name: string;
  label: string;
  note?: string;
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
  /** Long option labels: the choice sits under the label instead of beside it. */
  stacked?: boolean;
}

/** The one segmented choice every workflow setting row uses (Resources and Feedback). */
export function SegmentedRow<T extends string>({ name, label, note, options, value, disabled, onChange, stacked }: SegmentedRowProps<T>) {
  const labelId = `resource-${name}`;
  return (
    <div className={stacked ? "resource-row resource-row-stacked" : "resource-row"}>
      <span className="resource-label" id={labelId}>{label}{note ? <small>{note}</small> : null}</span>
      <div className="resource-seg" role="radiogroup" aria-labelledby={labelId}>
        {options.map((option) => (
          <label key={option.value} className="resource-seg-option">
            <input type="radio" name={labelId} value={option.value} checked={value === option.value} disabled={disabled}
              onChange={() => onChange(option.value)} />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
