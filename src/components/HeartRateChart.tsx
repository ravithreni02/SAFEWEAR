import React from 'react';
import type { HeartRateSample } from '../types/wearable';

interface HeartRateChartProps {
  samples: HeartRateSample[];
  highThreshold: number;
  lowThreshold: number;
  currentBpm: number;
}

export const HeartRateChart: React.FC<HeartRateChartProps> = ({
  samples,
  highThreshold,
  lowThreshold,
  currentBpm,
}) => {
  const validValues = samples.map((s) => s.bpm).filter((v) => v > 0);
  const minBpm = validValues.length > 0 ? Math.min(...validValues) : 0;
  const maxBpm = validValues.length > 0 ? Math.max(...validValues) : 0;
  const avgBpm =
    validValues.length > 0
      ? Math.round(
          validValues.reduce((sum, v) => sum + v, 0) / validValues.length
        )
      : 0;

  const width = 620;
  const height = 165;
  const padLeft = 36;
  const padRight = 14;
  const padTop = 16;
  const padBottom = 26;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const yMin = 30;
  const yMax = Math.max(160, highThreshold + 25, maxBpm + 15);

  const toY = (bpm: number) => {
    const clamped = Math.max(yMin, Math.min(yMax, bpm));
    const ratio = (clamped - yMin) / (yMax - yMin);
    return padTop + chartH - ratio * chartH;
  };

  const toX = (index: number, total: number) => {
    if (total <= 1) return padLeft + chartW;
    return padLeft + (index / (total - 1)) * chartW;
  };

  const points = samples.map((s, idx) => ({
    ...s,
    x: toX(idx, samples.length),
    y: toY(s.bpm),
    abnormal: s.bpm > 0 && (s.bpm >= highThreshold || s.bpm <= lowThreshold),
  }));

  const linePath =
    points.length > 1
      ? points
          .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
          .join(' ')
      : '';

  const areaPath =
    points.length > 1
      ? `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${(padTop + chartH).toFixed(1)} L ${points[0].x.toFixed(1)} ${(padTop + chartH).toFixed(1)} Z`
      : '';

  const thresholdY = toY(highThreshold);
  const yTicks = [yMin, Math.round((yMin + yMax) / 2), yMax];

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-baseline justify-between gap-4 pb-3 border-b border-white/10">
        <div className="flex items-baseline gap-2.5">
          <span
            className={`font-mono text-3xl font-bold tabular-nums ${
              currentBpm > 0 &&
              (currentBpm >= highThreshold || currentBpm <= lowThreshold)
                ? 'text-[#FF5252]'
                : 'text-white'
            }`}
          >
            {currentBpm}
          </span>
          <span className="text-sm text-white/60">BPM live</span>
        </div>

        <div className="flex items-center gap-4 text-xs text-white/60 font-mono tabular-nums">
          <span>Min {minBpm}</span>
          <span aria-hidden="true">·</span>
          <span>Avg {avgBpm}</span>
          <span aria-hidden="true">·</span>
          <span>Peak {maxBpm}</span>
        </div>
      </div>

      {samples.length < 2 ? (
        <div className="mt-4 flex h-[165px] flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-[#111D32]/60 px-4 text-center">
          <p className="text-sm font-medium text-white/75">
            Waiting for live heart rate stream
          </p>
          <p className="mt-1 text-xs text-white/50">
            Connect your SafeWear pendant and place your finger on the PPG
            sensor to plot live BPM readings.
          </p>
        </div>
      ) : (
        <div className="mt-3 w-full overflow-hidden">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="h-[175px] w-full"
            role="img"
            aria-label="Live heart rate graph"
          >
            <defs>
              <linearGradient id="hrAreaGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#FF4081" stopOpacity="0.32" />
                <stop offset="100%" stopColor="#FF4081" stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {/* Horizontal gridlines */}
            {yTicks.map((tick) => {
              const y = toY(tick);
              return (
                <g key={tick}>
                  <line
                    x1={padLeft}
                    y1={y}
                    x2={width - padRight}
                    y2={y}
                    stroke="rgba(255,255,255,0.08)"
                    strokeWidth="1"
                  />
                  <text
                    x={padLeft - 8}
                    y={y + 4}
                    textAnchor="end"
                    fill="rgba(255,255,255,0.45)"
                    fontSize="10"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {tick}
                  </text>
                </g>
              );
            })}

            {/* High BPM Alert Threshold Line */}
            <line
              x1={padLeft}
              y1={thresholdY}
              x2={width - padRight}
              y2={thresholdY}
              stroke="#EF4444"
              strokeWidth="1.2"
              strokeDasharray="4 4"
            />
            <text
              x={width - padRight}
              y={thresholdY - 5}
              textAnchor="end"
              fill="#FCA5A5"
              fontSize="10"
              fontFamily="JetBrains Mono, monospace"
            >
              Alert {highThreshold} BPM
            </text>

            {/* Area & Line */}
            <path d={areaPath} fill="url(#hrAreaGrad)" />
            <path
              d={linePath}
              fill="none"
              stroke="#FF4081"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {/* Data Points */}
            {points.map((pt, i) => (
              <circle
                key={`${pt.timestamp}-${i}`}
                cx={pt.x}
                cy={pt.y}
                r={i === points.length - 1 ? 4 : pt.abnormal ? 3.5 : 2}
                fill={pt.abnormal ? '#EF4444' : '#FF4081'}
              >
                <title>{`${pt.bpm} BPM at ${pt.time}`}</title>
              </circle>
            ))}

            {/* X-axis start/end timestamps */}
            <text
              x={padLeft}
              y={height - 6}
              textAnchor="start"
              fill="rgba(255,255,255,0.45)"
              fontSize="10"
              fontFamily="JetBrains Mono, monospace"
            >
              {points[0].time}
            </text>
            <text
              x={width - padRight}
              y={height - 6}
              textAnchor="end"
              fill="rgba(255,255,255,0.45)"
              fontSize="10"
              fontFamily="JetBrains Mono, monospace"
            >
              {points[points.length - 1].time}
            </text>
          </svg>
        </div>
      )}
    </div>
  );
};
