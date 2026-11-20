export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
}

export interface UserProfile {
  uid: string;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

export type AlertChannel = 'both' | 'whatsapp' | 'sms';

export interface EmergencyContact {
  id: string;
  name: string;
  phone: string;
  channel: AlertChannel;
}

export interface LocationTrailPoint {
  latitude: number;
  longitude: number;
  accuracy?: number;
  heartRate?: number;
  timestamp: string;
}

export interface HeartRateSample {
  bpm: number;
  time: string;
  timestamp: number;
}

export interface HeartRateAlert {
  bpm: number;
  reason: 'high' | 'low';
  timestamp: string;
}

export type VibrationPattern =
  | 'idle'
  | 'sos_started'
  | 'sos_cancelled'
  | 'sos_sent'
  | 'hr_alert';

export type SosEventOutcome = 'sent' | 'cancelled' | 'offline_sms' | 'hr_alert';

export interface DispatchDeliveryResult {
  contactName: string;
  phone: string;
  channel: 'sms' | 'whatsapp';
  status: 'sent' | 'failed' | 'unconfigured';
  sid?: string;
  error?: string;
}

export interface SosEventRecord {
  id: string;
  timestamp: string;
  isoTime: string;
  outcome: SosEventOutcome;
  heartRate: number;
  latitude: number | null;
  longitude: number | null;
  trackingUrl?: string;
  deliverySummary: string;
  results?: DispatchDeliveryResult[];
}

export interface LiveTrackingSessionData {
  id: string;
  wearerName: string;
  createdAt: number;
  expiresAt: number | null;
  active: boolean;
  heartRate: number;
  pendantWorn: boolean | null;
  points: LocationTrailPoint[];
}

export type WearableMessage =
  | { type: 'sos'; value: string }
  | { type: 'ppg'; bpm: number }
  | { type: 'hr_alert'; bpm: number; reason?: 'high' | 'low' }
  | { type: 'magnetic'; state: string }
  | { type: 'vibration'; state: string; pattern?: VibrationPattern }
  | { type: 'cancel' };

// Minimal Web Bluetooth API typings for strict TypeScript builds
export interface BluetoothCharacteristicPropertiesLike {
  notify: boolean;
  indicate: boolean;
  write?: boolean;
  writeWithoutResponse?: boolean;
}

export interface BluetoothRemoteGATTCharacteristicLike extends EventTarget {
  uuid: string;
  properties: BluetoothCharacteristicPropertiesLike;
  value?: DataView | null;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike>;
  writeValue?(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
}

export interface BluetoothRemoteGATTServiceLike {
  uuid: string;
  getCharacteristics(): Promise<BluetoothRemoteGATTCharacteristicLike[]>;
}

export interface BluetoothRemoteGATTServerLike {
  connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServerLike>;
  disconnect(): void;
  getPrimaryServices(): Promise<BluetoothRemoteGATTServiceLike[]>;
}

export interface BluetoothDeviceLike extends EventTarget {
  id: string;
  name?: string;
  gatt?: BluetoothRemoteGATTServerLike;
}

export interface BluetoothNavigatorLike {
  requestDevice(options: {
    filters?: Array<{ namePrefix?: string; name?: string; services?: string[] }>;
    acceptAllDevices?: boolean;
    optionalServices?: string[];
  }): Promise<BluetoothDeviceLike>;
}
