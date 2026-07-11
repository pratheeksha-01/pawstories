import React, { useMemo, useState } from 'react';

// Validated categorical/status colors from the dataviz skill's reference palette,
// checked against this chart's dark surface (#1a1a19) — see chat history for the
// validator run. This admin page is deliberately dark-only, matching the rest of
// the app's single dark "TOP SECRET" visual identity rather than a themed toggle.
export const CHART_COLORS = {
  surface: '#1a1a19',
  gridline: '#2c2c2a',
  baseline: '#383835',
  textPrimary: '#ffffff',
  textSecondary: '#c3c2b7',
  textMuted: '#898781',
  blue: '#3987e5',   // categorical slot 1 — "analyze" series
  orange: '#d95926',  // categorical slot 8 — "image" series
  good: '#0ca30c',
  warning: '#fab219',
  critical: '#e2685c',
};

interface Series {
  name: string;
  color: string;
  values: number[];
}

interface GroupedBarChartProps {
  days: string[];
  series: Series[];
  formatValue?: (n: number) => string;
  height?: number;
}

function niceMax(max: number): number {
  if (max <= 0) return 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
  const normalized = max / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function formatDateLabel(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export default function GroupedBarChart({ days, series, formatValue, height = 220 }: GroupedBarChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const fmt = formatValue || ((n: number) => n.toLocaleString());

  const maxVal = useMemo(() => {
    const allValues = series.flatMap((s) => s.values);
    return niceMax(Math.max(1, ...allValues));
  }, [series]);

  const width = 720;
  const padLeft = 44;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 28;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const dayW = plotW / Math.max(1, days.length);
  const barGap = 2; // surface gap between touching bars
  const groupPad = Math.max(4, dayW * 0.18);
  const barW = Math.min(24, (dayW - groupPad * 2 - barGap * (series.length - 1)) / series.length);

  const yTicks = [0, 0.5, 1].map((f) => Math.round(maxVal * f));
  const labelEvery = Math.max(1, Math.ceil(days.length / 8));

  const hovered = hoverIndex !== null;

  return (
    <div style={{ position: 'relative' }}>
      {series.length > 1 && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 10, flexWrap: 'wrap' }}>
          {series.map((s) => (
            <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: CHART_COLORS.textSecondary, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color, display: 'inline-block' }} />
              {s.name}
            </div>
          ))}
        </div>
      )}
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}>
        {yTicks.map((t, i) => {
          const y = padTop + plotH - (t / maxVal) * plotH;
          return (
            <g key={i}>
              <line x1={padLeft} x2={width - padRight} y1={y} y2={y} stroke={CHART_COLORS.gridline} strokeWidth={1} />
              <text x={padLeft - 8} y={y + 3} textAnchor="end" fontSize={10.5} fill={CHART_COLORS.textMuted} fontFamily="ui-monospace, monospace">
                {t.toLocaleString()}
              </text>
            </g>
          );
        })}
        <line x1={padLeft} x2={width - padRight} y1={padTop + plotH} y2={padTop + plotH} stroke={CHART_COLORS.baseline} strokeWidth={1} />

        {days.map((day, i) => {
          const groupX = padLeft + i * dayW;
          const isHover = hoverIndex === i;
          return (
            <g key={day}>
              <rect
                x={groupX} y={padTop} width={dayW} height={plotH}
                fill={isHover ? 'rgba(255,255,255,0.04)' : 'transparent'}
                onMouseEnter={() => setHoverIndex(i)}
                onMouseLeave={() => setHoverIndex((h) => (h === i ? null : h))}
              />
              {series.map((s, si) => {
                const val = s.values[i] || 0;
                const barH = maxVal > 0 ? (val / maxVal) * plotH : 0;
                const x = groupX + groupPad + si * (barW + barGap);
                const y = padTop + plotH - barH;
                const r = Math.min(4, barH);
                return (
                  <path
                    key={s.name}
                    d={barH > 0
                      ? `M ${x} ${y + r} a ${r} ${r} 0 0 1 ${r} -${r} h ${Math.max(0, barW - 2 * r)} a ${r} ${r} 0 0 1 ${r} ${r} v ${Math.max(0, barH - r)} h -${barW} Z`
                      : ''}
                    fill={s.color}
                    pointerEvents="none"
                  />
                );
              })}
              {i % labelEvery === 0 && (
                <text x={groupX + dayW / 2} y={height - 8} textAnchor="middle" fontSize={10.5} fill={CHART_COLORS.textMuted}>
                  {formatDateLabel(day)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {hovered && hoverIndex !== null && (
        <div
          style={{
            position: 'absolute',
            left: `${Math.min(88, Math.max(0, ((padLeft + (hoverIndex + 0.5) * dayW) / width) * 100))}%`,
            top: 0,
            transform: 'translate(-50%, -100%)',
            background: '#0d0d0d',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: 12,
            color: CHART_COLORS.textPrimary,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            zIndex: 10,
          }}
        >
          <div style={{ color: CHART_COLORS.textMuted, fontSize: 10.5, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {formatDateLabel(days[hoverIndex])}
          </div>
          {series.map((s) => (
            <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, display: 'inline-block' }} />
              <span style={{ color: CHART_COLORS.textSecondary }}>{s.name}:</span>
              <strong>{fmt(s.values[hoverIndex] || 0)}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
