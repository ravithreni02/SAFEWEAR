import type {
  DispatchDeliveryResult,
  EmergencyContact,
  SosEventRecord,
} from '../types/wearable';

const HISTORY_STORAGE_KEY = 'safewear_event_history_v1';

export interface TrackingSessionCreated {
  sessionId: string;
  trackingUrl: string;
  createdAt: number;
  expiresAt: number | null;
}

export interface SosDispatchResponse {
  dispatched: boolean;
  sentCount: number;
  totalAttempted: number;
  results: DispatchDeliveryResult[];
  messagePreview: string;
}

export interface ServerConfigStatus {
  twilioSmsConfigured: boolean;
  twilioWhatsappConfigured: boolean;
}

export async function fetchServerConfigStatus(): Promise<ServerConfigStatus> {
  try {
    const res = await fetch('/api/config/status');
    if (!res.ok) {
      return { twilioSmsConfigured: false, twilioWhatsappConfigured: false };
    }
    return (await res.json()) as ServerConfigStatus;
  } catch {
    return { twilioSmsConfigured: false, twilioWhatsappConfigured: false };
  }
}

export async function createLiveTrackingSession(params: {
  wearerName: string;
  heartRate: number;
  pendantWorn: boolean | null;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
}): Promise<TrackingSessionCreated> {
  const origin =
    typeof window !== 'undefined' ? window.location.origin : undefined;
  const res = await fetch('/api/track/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, origin }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create tracking session (${res.status})`);
  }
  return (await res.json()) as TrackingSessionCreated;
}

export async function updateLiveTrackingSession(
  sessionId: string,
  params: {
    latitude?: number;
    longitude?: number;
    accuracy?: number;
    heartRate?: number;
    pendantWorn?: boolean | null;
  }
): Promise<void> {
  await fetch(`/api/track/sessions/${encodeURIComponent(sessionId)}/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}

export async function stopLiveTrackingSession(
  sessionId: string
): Promise<void> {
  try {
    await fetch(`/api/track/sessions/${encodeURIComponent(sessionId)}/stop`, {
      method: 'POST',
    });
  } catch {
    // Ignore network errors when stopping
  }
}

export async function dispatchAutomaticSosAlerts(params: {
  wearerName: string;
  heartRate: number;
  latitude: number | null;
  longitude: number | null;
  trackingUrl?: string;
  contacts: EmergencyContact[];
}): Promise<SosDispatchResponse> {
  const res = await fetch('/api/sos/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new Error(`SOS dispatch failed (${res.status})`);
  }
  return (await res.json()) as SosDispatchResponse;
}

export function buildOfflineSmsUri(params: {
  wearerName: string;
  heartRate: number;
  latitude: number | null;
  longitude: number | null;
  trackingUrl?: string;
  isOffline?: boolean;
  contacts: EmergencyContact[];
}): { uri: string; body: string } | null {
  const phones = params.contacts
    .map((c) => c.phone.replace(/[^\d+]/g, ''))
    .filter(Boolean);

  if (phones.length === 0) return null;

  const mapUrl =
    params.latitude !== null && params.longitude !== null
      ? `https://maps.google.com/?q=${params.latitude.toFixed(5)},${params.longitude.toFixed(5)}`
      : 'GPS unavailable';

  const hrText = params.heartRate > 0 ? `${params.heartRate} BPM` : 'Reading';
  const header = params.isOffline
    ? `EMERGENCY SOS from ${params.wearerName} (SafeWear - Offline SMS)`
    : `EMERGENCY SOS from ${params.wearerName} (SafeWear)`;

  const lines = [
    header,
    `Heart Rate: ${hrText}`,
    `Location: ${mapUrl}`,
    params.trackingUrl ? `Live Location Link: ${params.trackingUrl}` : '',
  ].filter(Boolean);

  const body = lines.join('\n');

  // Use comma-separated recipients for standard mobile SMS composer
  const recipients = phones.join(',');
  const uri = `sms:${recipients}?body=${encodeURIComponent(body)}`;
  return { uri, body };
}

export function loadEventHistory(): SosEventRecord[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SosEventRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveEventHistory(records: SosEventRecord[]): void {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(records.slice(0, 100)));
  } catch {
    // Ignore storage quota errors
  }
}
