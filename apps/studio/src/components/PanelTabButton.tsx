import { Tooltip } from "./ui";

/** Tab-bar button for the right inspector panel header. */
export function PanelTabButton({
  label,
  tooltip,
  active,
  onClick,
}: {
  label: string;
  tooltip: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={tooltip} side="bottom">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={`cf-panel-tab h-8 rounded-md px-2.5 text-[11px] font-medium transition-colors active:scale-[0.98] ${active ? "is-active" : ""}`}
      >
        {label}
      </button>
    </Tooltip>
  );
}
