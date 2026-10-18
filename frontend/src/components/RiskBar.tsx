import type { RouteSummary, SegmentLevel } from "../api/types";
import { formatMiles } from "../lib/format";
import { LEVEL_COLOR, LEVEL_LABEL, LEVELS } from "../lib/risk";

/** Stacked bar of miles per risk level (plus Unknown), with an accessible text summary. */
export function RiskBar({ summary, height = 8 }: { summary: RouteSummary; height?: number }) {
  const parts: { level: SegmentLevel; mi: number }[] = [
    ...LEVELS.map((level) => ({ level, mi: summary.miles_by_level[level] ?? 0 })),
    { level: "unknown" as const, mi: summary.unknown_mi },
  ].filter((p) => p.mi > 0.05);
  const total = parts.reduce((a, p) => a + p.mi, 0) || 1;
  const description = parts.map((p) => `${LEVEL_LABEL[p.level]} ${formatMiles(p.mi)}`).join(", ");

  return (
    <div
      role="img"
      aria-label={`Miles by risk: ${description}`}
      className="flex w-full overflow-hidden rounded-full bg-ink-700"
      style={{ height }}
    >
      {parts.map((p) => (
        <div
          key={p.level}
          title={`${LEVEL_LABEL[p.level]}: ${formatMiles(p.mi, 1)}`}
          className="h-full transition-[width] duration-500"
          style={{ width: `${(p.mi / total) * 100}%`, backgroundColor: LEVEL_COLOR[p.level], minWidth: 3 }}
        />
      ))}
    </div>
  );
}
