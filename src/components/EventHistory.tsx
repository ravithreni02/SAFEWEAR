import React, { useState, useMemo } from 'react';
import {
  Clock,
  ExternalLink,
  Search,
  Trash2,
  MapPin,
  Heart,
  Radio,
} from 'lucide-react';
import type { SosEventOutcome, SosEventRecord } from '../types/wearable';

interface EventHistoryProps {
  events: SosEventRecord[];
  onClearHistory: () => void;
}

type FilterOption = 'all' | SosEventOutcome;

const OUTCOME_LABEL: Record<SosEventOutcome, string> = {
  sent: 'SOS Sent',
  cancelled: 'SOS Cancelled',
  offline_sms: 'Offline SMS',
  hr_alert: 'Heart Rate Alert',
};

const OUTCOME_TEXT_COLOR: Record<SosEventOutcome, string> = {
  sent: 'text-red-400',
  cancelled: 'text-white/60',
  offline_sms: 'text-amber-400',
  hr_alert: 'text-pink-400',
};

export const EventHistory: React.FC<EventHistoryProps> = ({
  events,
  onClearHistory,
}) => {
  const [filter, setFilter] = useState<FilterOption>('all');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((ev) => {
      if (filter !== 'all' && ev.outcome !== filter) return false;
      if (!q) return true;
      const coords =
        ev.latitude !== null && ev.longitude !== null
          ? `${ev.latitude.toFixed(5)}, ${ev.longitude.toFixed(5)}`
          : '';
      return (
        ev.timestamp.toLowerCase().includes(q) ||
        ev.deliverySummary.toLowerCase().includes(q) ||
        coords.includes(q) ||
        OUTCOME_LABEL[ev.outcome].toLowerCase().includes(q)
      );
    });
  }, [events, filter, query]);

  const filterButtons: Array<{ id: FilterOption; label: string }> = [
    { id: 'all', label: 'All Events' },
    { id: 'sent', label: 'SOS Sent' },
    { id: 'cancelled', label: 'Cancelled' },
    { id: 'offline_sms', label: 'Offline SMS' },
    { id: 'hr_alert', label: 'HR Alerts' },
  ];

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Event History</h1>
          <p className="mt-1 text-sm text-white/60">
            Complete log of SOS activations, cancellations, offline SMS
            fallbacks, and heart rate alerts.
          </p>
        </div>

        {events.length > 0 && (
          <button
            type="button"
            onClick={onClearHistory}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-xs font-medium text-white/75 hover:bg-white/5 hover:text-red-300 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear Log
          </button>
        )}
      </div>

      {/* Filter & Search Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-[#111D32] p-1 border border-white/10">
          {filterButtons.map((btn) => (
            <button
              key={btn.id}
              type="button"
              onClick={() => setFilter(btn.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                filter === btn.id
                  ? 'bg-[#1C2A44] text-[#A8C7FA]'
                  : 'text-white/60 hover:text-white'
              }`}
            >
              {btn.label}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search time, location, status..."
            className="w-full rounded-lg border border-white/15 bg-[#111D32] py-2 pl-9 pr-3 text-xs text-white placeholder-white/40 outline-none focus:border-[#5796F5]"
          />
        </div>
      </div>

      {/* Event Log List */}
      <div className="rounded-[18px] border border-white/10 bg-[#17243A] overflow-hidden">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
            <Clock className="h-10 w-10 text-white/25" />
            <p className="mt-3 text-sm font-semibold text-white">
              {events.length === 0
                ? 'No safety events recorded yet'
                : 'No matching events found'}
            </p>
            <p className="mt-1 max-w-sm text-xs text-white/55">
              {events.length === 0
                ? 'Whenever an SOS is triggered, cancelled, dispatched via SMS/WhatsApp, or an abnormal heart rate spike occurs, it will appear here with time, location, and heart rate.'
                : 'Try switching the filter or clearing your search query.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/10">
            {filtered.map((ev) => {
              const hasCoords = ev.latitude !== null && ev.longitude !== null;
              const coordLabel = hasCoords
                ? `${ev.latitude!.toFixed(5)}, ${ev.longitude!.toFixed(5)}`
                : 'Location unavailable';
              const mapHref = hasCoords
                ? `https://maps.google.com/?q=${ev.latitude!.toFixed(5)},${ev.longitude!.toFixed(5)}`
                : null;

              return (
                <div
                  key={ev.id}
                  className="p-4 hover:bg-white/[0.02] transition-colors"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm">
                      <span
                        className={`font-semibold ${OUTCOME_TEXT_COLOR[ev.outcome]}`}
                      >
                        {OUTCOME_LABEL[ev.outcome]}
                      </span>
                      <span className="text-white/30" aria-hidden="true">
                        ·
                      </span>
                      <span className="font-mono text-xs text-white/70 tabular-nums">
                        {ev.timestamp}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 text-xs font-mono tabular-nums">
                      <span className="inline-flex items-center gap-1 text-pink-300">
                        <Heart className="h-3.5 w-3.5" />
                        {ev.heartRate > 0 ? `${ev.heartRate} BPM` : '-- BPM'}
                      </span>
                    </div>
                  </div>

                  <p className="mt-2 text-xs text-white/75">
                    {ev.deliverySummary}
                  </p>

                  <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-white/60">
                    <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                      <MapPin className="h-3.5 w-3.5 text-[#5796F5]" />
                      {coordLabel}
                    </span>

                    {mapHref && (
                      <a
                        href={mapHref}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[#A8C7FA] hover:underline"
                      >
                        Google Maps
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}

                    {ev.trackingUrl && (
                      <a
                        href={ev.trackingUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[#69F0AE] hover:underline"
                      >
                        <Radio className="h-3 w-3" />
                        Live Track Link
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
};
