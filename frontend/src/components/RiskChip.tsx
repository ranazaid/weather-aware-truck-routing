import clsx from "clsx";
import type { SegmentLevel } from "../api/types";
import { LEVEL_COLOR, LEVEL_LABEL } from "../lib/risk";

export function RiskDot({ level, className }: { level: SegmentLevel; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx("inline-block h-2 w-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: LEVEL_COLOR[level] }}
    />
  );
}

export function RiskChip({ level, className }: { level: SegmentLevel; className?: string }) {
  const color = LEVEL_COLOR[level];
  return (
    <span
      className={clsx("chip", className)}
      style={{ color, backgroundColor: `${color}1f`, boxShadow: `inset 0 0 0 1px ${color}55` }}
    >
      <RiskDot level={level} />
      {LEVEL_LABEL[level]}
    </span>
  );
}
