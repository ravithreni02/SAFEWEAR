import type {
  BluetoothDeviceLike,
  BluetoothNavigatorLike,
  BluetoothRemoteGATTCharacteristicLike,
  BluetoothRemoteGATTServerLike,
} from '../types/wearable';

// Nordic UART Service UUIDs matching SafeWear ESP32-C3 SuperMini firmware
export const SAFEWEAR_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const SAFEWEAR_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
export const SAFEWEAR_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

const OPTIONAL_BLE_SERVICES = [
  SAFEWEAR_SERVICE_UUID,
  '4fafc201-1fb5-459e-8fcc-c5c9c331914b',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000180d-0000-1000-8000-00805f9b34fb',
  '0000180f-0000-1000-8000-00805f9b34fb',
];

interface CharacteristicSubscription {
  characteristic: BluetoothRemoteGATTCharacteristicLike;
  listener: EventListener;
}

export class WearableBluetoothClient {
  private device: BluetoothDeviceLike | null = null;
  private disconnectListener: EventListener | null = null;
  private subscriptions: CharacteristicSubscription[] = [];
  private rxCharacteristic: BluetoothRemoteGATTCharacteristicLike | null = null;
  private decoder = new TextDecoder('utf-8', { fatal: false });
  private encoder = new TextEncoder();

  static isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      'bluetooth' in navigator &&
      Boolean(
        (navigator as unknown as { bluetooth?: BluetoothNavigatorLike })
          .bluetooth
      )
    );
  }

  private async attachCharacteristics(
    server: BluetoothRemoteGATTServerLike,
    onData: (message: string) => void
  ): Promise<void> {
    const characteristicsToInspect: BluetoothRemoteGATTCharacteristicLike[] = [];

    // Prefer direct Nordic UART service lookup (most reliable across Windows/macOS/Android Chrome)
    const serverWithSingle = server as BluetoothRemoteGATTServerLike & {
      getPrimaryService?: (uuid: string) => Promise<{
        getCharacteristics: () => Promise<BluetoothRemoteGATTCharacteristicLike[]>;
      }>;
    };

    if (typeof serverWithSingle.getPrimaryService === 'function') {
      try {
        const nusService = await serverWithSingle.getPrimaryService(
          SAFEWEAR_SERVICE_UUID
        );
        const chars = await nusService.getCharacteristics();
        characteristicsToInspect.push(...chars);
      } catch {
        // Fall through to full primary service discovery
      }
    }

    if (characteristicsToInspect.length === 0) {
      const services = await server.getPrimaryServices();
      for (const service of services) {
        const chars = await service.getCharacteristics();
        characteristicsToInspect.push(...chars);
      }
    }

    for (const characteristic of characteristicsToInspect) {
      const uuid = characteristic.uuid.toLowerCase();

      if (
        (uuid === SAFEWEAR_RX_CHAR_UUID || !this.rxCharacteristic) &&
        (characteristic.properties.write ||
          characteristic.properties.writeWithoutResponse)
      ) {
        this.rxCharacteristic = characteristic;
      }

      if (
        characteristic.properties.notify ||
        characteristic.properties.indicate
      ) {
        await characteristic.startNotifications();

        const onValueChanged: EventListener = (event) => {
          const target =
            event.target as unknown as BluetoothRemoteGATTCharacteristicLike | null;
          const value = target?.value;
          if (!value || value.byteLength === 0) return;

          const bytes = new Uint8Array(
            value.buffer,
            value.byteOffset,
            value.byteLength
          );
          const raw = this.decoder.decode(bytes).trim();
          if (!raw) return;

          const lines = raw.split(/\r?\n/);
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              onData(trimmed);
            }
          }
        };

        characteristic.addEventListener(
          'characteristicvaluechanged',
          onValueChanged
        );
        this.subscriptions.push({
          characteristic,
          listener: onValueChanged,
        });
      }
    }
  }

  async scanAndConnect(params: {
    onData: (message: string) => void;
    onDisconnected: () => void;
  }): Promise<{ deviceName: string }> {
    const bluetooth = (
      navigator as unknown as { bluetooth?: BluetoothNavigatorLike }
    ).bluetooth;

    if (!bluetooth) {
      throw new Error(
        'Web Bluetooth is not supported here. Open this app in Chrome or Edge.'
      );
    }

    // Filter cleanly for SafeWear / ESP32 / Nordic UART Service so the board is easy to find
    const device = await bluetooth.requestDevice({
      filters: [
        { services: [SAFEWEAR_SERVICE_UUID] },
        { namePrefix: 'SafeWear' },
        { namePrefix: 'ESP32' },
        { namePrefix: 'Safety' },
      ],
      optionalServices: OPTIONAL_BLE_SERVICES,
    });

    if (!device.gatt) {
      throw new Error('Selected device does not expose a GATT server.');
    }

    const server = await device.gatt.connect();
    this.device = device;
    this.rxCharacteristic = null;

    const handleDisconnect: EventListener = () => {
      this.rxCharacteristic = null;
      void this.clearSubscriptions();
      params.onDisconnected();
    };

    this.disconnectListener = handleDisconnect;
    device.addEventListener('gattserverdisconnected', handleDisconnect);

    await this.attachCharacteristics(server, params.onData);

    return {
      deviceName:
        device.name && device.name.trim().length > 0
          ? device.name
          : 'SafeWear-ESP32',
    };
  }

  async sendCommand(payload: Record<string, unknown>): Promise<boolean> {
    if (!this.rxCharacteristic || !this.device?.gatt?.connected) {
      return false;
    }

    try {
      const encoded = this.encoder.encode(JSON.stringify(payload));
      if (
        this.rxCharacteristic.properties.writeWithoutResponse &&
        this.rxCharacteristic.writeValueWithoutResponse
      ) {
        await this.rxCharacteristic.writeValueWithoutResponse(encoded);
      } else if (this.rxCharacteristic.writeValue) {
        await this.rxCharacteristic.writeValue(encoded);
      } else {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    await this.clearSubscriptions();
    this.rxCharacteristic = null;

    if (this.device && this.disconnectListener) {
      this.device.removeEventListener(
        'gattserverdisconnected',
        this.disconnectListener
      );
      this.disconnectListener = null;
    }

    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }

    this.device = null;
  }

  private async clearSubscriptions(): Promise<void> {
    const active = [...this.subscriptions];
    this.subscriptions = [];

    for (const sub of active) {
      sub.characteristic.removeEventListener(
        'characteristicvaluechanged',
        sub.listener
      );
      try {
        await sub.characteristic.stopNotifications();
      } catch {
        // Ignore if already disconnected
      }
    }
  }
}
