import React, { useEffect, useState } from 'react';
import {
  MapPin,
  Heart,
  Clock,
  ExternalLink,
  Radio,
  AlertTriangle,
} from 'lucide-react';
import type { LiveTrackingSessionData } from '../types/wearable';
import { BrandLogo } from './BrandLogo';

interface LiveTrackPageProps {
  sessionId: string;
}

function formatElapsed(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms / 1000));
  const hrs = Math.floor(clamped / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export const LiveTrackPage: React.FC<LiveTrackPageProps> = ({ sessionId }) => {
  const [session, setSession] = useState<LiveTrackingSessionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const tick = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    let closed = false;
    let eventSource: EventSource | null = null;
    let pollTimer: number | null = null;

    const loadOnce = async () => {
      try {
        const res = await fetch(
          `/api/track/sessions/${encodeURIComponent(sessionId)}`
        );
        if (!res.ok) {
          if (!closed) {
            setError('This live tracking link was not found or has expired.');
          }
          return;
        }
        const data = (await res.json()) as LiveTrackingSessionData;
        if (!closed) {
          setSession(data);
          setError(null);
        }
      } catch {
        if (!closed) {
          setError('Unable to reach SafeWear live tracking server.');
        }
      }
    };

    void loadOnce();

    if (typeof EventSource !== 'undefined') {
      eventSource = new EventSource(
        `/api/track/sessions/${encodeURIComponent(sessionId)}/stream`
      );
      eventSource.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as LiveTrackingSessionData;
          if (!closed) {
            setSession(parsed);
            setError(null);
          }
        } catch {
          // Ignore malformed SSE packets
        }
      };
      eventSource.onerror = () => {
        // Fall back to periodic polling if SSE drops
        if (pollTimer === null) {
          pollTimer = window.setInterval(() => {
            void loadOnce();
          }, 5000);
        }
      };
    } else {
      pollTimer = window.setInterval(() => {
        void loadOnce();
      }, 4000);
    }

    return () => {
      closed = true;
      eventSource?.close();
      if (pollTimer !== null) window.clearInterval(pollTimer);
    };
  }, [sessionId]);

  if (error && !session) {
    return (
      <div className="min-h-screen bg-[#0B1220] text-white flex flex-col items-center justify-center p-6 text-center">
        <BrandLogo size="lg" />
        <h1 className="mt-5 text-2xl font-bold">Live Tracking Unavailable</h1>
        <p className="mt-2 max-w-md text-sm text-white/65">{error}</p>
        <a
          href="/"
          className="mt-6 rounded-lg bg-[#1C2A44] px-5 py-2.5 text-sm font-medium text-[#A8C7FA] hover:bg-[#243658]"
        >
          Go to SafeWear
        </a>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-[#0B1220] text-white flex items-center justify-center p-6">
        <p className="text-sm text-white/65">
          Connecting to live SafeWear emergency feed...
        </p>
      </div>
    );
  }

  const elapsedMs = Math.max(0, nowMs - session.createdAt);
  const isLive = session.active;
  const latestPoint =
    session.points.length > 0
      ? session.points[session.points.length - 1]
      : null;

  const osmEmbedUrl = latestPoint
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${(latestPoint.longitude - 0.005).toFixed(6)}%2C${(latestPoint.latitude - 0.004).toFixed(6)}%2C${(latestPoint.longitude + 0.005).toFixed(6)}%2C${(latestPoint.latitude + 0.004).toFixed(6)}&layer=mapnik&marker=${latestPoint.latitude.toFixed(6)}%2C${latestPoint.longitude.toFixed(6)}`
    : null;

  const googleMapsUrl = latestPoint
    ? `https://maps.google.com/?q=${latestPoint.latitude.toFixed(5)},${latestPoint.longitude.toFixed(5)}`
    : null;

  return (
    <div className="min-h-screen bg-[#0B1220] text-white flex flex-col">
      <header className="border-b border-white/10 bg-[#111D32] px-5 py-3.5">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <BrandLogo size="sm" />
            <span className="text-lg font-bold tracking-tight whitespace-nowrap">
              SafeWear Live Tracking
            </span>
          </div>

          <div className="flex items-center gap-2 font-mono text-xs tabular-nums">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                isLive ? 'bg-red-500 animate-pulse' : 'bg-white/40'
              }`}
            />
            <span className={isLive ? 'text-red-300 font-semibold' : 'text-white/60'}>
              {isLive
                ? `LIVE · ${formatElapsed(elapsedMs)}`
                : 'SOS STOPPED'}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 p-5 space-y-5">
        {/* Emergency Header Banner */}
        <div
          className={`rounded-[18px] border p-5 ${
            isLive
              ? 'border-red-500/40 bg-red-500/10'
              : 'border-white/10 bg-[#17243A]'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <AlertTriangle
                className={`mt-0.5 h-6 w-6 shrink-0 ${
                  isLive ? 'text-red-400' : 'text-white/50'
                }`}
              />
              <div>
                <h1 className="text-xl font-bold text-white">
                  {session.wearerName} — Emergency SOS
                </h1>
                <p className="mt-1 text-sm text-white/70">
                  {isLive
                    ? 'Location and heart rate update continuously in real time until SOS is cancelled.'
                    : 'This SOS session was stopped by the wearer. Showing full recorded trail.'}
                </p>
              </div>
            </div>

            {googleMapsUrl && (
              <a
                href={googleMapsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-lg bg-[#F44336] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#D32F2F] transition-colors whitespace-nowrap shrink-0"
              >
                Open in Google Maps
                <ExternalLink className="h-4 w-4" />
              </a>
            )}
          </div>
        </div>

        {/* Live Telemetry Summary Grid */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-[16px] border border-white/10 bg-[#17243A] p-4">
            <p className="text-xs text-white/55">Heart Rate</p>
            <p className="mt-1.5 flex items-center gap-1.5 font-mono text-xl font-bold text-pink-300 tabular-nums">
              <Heart className="h-4 w-4" />
              {session.heartRate > 0 ? `${session.heartRate} BPM` : '--'}
            </p>
          </div>

          <div className="rounded-[16px] border border-white/10 bg-[#17243A] p-4">
            <p className="text-xs text-white/55">Pendant Status</p>
            <p
              className={`mt-1.5 text-base font-bold ${
                session.pendantWorn === true
                  ? 'text-[#69F0AE]'
                  : session.pendantWorn === false
                    ? 'text-amber-400'
                    : 'text-white/60'
              }`}
            >
              {session.pendantWorn === true
                ? 'Worn'
                : session.pendantWorn === false
                  ? 'Not Worn'
                  : 'Unknown'}
            </p>
          </div>

          <div className="rounded-[16px] border border-white/10 bg-[#17243A] p-4">
            <p className="text-xs text-white/55">Active Duration</p>
            <p className="mt-1.5 flex items-center gap-1.5 font-mono text-xl font-bold text-white tabular-nums">
              <Clock className="h-4 w-4 text-[#5796F5]" />
              {isLive ? formatElapsed(elapsedMs) : 'Stopped'}
            </p>
          </div>

          <div className="rounded-[16px] border border-white/10 bg-[#17243A] p-4">
            <p className="text-xs text-white/55">GPS Trail Updates</p>
            <p className="mt-1.5 flex items-center gap-1.5 font-mono text-xl font-bold text-[#69F0AE] tabular-nums">
              <Radio className="h-4 w-4" />
              {session.points.length}
            </p>
          </div>
        </div>

        {/* Live Map Viewport */}
        <div className="rounded-[18px] border border-white/10 bg-[#17243A] overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <span className="flex items-center gap-2 text-sm font-semibold text-white">
              <MapPin className="h-4 w-4 text-[#5796F5]" />
              Live Map Position
            </span>
            {latestPoint && (
              <span className="font-mono text-xs text-white/65 tabular-nums">
                {latestPoint.latitude.toFixed(5)},{' '}
                {latestPoint.longitude.toFixed(5)}
              </span>
            )}
          </div>

          {osmEmbedUrl ? (
            <iframe
              title="SafeWear Live Location Map"
              src={osmEmbedUrl}
              className="h-[340px] w-full border-0 bg-[#0B1220]"
              loading="lazy"
            />
          ) : (
            <div className="flex h-[240px] items-center justify-center text-sm text-white/60">
              Waiting for first GPS fix from wearer&apos;s device...
            </div>
          )}
        </div>

        {/* Live Breadcrumb Trail Table */}
        <div className="rounded-[18px] border border-white/10 bg-[#17243A] overflow-hidden">
          <div className="border-b border-white/10 px-4 py-3">
            <h2 className="text-sm font-semibold text-white">
              Live Location Trail
            </h2>
          </div>

          {session.points.length === 0 ? (
            <p className="p-4 text-xs text-white/55">
              No GPS points received yet.
            </p>
          ) : (
            <div className="max-h-64 divide-y divide-white/10 overflow-y-auto">
              {[...session.points].reverse().map((pt, idx) => (
                <div
                  key={`${pt.timestamp}-${idx}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs font-mono tabular-nums"
                >
                  <span className="text-white/60">
                    {new Date(pt.timestamp).toLocaleTimeString()}
                  </span>
                  <span className="text-white">
                    {pt.latitude.toFixed(5)}, {pt.longitude.toFixed(5)}
                  </span>
                  <span className="text-pink-300">
                    {pt.heartRate && pt.heartRate > 0
                      ? `${pt.heartRate} BPM`
                      : '-- BPM'}
                  </span>
                  <a
                    href={`https://maps.google.com/?q=${pt.latitude.toFixed(5)},${pt.longitude.toFixed(5)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#A8C7FA] hover:underline font-sans"
                  >
                    Map
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
};
