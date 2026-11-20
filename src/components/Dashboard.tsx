import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  LogOut,
  Bluetooth,
  AlertTriangle,
  Heart,
  Radio,
  Vibrate,
  MapPin,
  Crosshair,
  Users,
  Plus,
  Trash2,
  X,
  BellRing,
  WifiOff,
  Copy,
  Check,
  ExternalLink,
  MessageSquare,
} from 'lucide-react';
import { signOutAuth } from '../services/authService';
import { WearableBluetoothClient } from '../services/bluetoothService';
import {
  playAlertTone,
  requestNotificationPermission,
  sendBrowserNotification,
} from '../services/alertAudio';
import {
  buildOfflineSmsUri,
  createLiveTrackingSession,
  dispatchAutomaticSosAlerts,
  fetchServerConfigStatus,
  loadEventHistory,
  saveEventHistory,
  stopLiveTrackingSession,
  updateLiveTrackingSession,
  type ServerConfigStatus,
} from '../services/sosService';
import type {
  AlertChannel,
  AuthUser,
  DispatchDeliveryResult,
  EmergencyContact,
  HeartRateAlert,
  HeartRateSample,
  LocationTrailPoint,
  SosEventRecord,
  VibrationPattern,
} from '../types/wearable';
import { BrandLogo } from './BrandLogo';
import { HeartRateChart } from './HeartRateChart';
import { EventHistory } from './EventHistory';
import { Snackbar } from './Snackbar';

const CONTACTS_STORAGE_KEY = 'safewear_emergency_contacts_v1';
const SOS_CANCEL_WINDOW_SECONDS = 6; // 5 to 7-second cancel window
const LIVE_UPDATE_INTERVAL_MS = 5000; // Continuously push live coordinates every 5s while SOS is active
const DEFAULT_HIGH_BPM = 120;
const DEFAULT_LOW_BPM = 45;

interface DashboardProps {
  user: AuthUser;
}

interface DashboardCardProps {
  title: string;
  icon: React.ReactNode;
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
}

const DashboardCard: React.FC<DashboardCardProps> = ({
  title,
  icon,
  rightSlot,
  children,
}) => (
  <div className="w-full rounded-[18px] border border-white/10 bg-[#17243A] p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <span className="text-[#448AFF] shrink-0">{icon}</span>
        <h2 className="text-[17px] font-bold text-white whitespace-nowrap">
          {title}
        </h2>
      </div>
      {rightSlot}
    </div>
    <div className="mt-4">{children}</div>
  </div>
);

interface SensorCardProps {
  title: string;
  value: string;
  subtitle?: string;
  valueClassName?: string;
  icon: React.ReactNode;
}

const SensorCard: React.FC<SensorCardProps> = ({
  title,
  value,
  subtitle,
  valueClassName = 'text-white',
  icon,
}) => (
  <div className="w-full rounded-[16px] border border-white/10 bg-[#17243A] p-4">
    <div>{icon}</div>
    <p className="mt-3 text-sm text-white/60">{title}</p>
    <p className={`mt-1 text-[17px] font-bold tabular-nums ${valueClassName}`}>
      {value}
    </p>
    {subtitle && <p className="mt-1 text-xs text-white/50">{subtitle}</p>}
  </div>
);

const SMS_ONLY_MIGRATION_KEY = 'safewear_sms_only_v1';

function loadStoredContacts(): EmergencyContact[] {
  try {
    const raw = localStorage.getItem(CONTACTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Partial<EmergencyContact>>;
    if (!Array.isArray(parsed)) return [];
    const needsMigration = !localStorage.getItem(SMS_ONLY_MIGRATION_KEY);
    const mapped: EmergencyContact[] = parsed
      .filter((c) => c.id && c.name && c.phone)
      .map((c) => ({
        id: String(c.id),
        name: String(c.name),
        phone: String(c.phone),
        channel:
          needsMigration && (!c.channel || c.channel === 'both')
            ? 'sms'
            : c.channel || 'sms',
      }));
    if (needsMigration) {
      localStorage.setItem(SMS_ONLY_MIGRATION_KEY, '1');
      localStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(mapped));
    }
    return mapped;
  } catch {
    return [];
  }
}

function formatElapsedMs(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms / 1000));
  const hrs = Math.floor(clamped / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

const PATTERN_LABEL: Record<VibrationPattern, string> = {
  idle: 'Idle',
  sos_started: 'SOS Started (Rapid pulse)',
  sos_cancelled: 'SOS Cancelled (Double tap)',
  sos_sent: 'SOS Sent (Long + double confirm)',
  hr_alert: 'Heart Rate Alert',
};

const CHANNEL_LABEL: Record<AlertChannel, string> = {
  both: 'WhatsApp + SMS',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
};

export const Dashboard: React.FC<DashboardProps> = ({ user }) => {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'history'>(
    'dashboard'
  );

  // Network & Server status
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [serverConfig, setServerConfig] = useState<ServerConfigStatus>({
    twilioSmsConfigured: false,
    twilioWhatsappConfigured: false,
  });

  // BLE Connection state
  const [isScanning, setIsScanning] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [deviceName, setDeviceName] = useState('Not connected');

  // SOS & Continuous Live Tracking state
  const [sosActive, setSosActive] = useState(false);
  const [sosConfirmed, setSosConfirmed] = useState(false);
  const [countdown, setCountdown] = useState(SOS_CANCEL_WINDOW_SECONDS);
  const [sosDispatchedAt, setSosDispatchedAt] = useState<string | null>(null);
  const [activeTrackingUrl, setActiveTrackingUrl] = useState<string | null>(
    null
  );
  const [trackingStartedAt, setTrackingStartedAt] = useState<number | null>(
    null
  );
  const [trackingElapsedMs, setTrackingElapsedMs] = useState(0);
  const [deliveryResults, setDeliveryResults] = useState<
    DispatchDeliveryResult[]
  >([]);
  const [usedOfflineFallback, setUsedOfflineFallback] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  // Sensor & Chart state
  const [heartRate, setHeartRate] = useState(0);
  const [heartRateHistory, setHeartRateHistory] = useState<HeartRateSample[]>(
    []
  );
  const [highBpmThreshold, setHighBpmThreshold] = useState(DEFAULT_HIGH_BPM);
  const [heartRateAlert, setHeartRateAlert] = useState<HeartRateAlert | null>(
    null
  );
  const [pendantWorn, setPendantWorn] = useState<boolean | null>(null);
  const [vibrationStatus, setVibrationStatus] = useState(false);
  const [vibrationPattern, setVibrationPattern] =
    useState<VibrationPattern>('idle');

  // Location & Trail state
  const [locationText, setLocationText] = useState('Location not fetched');
  const [lastCoords, setLastCoords] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [locationTrail, setLocationTrail] = useState<LocationTrailPoint[]>([]);

  // Contacts & Event History
  const [contacts, setContacts] =
    useState<EmergencyContact[]>(loadStoredContacts);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactChannel, setContactChannel] = useState<AlertChannel>('sms');
  const [pendingSmsUri, setPendingSmsUri] = useState<string | null>(null);
  const [eventHistory, setEventHistory] =
    useState<SosEventRecord[]>(loadEventHistory);

  // Snackbar state
  const [snackbarMessage, setSnackbarMessage] = useState<string | null>(null);

  // Refs for fresh state inside BLE listeners & timers
  const bluetoothClientRef = useRef<WearableBluetoothClient>(
    new WearableBluetoothClient()
  );
  const sosTimerRef = useRef<number | null>(null);
  const liveTrackTimerRef = useRef<number | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const sosActiveRef = useRef(false);
  const sosConfirmedRef = useRef(false);
  const sosStartedAtRef = useRef(0);
  const countdownRef = useRef(SOS_CANCEL_WINDOW_SECONDS);
  const heartRateRef = useRef(0);
  const pendantWornRef = useRef<boolean | null>(null);
  const lastCoordsRef = useRef<{ latitude: number; longitude: number } | null>(
    null
  );
  const highBpmThresholdRef = useRef(DEFAULT_HIGH_BPM);
  const lastHrAlertTimeRef = useRef(0);
  const contactsRef = useRef<EmergencyContact[]>(contacts);
  const snackbarTimerRef = useRef<number | null>(null);

  const wearerName = user.displayName || user.email || 'SafeWear Wearer';

  useEffect(() => {
    highBpmThresholdRef.current = highBpmThreshold;
  }, [highBpmThreshold]);

  useEffect(() => {
    heartRateRef.current = heartRate;
  }, [heartRate]);

  useEffect(() => {
    pendantWornRef.current = pendantWorn;
  }, [pendantWorn]);

  useEffect(() => {
    lastCoordsRef.current = lastCoords;
  }, [lastCoords]);

  useEffect(() => {
    contactsRef.current = contacts;
    try {
      localStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(contacts));
    } catch {
      // Ignore storage errors
    }
  }, [contacts]);

  useEffect(() => {
    saveEventHistory(eventHistory);
  }, [eventHistory]);

  // Monitor online/offline status & Twilio server config
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    void fetchServerConfigStatus().then(setServerConfig);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Update continuous live tracking elapsed timer (never expires until SOS is cancelled)
  useEffect(() => {
    if (!trackingStartedAt || !sosConfirmed) {
      setTrackingElapsedMs(0);
      return;
    }

    const updateTick = () => {
      setTrackingElapsedMs(Math.max(0, Date.now() - trackingStartedAt));
    };

    updateTick();
    const id = window.setInterval(updateTick, 1000);
    return () => window.clearInterval(id);
  }, [trackingStartedAt, sosConfirmed]);

  const showMessage = useCallback((message: string) => {
    setSnackbarMessage(message);
    if (snackbarTimerRef.current !== null) {
      window.clearTimeout(snackbarTimerRef.current);
    }
    snackbarTimerRef.current = window.setTimeout(() => {
      setSnackbarMessage(null);
    }, 5000);
  }, []);

  const appendEventRecord = useCallback((record: Omit<SosEventRecord, 'id' | 'timestamp' | 'isoTime'>) => {
    const now = new Date();
    const full: SosEventRecord = {
      id: `evt_${now.getTime()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: now.toLocaleString(),
      isoTime: now.toISOString(),
      ...record,
    };
    setEventHistory((prev) => [full, ...prev].slice(0, 100));
  }, []);

  const fetchPosition = useCallback(
    async (recordInTrail: boolean): Promise<LocationTrailPoint | null> => {
      if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
        setLocationText('Location services not supported in this browser');
        return null;
      }

      const requestFix = (highAccuracy: boolean, timeout: number, maximumAge: number) =>
        new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: highAccuracy,
            timeout,
            maximumAge,
          });
        });

      try {
        let position: GeolocationPosition;
        try {
          // Stage 1: Try high-accuracy GPS first
          position = await requestFix(true, 7000, 15000);
        } catch (firstErr) {
          const geoErr = firstErr as GeolocationPositionError;
          if (geoErr && geoErr.code === geoErr.PERMISSION_DENIED) {
            throw firstErr;
          }
          // Stage 2: Automatic fast network/Wi-Fi location fallback (fixes indoor timeouts)
          position = await requestFix(false, 12000, 60000);
        }

        const point: LocationTrailPoint = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: Math.round(position.coords.accuracy),
          heartRate: heartRateRef.current,
          timestamp: new Date().toLocaleTimeString(),
        };
        setLastCoords({
          latitude: point.latitude,
          longitude: point.longitude,
        });
        setLocationText(
          `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`
        );
        if (recordInTrail) {
          setLocationTrail((prev) => [point, ...prev].slice(0, 60));
        }
        return point;
      } catch (err) {
        const geoErr = err as GeolocationPositionError | undefined;
        if (geoErr && geoErr.code === geoErr.PERMISSION_DENIED) {
          setLocationText('Location permission blocked (allow in Chrome site settings)');
        } else if (geoErr && geoErr.code === geoErr.POSITION_UNAVAILABLE) {
          setLocationText('Turn on phone GPS / Location services and retry');
        } else if (lastCoordsRef.current) {
          setLocationText(
            `${lastCoordsRef.current.latitude.toFixed(5)}, ${lastCoordsRef.current.longitude.toFixed(5)} (cached)`
          );
        } else {
          setLocationText('GPS timed out — step near a window or turn on Location');
        }
        return null;
      }
    },
    []
  );

  const getCurrentLocation = useCallback(async () => {
    setLocationText('Fetching location...');
    const pt = await fetchPosition(false);
    if (pt) {
      showMessage(`Location updated: ${pt.latitude.toFixed(5)}, ${pt.longitude.toFixed(5)}`);
    }
  }, [fetchPosition, showMessage]);

  const handleSendLocationNow = useCallback(async () => {
    if (contactsRef.current.length === 0) {
      showMessage('Add at least one emergency contact first.');
      return;
    }
    setLocationText('Fetching location...');
    const pt = await fetchPosition(false);
    const lat = pt?.latitude ?? lastCoordsRef.current?.latitude ?? null;
    const lng = pt?.longitude ?? lastCoordsRef.current?.longitude ?? null;

    if (lat === null || lng === null) {
      showMessage('Could not get GPS fix yet. Check phone Location permission.');
      return;
    }

    if (!navigator.onLine) {
      const sms = buildOfflineSmsUri({
        wearerName,
        heartRate: heartRateRef.current,
        latitude: lat,
        longitude: lng,
        isOffline: true,
        contacts: contactsRef.current,
      });
      if (sms) {
        setPendingSmsUri(sms.uri);
        window.location.href = sms.uri;
      }
      return;
    }

    try {
      const created = await createLiveTrackingSession({
        wearerName,
        heartRate: heartRateRef.current,
        pendantWorn: pendantWornRef.current,
        latitude: lat,
        longitude: lng,
        accuracy: pt?.accuracy,
      });
      setActiveTrackingUrl(created.trackingUrl);
      setTrackingStartedAt(created.createdAt);

      const dispatch = await dispatchAutomaticSosAlerts({
        wearerName,
        heartRate: heartRateRef.current,
        latitude: lat,
        longitude: lng,
        trackingUrl: created.trackingUrl,
        contacts: contactsRef.current,
      });

      setDeliveryResults(dispatch.results);
      sendBrowserNotification(
        'SafeWear Location Shared',
        'Live location link & heart rate prepared for your emergency contacts.'
      );
      if (dispatch.dispatched) {
        setPendingSmsUri(null);
        showMessage(`Location alert sent to ${dispatch.sentCount} contact(s).`);
      } else {
        const sms = buildOfflineSmsUri({
          wearerName,
          heartRate: heartRateRef.current,
          latitude: lat,
          longitude: lng,
          trackingUrl: created.trackingUrl,
          isOffline: false,
          contacts: contactsRef.current,
        });
        if (sms) {
          setPendingSmsUri(sms.uri);
          setUsedOfflineFallback(true);
          showMessage('Opening Phone SMS with your live location & heart rate.');
          window.location.href = sms.uri;
        }
      }
    } catch {
      const sms = buildOfflineSmsUri({
        wearerName,
        heartRate: heartRateRef.current,
        latitude: lat,
        longitude: lng,
        isOffline: true,
        contacts: contactsRef.current,
      });
      if (sms) {
        setPendingSmsUri(sms.uri);
        window.location.href = sms.uri;
      }
    }
  }, [fetchPosition, showMessage, wearerName]);

  const stopLiveTrackingLoop = useCallback(() => {
    if (liveTrackTimerRef.current !== null) {
      window.clearInterval(liveTrackTimerRef.current);
      liveTrackTimerRef.current = null;
    }
    if (activeSessionIdRef.current) {
      void stopLiveTrackingSession(activeSessionIdRef.current);
      activeSessionIdRef.current = null;
    }
    setTrackingStartedAt(null);
  }, []);

  const confirmSOS = useCallback(async () => {
    sosActiveRef.current = false;
    sosConfirmedRef.current = true;
    setSosActive(false);
    setSosConfirmed(true);
    setSosDispatchedAt(new Date().toLocaleTimeString());
    setDeliveryResults([]);
    setUsedOfflineFallback(false);

    playAlertTone('sos');

    // Tell ESP32-C3 to play the distinct "SOS Sent" vibration pattern
    setVibrationPattern('sos_sent');
    void bluetoothClientRef.current.sendCommand({ cmd: 'sos_sent' });

    const point = await fetchPosition(true);
    const lat = point?.latitude ?? lastCoordsRef.current?.latitude ?? null;
    const lng = point?.longitude ?? lastCoordsRef.current?.longitude ?? null;
    const currentHr = heartRateRef.current;
    const currentContacts = contactsRef.current;

    // OFFLINE FALLBACK: No internet -> launch native SMS immediately
    if (!navigator.onLine) {
      setUsedOfflineFallback(true);
      const fallback = buildOfflineSmsUri({
        wearerName,
        heartRate: currentHr,
        latitude: lat,
        longitude: lng,
        isOffline: true,
        contacts: currentContacts,
      });

      if (fallback) {
        setPendingSmsUri(fallback.uri);
        window.location.href = fallback.uri;
      }

      const summary =
        currentContacts.length > 0
          ? `Offline detected: triggered native SMS fallback to ${currentContacts.length} contact(s).`
          : 'Offline detected: SOS logged locally (no emergency contacts configured).';

      appendEventRecord({
        outcome: 'offline_sms',
        heartRate: currentHr,
        latitude: lat,
        longitude: lng,
        deliverySummary: summary,
      });

      showMessage(summary);
      return;
    }

    // ONLINE: 1) Create continuous Live Tracking Link (stays active until SOS is cancelled)
    let trackingUrl: string | undefined;
    let sessionId: string | null = null;

    try {
      const created = await createLiveTrackingSession({
        wearerName,
        heartRate: currentHr,
        pendantWorn: pendantWornRef.current,
        latitude: lat ?? undefined,
        longitude: lng ?? undefined,
        accuracy: point?.accuracy,
      });
      trackingUrl = created.trackingUrl;
      sessionId = created.sessionId;
      activeSessionIdRef.current = sessionId;
      setActiveTrackingUrl(trackingUrl);
      setTrackingStartedAt(created.createdAt);

      // Continuously stream live GPS + HR updates until SOS is cancelled
      if (liveTrackTimerRef.current !== null) {
        window.clearInterval(liveTrackTimerRef.current);
      }
      liveTrackTimerRef.current = window.setInterval(async () => {
        if (!activeSessionIdRef.current || !sosConfirmedRef.current) {
          if (liveTrackTimerRef.current !== null) {
            window.clearInterval(liveTrackTimerRef.current);
            liveTrackTimerRef.current = null;
          }
          return;
        }
        const nextPt = await fetchPosition(true);
        try {
          await updateLiveTrackingSession(activeSessionIdRef.current, {
            latitude: nextPt?.latitude,
            longitude: nextPt?.longitude,
            accuracy: nextPt?.accuracy,
            heartRate: heartRateRef.current,
            pendantWorn: pendantWornRef.current,
          });
        } catch {
          // Continue retrying on next interval
        }
      }, LIVE_UPDATE_INTERVAL_MS);
    } catch {
      // If backend unreachable, drop into offline SMS fallback below
    }

    // ONLINE: 2) Dispatch emergency alerts to contacts
    if (currentContacts.length === 0) {
      const summary = trackingUrl
        ? 'Continuous live tracking link active until cancelled. Add emergency contacts to send alerts.'
        : 'SOS confirmed. Add emergency contacts to send location alerts.';
      appendEventRecord({
        outcome: 'sent',
        heartRate: currentHr,
        latitude: lat,
        longitude: lng,
        trackingUrl,
        deliverySummary: summary,
      });
      sendBrowserNotification('SafeWear SOS Active', summary);
      showMessage(summary);
      return;
    }

    try {
      const dispatch = await dispatchAutomaticSosAlerts({
        wearerName,
        heartRate: currentHr,
        latitude: lat,
        longitude: lng,
        trackingUrl,
        contacts: currentContacts,
      });

      setDeliveryResults(dispatch.results);

      let smsFallbackUri: string | null = null;
      if (!dispatch.dispatched) {
        const smsFallback = buildOfflineSmsUri({
          wearerName,
          heartRate: currentHr,
          latitude: lat,
          longitude: lng,
          trackingUrl,
          isOffline: false,
          contacts: currentContacts,
        });
        if (smsFallback) {
          smsFallbackUri = smsFallback.uri;
          setPendingSmsUri(smsFallback.uri);
          setUsedOfflineFallback(true);
          window.location.href = smsFallback.uri;
        }
      } else {
        setPendingSmsUri(null);
      }

      const summary = dispatch.dispatched
        ? `Live location alert sent to ${currentContacts.length} contact(s) — tracking active until cancelled.`
        : smsFallbackUri
          ? `Live location active until cancelled — Phone SMS ready for ${currentContacts.length} contact(s).`
          : 'Continuous live location tracking active until cancelled.';

      appendEventRecord({
        outcome: dispatch.dispatched ? 'sent' : 'offline_sms',
        heartRate: currentHr,
        latitude: lat,
        longitude: lng,
        trackingUrl,
        deliverySummary: summary,
        results: dispatch.results,
      });

      sendBrowserNotification(
        'SafeWear SOS Activated',
        dispatch.dispatched
          ? `Live location sent to ${currentContacts.length} contact(s). Tracking continuously until cancelled.`
          : 'Live location tracking active. Phone SMS prepared for your emergency contacts.'
      );
      showMessage(summary);
    } catch {
      // Network error during dispatch -> automatic Offline SMS fallback
      setUsedOfflineFallback(true);
      const fallback = buildOfflineSmsUri({
        wearerName,
        heartRate: currentHr,
        latitude: lat,
        longitude: lng,
        trackingUrl,
        isOffline: true,
        contacts: currentContacts,
      });
      if (fallback) {
        setPendingSmsUri(fallback.uri);
        window.location.href = fallback.uri;
      }
      const summary =
        'Network unreachable: switched to Offline SMS fallback automatically.';
      appendEventRecord({
        outcome: 'offline_sms',
        heartRate: currentHr,
        latitude: lat,
        longitude: lng,
        trackingUrl,
        deliverySummary: summary,
      });
      showMessage(summary);
    }
  }, [appendEventRecord, fetchPosition, showMessage, wearerName]);

  const cancelSOS = useCallback(
    (source: 'wearable' | 'app' = 'app') => {
      const wasPending = sosActiveRef.current;
      const wasConfirmed = sosConfirmedRef.current;
      // Ignore duplicate cancel packets when already idle
      if (!wasPending && !wasConfirmed) return;

      if (sosTimerRef.current !== null) {
        window.clearInterval(sosTimerRef.current);
        sosTimerRef.current = null;
      }
      stopLiveTrackingLoop();

      sosActiveRef.current = false;
      sosConfirmedRef.current = false;
      sosStartedAtRef.current = 0;
      countdownRef.current = SOS_CANCEL_WINDOW_SECONDS;
      setSosActive(false);
      setSosConfirmed(false);
      setSosDispatchedAt(null);
      setActiveTrackingUrl(null);
      setDeliveryResults([]);
      setUsedOfflineFallback(false);
      setPendingSmsUri(null);
      setCountdown(SOS_CANCEL_WINDOW_SECONDS);

      if (wasPending) {
        setVibrationPattern('sos_cancelled');
        if (source === 'app') {
          void bluetoothClientRef.current.sendCommand({ cmd: 'sos_cancelled' });
        }
        appendEventRecord({
          outcome: 'cancelled',
          heartRate: heartRateRef.current,
          latitude: lastCoordsRef.current?.latitude ?? null,
          longitude: lastCoordsRef.current?.longitude ?? null,
          deliverySummary: `SOS cancelled within 6-second window (${source === 'wearable' ? '2nd tactile click' : 'app button'}).`,
        });
      } else if (wasConfirmed) {
        setVibrationPattern('idle');
      }

      playAlertTone('cancel');
      showMessage(wasConfirmed ? 'SOS & continuous live tracking stopped.' : 'SOS cancelled.');
    },
    [appendEventRecord, showMessage, stopLiveTrackingLoop]
  );

  const startSOSCountdown = useCallback(() => {
    if (sosActiveRef.current || sosConfirmedRef.current) return;

    sosActiveRef.current = true;
    sosStartedAtRef.current = Date.now();
    countdownRef.current = SOS_CANCEL_WINDOW_SECONDS;
    setSosActive(true);
    setCountdown(SOS_CANCEL_WINDOW_SECONDS);
    setLocationTrail([]);
    setVibrationPattern('sos_started');

    playAlertTone('sos');
    showMessage(
      `SOS Activated! Press button again within ${SOS_CANCEL_WINDOW_SECONDS}s to cancel.`
    );

    if (sosTimerRef.current !== null) {
      window.clearInterval(sosTimerRef.current);
    }

    sosTimerRef.current = window.setInterval(() => {
      if (countdownRef.current <= 1) {
        if (sosTimerRef.current !== null) {
          window.clearInterval(sosTimerRef.current);
          sosTimerRef.current = null;
        }
        void confirmSOS();
      } else {
        countdownRef.current -= 1;
        setCountdown(countdownRef.current);
      }
    }, 1000);
  }, [confirmSOS, showMessage]);

  const triggerHeartRateAlert = useCallback(
    (bpm: number, reason: 'high' | 'low') => {
      const now = Date.now();
      if (now - lastHrAlertTimeRef.current < 8000) return;
      lastHrAlertTimeRef.current = now;

      const alert: HeartRateAlert = {
        bpm,
        reason,
        timestamp: new Date().toLocaleTimeString(),
      };
      setHeartRateAlert(alert);
      playAlertTone('heart');

      const alertMsg =
        reason === 'high'
          ? `Abnormal heart rate spike detected: ${bpm} BPM`
          : `Abnormally low heart rate detected: ${bpm} BPM`;

      appendEventRecord({
        outcome: 'hr_alert',
        heartRate: bpm,
        latitude: lastCoordsRef.current?.latitude ?? null,
        longitude: lastCoordsRef.current?.longitude ?? null,
        deliverySummary: alertMsg,
      });

      sendBrowserNotification('SafeWear Heart Rate Alert', alertMsg);
      showMessage(alertMsg);
    },
    [appendEventRecord, showMessage]
  );

  // Process JSON telemetry from ESP32-C3 SuperMini
  const processWearableData = useCallback(
    (message: string) => {
      try {
        const data = JSON.parse(message) as Record<string, unknown>;
        if (!data || typeof data !== 'object' || Array.isArray(data)) return;

        switch (data.type) {
          case 'sos':
            if (data.value === 'pressed') {
              if (sosActiveRef.current) {
                // Guard against sub-350ms contact bounce on Click #1; any Click #2 cancels SOS
                if (Date.now() - sosStartedAtRef.current >= 350) {
                  cancelSOS('wearable');
                }
              } else {
                startSOSCountdown();
              }
            }
            break;

          case 'cancel':
            if (sosActiveRef.current) {
              cancelSOS('wearable');
            }
            break;

          case 'ppg':
            if (typeof data.bpm === 'number' && !Number.isNaN(data.bpm)) {
              const bpm = Math.round(data.bpm);
              setHeartRate(bpm);
              const now = Date.now();
              setHeartRateHistory((prev) => [
                ...prev.slice(-29),
                {
                  bpm,
                  timestamp: now,
                  time: new Date(now).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  }),
                },
              ]);

              if (bpm > 0 && bpm >= highBpmThresholdRef.current) {
                triggerHeartRateAlert(bpm, 'high');
              } else if (bpm > 0 && bpm <= DEFAULT_LOW_BPM) {
                triggerHeartRateAlert(bpm, 'low');
              }
            }
            break;

          case 'hr_alert':
            if (typeof data.bpm === 'number' && !Number.isNaN(data.bpm)) {
              const bpm = Math.round(data.bpm);
              setHeartRate(bpm);
              const reason = data.reason === 'low' ? 'low' : 'high';
              triggerHeartRateAlert(bpm, reason);
            }
            break;

          case 'magnetic': {
            const worn = data.state === 'detected' || data.state === 'worn';
            setPendantWorn(worn);
            break;
          }

          case 'vibration': {
            const on = data.state === 'on';
            setVibrationStatus(on);
            if (typeof data.pattern === 'string') {
              setVibrationPattern(data.pattern as VibrationPattern);
            } else if (!on && !sosActiveRef.current) {
              setVibrationPattern('idle');
            }
            break;
          }
        }
      } catch {
        console.debug('Invalid wearable message:', message);
      }
    },
    [cancelSOS, startSOSCountdown, triggerHeartRateAlert]
  );

  const scanForWearable = async () => {
    if (!WearableBluetoothClient.isSupported()) {
      showMessage(
        'Bluetooth is not supported in this browser. Open SafeWear in Chrome or Edge.'
      );
      return;
    }

    await requestNotificationPermission();
    setIsScanning(true);

    try {
      const { deviceName: connectedName } =
        await bluetoothClientRef.current.scanAndConnect({
          onData: processWearableData,
          onDisconnected: () => {
            setIsConnected(false);
            setDeviceName('Not connected');
            setVibrationStatus(false);
            setVibrationPattern('idle');
          },
        });

      setIsConnected(true);
      setIsScanning(false);
      setDeviceName(connectedName);
      showMessage(`Connected to ${connectedName}!`);
    } catch (error) {
      setIsScanning(false);
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        return;
      }
      if (error instanceof DOMException && error.name === 'SecurityError') {
        showMessage(
          'Bluetooth blocked inside embedded preview. Open the app URL directly in a Chrome tab.'
        );
        return;
      }
      showMessage(
        `Bluetooth scan failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const disconnectWearable = async () => {
    if (sosTimerRef.current !== null) {
      window.clearInterval(sosTimerRef.current);
      sosTimerRef.current = null;
    }
    stopLiveTrackingLoop();

    await bluetoothClientRef.current.disconnect();

    setIsConnected(false);
    setIsScanning(false);
    setDeviceName('Not connected');
    setVibrationStatus(false);
    setVibrationPattern('idle');
  };

  const handleLogout = async () => {
    await disconnectWearable();
    await signOutAuth();
  };

  const handleAddContact = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = contactName.trim();
    const trimmedPhone = contactPhone.trim();
    if (!trimmedName || !trimmedPhone) {
      showMessage('Enter both contact name and phone number (include country code, e.g. +91...).');
      return;
    }

    const newContact: EmergencyContact = {
      id: `${Date.now()}`,
      name: trimmedName,
      phone: trimmedPhone,
      channel: contactChannel,
    };
    setContacts((prev) => [...prev, newContact]);
    setContactName('');
    setContactPhone('');
    showMessage(`Added ${trimmedName} (${CHANNEL_LABEL[contactChannel]}).`);
  };

  const handleRemoveContact = (id: string) => {
    setContacts((prev) => prev.filter((c) => c.id !== id));
  };

  const handleUpdateContactChannel = (id: string, channel: AlertChannel) => {
    setContacts((prev) =>
      prev.map((c) => (c.id === id ? { ...c, channel } : c))
    );
    showMessage(`Alert channel set to ${CHANNEL_LABEL[channel]}.`);
  };

  const handleCopyTrackingLink = async () => {
    if (!activeTrackingUrl) return;
    try {
      await navigator.clipboard.writeText(activeTrackingUrl);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      showMessage('Unable to copy link.');
    }
  };

  const handleManualOfflineSms = () => {
    const fallback = buildOfflineSmsUri({
      wearerName,
      heartRate: heartRateRef.current,
      latitude: lastCoords?.latitude ?? null,
      longitude: lastCoords?.longitude ?? null,
      trackingUrl: activeTrackingUrl ?? undefined,
      isOffline: !navigator.onLine,
      contacts,
    });
    if (!fallback) {
      showMessage('Add at least one emergency contact first.');
      return;
    }
    setPendingSmsUri(fallback.uri);
    window.location.href = fallback.uri;
  };

  useEffect(() => {
    const client = bluetoothClientRef.current;
    return () => {
      if (sosTimerRef.current !== null) {
        window.clearInterval(sosTimerRef.current);
      }
      if (liveTrackTimerRef.current !== null) {
        window.clearInterval(liveTrackTimerRef.current);
      }
      if (snackbarTimerRef.current !== null) {
        window.clearTimeout(snackbarTimerRef.current);
      }
      void client.disconnect();
    };
  }, []);

  const isHeartRateAbnormal =
    heartRate > 0 &&
    (heartRate >= highBpmThreshold || heartRate <= DEFAULT_LOW_BPM);

  const pendantLabel =
    pendantWorn === null
      ? 'Waiting for sensor'
      : pendantWorn
        ? 'Pendant Worn'
        : 'Pendant Not Worn';

  const pendantColorClass =
    pendantWorn === null
      ? 'text-white/70'
      : pendantWorn
        ? 'text-[#69F0AE]'
        : 'text-[#FF9800]';

  const anyTwilioReady =
    serverConfig.twilioSmsConfigured || serverConfig.twilioWhatsappConfigured;

  return (
    <div className="min-h-screen bg-[#0B1220] text-white flex flex-col">
      {/* Top Bar: Responsive mobile-safe header */}
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#111D32] pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-14 sm:h-16 max-w-5xl items-center justify-between gap-3 sm:gap-6 px-3 sm:px-5">
          {/* Zone 1: Brand with custom uploaded logo */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <BrandLogo size="sm" />
            <span className="text-base sm:text-lg font-bold tracking-tight text-white whitespace-nowrap">
              SafeWear
            </span>
          </div>

          {/* Zone 2: Navigation links */}
          <nav className="flex items-center gap-3.5 sm:gap-6 text-xs sm:text-sm font-medium">
            <button
              type="button"
              onClick={() => setActiveTab('dashboard')}
              className={`py-1 transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                activeTab === 'dashboard'
                  ? 'text-white border-b-2 border-[#5796F5]'
                  : 'text-white/60 hover:text-white'
              }`}
            >
              Dashboard
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('history')}
              className={`py-1 transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                activeTab === 'history'
                  ? 'text-white border-b-2 border-[#5796F5]'
                  : 'text-white/60 hover:text-white'
              }`}
            >
              History ({eventHistory.length})
            </button>
          </nav>

          {/* Zone 3: Sign out */}
          <button
            type="button"
            onClick={handleLogout}
            title="Logout"
            aria-label="Logout"
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-2.5 sm:px-3 py-1.5 text-xs font-medium text-white/85 hover:bg-white/10 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto w-full max-w-5xl flex-1 p-5 sm:p-6">
        {/* Offline Banner */}
        {!isOnline && (
          <div className="mb-5 flex items-center justify-between gap-3 rounded-[16px] border border-amber-500/40 bg-amber-500/10 p-4">
            <div className="flex items-center gap-3">
              <WifiOff className="h-5 w-5 shrink-0 text-amber-400" />
              <p className="text-sm text-amber-200">
                You are offline. If SOS triggers, SafeWear will automatically
                switch to native SMS fallback with your GPS coordinates and
                heart rate.
              </p>
            </div>
          </div>
        )}

        {/* Abnormal Heart Rate Alert Banner */}
        {heartRateAlert && (
          <div className="mb-5 flex items-start justify-between gap-3 rounded-[16px] border border-red-500/40 bg-red-500/15 p-4">
            <div className="flex items-start gap-3">
              <BellRing className="mt-0.5 h-6 w-6 shrink-0 text-red-400 animate-pulse" />
              <div>
                <p className="text-sm font-bold text-red-300">
                  {heartRateAlert.reason === 'high'
                    ? 'Abnormal Heart Rate Spike Alert'
                    : 'Abnormal Low Heart Rate Alert'}
                </p>
                <p className="mt-0.5 text-sm text-white">
                  Detected{' '}
                  <span className="font-mono font-bold tabular-nums">
                    {heartRateAlert.bpm} BPM
                  </span>{' '}
                  at {heartRateAlert.timestamp}. Logged in Event History.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setHeartRateAlert(null)}
              aria-label="Dismiss heart rate alert"
              className="rounded-full p-1 text-white/70 hover:bg-white/10 hover:text-white cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {activeTab === 'history' ? (
          <EventHistory
            events={eventHistory}
            onClearHistory={() => {
              setEventHistory([]);
              showMessage('Event history cleared.');
            }}
          />
        ) : (
          <div className="space-y-6">
            <div>
              <h1 className="text-2xl font-bold text-white">
                Your Safety Dashboard
              </h1>
              <p className="mt-1 text-sm text-white/60">
                BLE wearable SOS with continuous live location sharing until
                cancelled, SMS alerts, and live heart rate monitoring.
              </p>
            </div>

            {/* Top 2-Column Split: Connection + Emergency SOS */}
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 items-stretch">
              {/* Wearable Connection Card */}
              <DashboardCard
                title="Wearable Connection"
                icon={<Bluetooth className="h-5 w-5" />}
                rightSlot={
                  <span
                    className={`text-xs font-medium ${
                      isConnected ? 'text-[#69F0AE]' : 'text-[#FF9800]'
                    }`}
                  >
                    {isConnected ? 'Connected' : 'Disconnected'}
                  </span>
                }
              >
                <div className="flex h-full flex-col justify-between gap-4">
                  <div className="space-y-2 text-sm">
                    <p className="text-white/80">
                      Device:{' '}
                      <span className="font-mono font-medium text-white">
                        {deviceName}
                      </span>
                    </p>
                    <p className="text-xs text-white/55">
                      Alert delivery:{' '}
                      <span className="text-white/85">
                        {!isOnline
                          ? 'Offline Phone SMS Ready'
                          : anyTwilioReady
                            ? 'Continuous Live Link + SMS Alerts'
                            : 'Continuous Live Link + Phone SMS'}
                      </span>
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={
                      isConnected
                        ? disconnectWearable
                        : isScanning
                          ? undefined
                          : scanForWearable
                    }
                    disabled={!isConnected && isScanning}
                    className="w-full rounded-lg bg-[#1C2A44] py-2.5 px-4 text-sm font-semibold text-[#A8C7FA] hover:bg-[#243658] disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    {isConnected
                      ? 'Disconnect Wearable'
                      : isScanning
                        ? 'Scanning for SafeWear-ESP32...'
                        : 'Connect Wearable'}
                  </button>
                </div>
              </DashboardCard>

              {/* Emergency SOS Card */}
              <DashboardCard
                title="Emergency SOS"
                icon={<AlertTriangle className="h-5 w-5" />}
                rightSlot={
                  sosConfirmed ? (
                    <span className="font-mono text-xs font-semibold text-[#69F0AE] tabular-nums">
                      Live {formatElapsedMs(trackingElapsedMs)}
                    </span>
                  ) : null
                }
              >
                <div className="flex flex-col items-center text-center">
                  <div
                    className={`flex h-16 w-16 items-center justify-center rounded-full border-4 font-extrabold text-lg tracking-wider ${
                      sosConfirmed
                        ? 'border-[#F44336] bg-[#F44336]/20 text-[#FF5252]'
                        : sosActive
                          ? 'border-[#FF9800] text-[#FF9800]'
                          : 'border-[#FF5252] text-[#FF5252]'
                    }`}
                  >
                    SOS
                  </div>

                  <p className="mt-2.5 text-base font-bold text-white">
                    {sosConfirmed
                      ? 'SOS Active — Continuous Live Location On'
                      : sosActive
                        ? 'SOS Activated'
                        : 'System Ready'}
                  </p>

                  {sosActive ? (
                    <>
                      <p className="mt-1 text-xs text-white/70">
                        Press wearable button again within {countdown}s to
                        cancel
                      </p>
                      <p className="mt-2 font-mono text-3xl font-bold text-[#FF9800] tabular-nums">
                        {countdown}s
                      </p>
                      <button
                        type="button"
                        onClick={() => cancelSOS('app')}
                        className="mt-3 rounded-lg bg-[#F44336] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[#D32F2F] transition-colors cursor-pointer"
                      >
                        Cancel SOS
                      </button>
                    </>
                  ) : sosConfirmed ? (
                    <div className="mt-3 w-full space-y-3 text-left">
                      <p className="text-center text-xs text-white/70">
                        Triggered at {sosDispatchedAt} · Sharing location
                        continuously until cancelled
                      </p>

                      {activeTrackingUrl && (
                        <div className="rounded-lg border border-white/10 bg-[#111D32] p-3">
                          <p className="text-xs font-medium text-white/60">
                            Continuous Live Location Link
                          </p>
                          <div className="mt-1.5 flex items-center justify-between gap-2">
                            <a
                              href={activeTrackingUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="truncate font-mono text-xs text-[#69F0AE] hover:underline"
                            >
                              {activeTrackingUrl}
                            </a>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={handleCopyTrackingLink}
                                className="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-xs text-white/80 hover:bg-white/10 cursor-pointer"
                              >
                                {copiedLink ? (
                                  <Check className="h-3.5 w-3.5 text-[#69F0AE]" />
                                ) : (
                                  <Copy className="h-3.5 w-3.5" />
                                )}
                                {copiedLink ? 'Copied' : 'Copy'}
                              </button>
                              <a
                                href={activeTrackingUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-xs text-[#A8C7FA] hover:bg-white/10"
                              >
                                Open
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            </div>
                          </div>
                        </div>
                      )}

                      {deliveryResults.length > 0 && (
                        <div className="space-y-2">
                          {deliveryResults.map((res, idx) => {
                            const cleanDigits = res.phone.replace(/[^\d]/g, '');
                            const mapLink =
                              lastCoords !== null
                                ? `https://maps.google.com/?q=${lastCoords.latitude.toFixed(5)},${lastCoords.longitude.toFixed(5)}`
                                : locationText;
                            const backupText = encodeURIComponent(
                              `EMERGENCY SOS from ${wearerName} (SafeWear)\nHeart Rate: ${heartRate > 0 ? `${heartRate} BPM` : 'Reading'}\nLocation: ${mapLink}${activeTrackingUrl ? `\nLive Location Link: ${activeTrackingUrl}` : ''}`
                            );
                            const backupHref =
                              res.channel === 'whatsapp'
                                ? `https://wa.me/${cleanDigits}?text=${backupText}`
                                : `sms:${res.phone}?body=${backupText}`;

                            return (
                              <div
                                key={`${res.phone}-${res.channel}-${idx}`}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-[#111D32]/80 px-3 py-2 text-xs"
                              >
                                <span className="text-white/90 font-medium">
                                  {res.contactName} ·{' '}
                                  {res.channel === 'whatsapp'
                                    ? 'WhatsApp'
                                    : 'SMS'}
                                </span>
                                {res.status === 'sent' ? (
                                  <span className="text-[#69F0AE] font-semibold">
                                    Sent
                                  </span>
                                ) : (
                                  <a
                                    href={backupHref}
                                    target={
                                      res.channel === 'whatsapp'
                                        ? '_blank'
                                        : undefined
                                    }
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1.5 rounded bg-[#1C2A44] px-2.5 py-1 text-[11px] font-medium text-[#A8C7FA] hover:bg-[#243658]"
                                  >
                                    <MessageSquare className="h-3 w-3" />
                                    Send{' '}
                                    {res.channel === 'whatsapp'
                                      ? 'WhatsApp'
                                      : 'SMS'}
                                  </a>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                        {pendingSmsUri ? (
                          <a
                            href={pendingSmsUri}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-[#2E7D32] px-4 py-2 text-xs font-semibold text-white hover:bg-[#388E3C] cursor-pointer"
                          >
                            <MessageSquare className="h-3.5 w-3.5" />
                            Send SMS Now
                          </a>
                        ) : (
                          usedOfflineFallback && (
                            <button
                              type="button"
                              onClick={handleManualOfflineSms}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-[#2E7D32] px-4 py-2 text-xs font-semibold text-white hover:bg-[#388E3C] cursor-pointer"
                            >
                              <MessageSquare className="h-3.5 w-3.5" />
                              Send SMS Now
                            </button>
                          )
                        )}
                        <button
                          type="button"
                          onClick={() => cancelSOS('app')}
                          className="rounded-lg border border-white/25 px-4 py-2 text-xs font-medium text-white hover:bg-white/10 transition-colors cursor-pointer"
                        >
                          Stop SOS &amp; Live Tracking
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="pt-2 text-xs text-white/60">
                      Click button once to arm (6s cancel window). If not
                      cancelled, live location sharing stays active until you
                      stop SOS.
                    </p>
                  )}
                </div>
              </DashboardCard>
            </div>

            {/* Live Heart Rate Graph Card */}
            <DashboardCard
              title="Live Heart Rate Graph"
              icon={
                <Heart
                  className={`h-5 w-5 text-[#FF4081] ${
                    isHeartRateAbnormal ? 'animate-pulse' : ''
                  }`}
                />
              }
              rightSlot={
                <div className="flex items-center gap-2 text-xs text-white/60">
                  <span>Spike Alert</span>
                  <input
                    type="range"
                    min={80}
                    max={180}
                    step={5}
                    value={highBpmThreshold}
                    onChange={(e) =>
                      setHighBpmThreshold(Number(e.target.value))
                    }
                    aria-label="High heart rate threshold"
                    className="w-24 accent-[#5796F5] cursor-pointer"
                  />
                  <span className="font-mono font-semibold text-[#FF4081] tabular-nums">
                    {highBpmThreshold} BPM
                  </span>
                </div>
              }
            >
              <HeartRateChart
                samples={heartRateHistory}
                highThreshold={highBpmThreshold}
                lowThreshold={DEFAULT_LOW_BPM}
                currentBpm={heartRate}
              />
            </DashboardCard>

            {/* Sensor Status Strip */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <SensorCard
                title="Pendant Status (Hall)"
                value={pendantLabel}
                subtitle={
                  pendantWorn === null
                    ? 'Place magnet near sensor'
                    : pendantWorn
                      ? 'Magnet detected near sensor'
                      : 'Magnet removed from sensor'
                }
                valueClassName={pendantColorClass}
                icon={<Radio className="h-6 w-6 text-[#40C4FF]" />}
              />

              <SensorCard
                title="Vibration Pattern"
                value={vibrationStatus ? 'Motor Active' : 'Motor Idle'}
                subtitle={PATTERN_LABEL[vibrationPattern]}
                valueClassName={
                  vibrationStatus ? 'text-[#FFC107]' : 'text-white'
                }
                icon={<Vibrate className="h-6 w-6 text-[#FFC107]" />}
              />

              <SensorCard
                title="GPS Location"
                value={locationText}
                subtitle={
                  locationTrail.length > 0
                    ? `${locationTrail.length} trail updates recorded`
                    : 'Continuous live link & SMS ready'
                }
                icon={<MapPin className="h-6 w-6 text-[#5796F5]" />}
              />
            </div>

            {/* Bottom 2-Column Split: Emergency Contacts + Location Controls */}
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 items-start">
              {/* Emergency Contacts Card */}
              <DashboardCard
                title="Emergency Contacts (Auto-Send)"
                icon={<Users className="h-5 w-5" />}
              >
                <form
                  onSubmit={handleAddContact}
                  className="grid grid-cols-1 gap-2.5 sm:grid-cols-12"
                >
                  <input
                    type="text"
                    value={contactName}
                    onChange={(e) => setContactName(e.target.value)}
                    placeholder="Name"
                    className="sm:col-span-4 rounded-lg border border-white/20 bg-[#111D32] px-3 py-2 text-sm text-white placeholder-white/40 outline-none focus:border-[#5796F5]"
                  />
                  <input
                    type="tel"
                    value={contactPhone}
                    onChange={(e) => setContactPhone(e.target.value)}
                    placeholder="+91 9876543210"
                    className="sm:col-span-4 rounded-lg border border-white/20 bg-[#111D32] px-3 py-2 text-sm text-white placeholder-white/40 outline-none focus:border-[#5796F5]"
                  />
                  <select
                    value={contactChannel}
                    onChange={(e) =>
                      setContactChannel(e.target.value as AlertChannel)
                    }
                    aria-label="Alert delivery channel"
                    className="sm:col-span-4 rounded-lg border border-white/20 bg-[#111D32] px-2.5 py-2 text-xs text-white outline-none focus:border-[#5796F5]"
                  >
                    <option value="sms">SMS only</option>
                    <option value="whatsapp">WhatsApp only</option>
                    <option value="both">WhatsApp + SMS</option>
                  </select>
                  <button
                    type="submit"
                    className="sm:col-span-12 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#1C2A44] px-4 py-2 text-sm font-medium text-[#A8C7FA] hover:bg-[#243658] transition-colors cursor-pointer"
                  >
                    <Plus className="h-4 w-4" />
                    Add Emergency Contact
                  </button>
                </form>

                {contacts.length === 0 ? (
                  <p className="mt-3 text-xs text-white/55">
                    Add close contacts with international country code (e.g.
                    +91... or +1...). When SOS is active, SafeWear shares your
                    heart rate and continuous live location link until SOS is
                    cancelled.
                  </p>
                ) : (
                  <ul className="mt-3 divide-y divide-white/10">
                    {contacts.map((contact) => (
                      <li
                        key={contact.id}
                        className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-white truncate">
                            {contact.name}
                          </p>
                          <p className="text-xs text-white/60 font-mono tabular-nums">
                            {contact.phone}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <select
                            value={contact.channel}
                            onChange={(e) =>
                              handleUpdateContactChannel(
                                contact.id,
                                e.target.value as AlertChannel
                              )
                            }
                            aria-label={`Alert channel for ${contact.name}`}
                            className="rounded-md border border-white/15 bg-[#111D32] px-2 py-1 text-xs text-white/85 outline-none focus:border-[#5796F5]"
                          >
                            <option value="sms">SMS only</option>
                            <option value="whatsapp">WhatsApp only</option>
                            <option value="both">WhatsApp + SMS</option>
                          </select>
                          <button
                            type="button"
                            onClick={() => handleRemoveContact(contact.id)}
                            aria-label={`Remove ${contact.name}`}
                            className="rounded-lg p-1.5 text-white/50 hover:bg-white/10 hover:text-red-400 cursor-pointer"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </DashboardCard>

              {/* Location & Vibration Reference Card */}
              <DashboardCard
                title="Location & Pendant Feedback"
                icon={<Crosshair className="h-5 w-5" />}
              >
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs text-white/55">Current GPS Fix</p>
                      <p className="mt-0.5 font-mono text-sm text-white tabular-nums">
                        {locationText}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={getCurrentLocation}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 px-3 py-2 text-xs font-medium text-[#A8C7FA] hover:bg-white/5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <Crosshair className="h-3.5 w-3.5" />
                        Refresh GPS
                      </button>
                      <button
                        type="button"
                        onClick={handleSendLocationNow}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[#1C2A44] px-3 py-2 text-xs font-medium text-[#A8C7FA] hover:bg-[#243658] transition-colors cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <MapPin className="h-3.5 w-3.5" />
                        Send Location
                      </button>
                      {pendingSmsUri && (
                        <a
                          href={pendingSmsUri}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-[#2E7D32] px-3 py-2 text-xs font-semibold text-white hover:bg-[#388E3C] transition-colors cursor-pointer whitespace-nowrap shrink-0"
                        >
                          <MessageSquare className="h-3.5 w-3.5" />
                          Open SMS App
                        </a>
                      )}
                    </div>
                  </div>

                  <div className="border-t border-white/10 pt-3">
                    <p className="text-xs font-semibold text-white/75">
                      Pendant Vibration Patterns
                    </p>
                    <dl className="mt-2 space-y-1.5 text-xs">
                      <div className="flex justify-between gap-2">
                        <dt className="text-white/60">SOS Started (6s)</dt>
                        <dd className="font-mono text-amber-300">
                          Rapid 300ms pulses
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-white/60">SOS Cancelled</dt>
                        <dd className="font-mono text-white/80">
                          2 quick short taps
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-white/60">SOS Sent</dt>
                        <dd className="font-mono text-[#69F0AE]">
                          1 long buzz + 2 short taps
                        </dd>
                      </div>
                    </dl>
                  </div>
                </div>
              </DashboardCard>
            </div>
          </div>
        )}

        <footer className="mt-10 border-t border-white/10 pt-4 pb-6 text-center text-xs text-white/40">
          SafeWear · Personal Safety Wearable System
        </footer>
      </main>

      <Snackbar message={snackbarMessage} />
    </div>
  );
};
