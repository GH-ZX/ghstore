/**
 * Profile → "Your level": cashback from what was spent in the last 30 days
 * (packages/api/src/loyalty.ts), how far the next level is, and all levels.
 */
import { usd } from "../lib/format";
import { useT } from "../lib/state";
import { useApi } from "../lib/useApi";

interface LevelData {
  enabled: boolean;
  level?: number;
  percent?: number;
  spentCents?: number;
  tiers?: { minCents: number; percent: number }[];
  next?: { level: number; minCents: number; percent: number; leftCents: number } | null;
}

/** Level names: 0 none, then Silver, Gold, Platinum, Diamond, Legend. */
const NAMES = ["lvl0", "lvl1", "lvl2", "lvl3", "lvl4", "lvl5"] as const;

export function LevelCard() {
  const { t } = useT();
  const { data } = useApi<LevelData>("/api/me/level");
  if (!data?.enabled || !data.tiers) return null;
  const level = data.level ?? 0;
  const spent = data.spentCents ?? 0;
  const next = data.next ?? null;
  const prev = level ? data.tiers[level - 1]!.minCents : 0;
  const progress = next ? Math.max(0, Math.min(1, (spent - prev) / (next.minCents - prev))) : 1;
  return (
    <div className={`card card--pad stack-sm level level--${Math.min(level, 3)}`}>
      <div className="row-between">
        <span className="stack-xs">
          <span className="small muted">{t("lvlTitle")}</span>
          <strong className="level__name">{t(NAMES[Math.min(level, 5)]!)}</strong>
        </span>
        <span className="level__pct num">{level ? `${data.percent}%` : "0%"}</span>
      </div>
      <span className="small">{level ? t("lvlBack", { n: data.percent ?? 0 }) : t("lvlNone")}</span>
      <div className="level__bar" aria-hidden="true">
        <i style={{ width: `${progress * 100}%` }} />
      </div>
      <span className="small muted">
        {next
          ? t("lvlNext", { amount: usd(next.leftCents), name: t(NAMES[Math.min(next.level, 5)]!), n: next.percent })
          : t("lvlTop")}
      </span>
      <span className="small muted">{t("lvlSpent", { amount: usd(spent) })}</span>
    </div>
  );
}
