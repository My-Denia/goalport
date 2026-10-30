import type { PiCapacitySelection } from '../../electron/pi-capacity.mjs';
/** One configured route + explicit intent control, shared by both entry points. */
export function PiCapacityControl({capacity,checked,disabled,onChange}:{capacity:PiCapacitySelection;checked:boolean;disabled:boolean;onChange?:(enabled:boolean)=>void}) {
  return <>
    <div title={`${capacity.provider}/${capacity.model}`}>Requested: {capacity.provider}/{capacity.model} · Billing not confirmed</div>
    <label><input type="checkbox" aria-label="Use Pi's configured capacity for this goal" checked={checked} disabled={disabled || !onChange} onChange={event=>onChange?.(event.target.checked)} /> Use Pi's configured capacity for this goal</label>
    <details><summary>Technical details</summary>Reasoning settings remain managed by Pi; GoalPort pins the requested pair only. This is not proof of the effective server model, authentication, quota or billing.</details>
  </>;
}
