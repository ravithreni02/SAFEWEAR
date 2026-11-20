// Zero-dependency Web Audio API alert tones & optional browser notifications

export function playAlertTone(kind: 'sos' | 'heart' | 'cancel'): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const scheduleBeep = (
      startOffset: number,
      duration: number,
      freq: number,
      gainLevel = 0.25
    ) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = kind === 'cancel' ? 'sine' : 'square';
      osc.frequency.setValueAtTime(freq, now + startOffset);
      gain.gain.setValueAtTime(gainLevel, now + startOffset);
      gain.gain.exponentialRampToValueAtTime(
        0.001,
        now + startOffset + duration
      );
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + duration);
    };

    if (kind === 'sos') {
      scheduleBeep(0, 0.18, 880, 0.22);
      scheduleBeep(0.24, 0.18, 880, 0.22);
      scheduleBeep(0.48, 0.28, 1046, 0.25);
    } else if (kind === 'heart') {
      scheduleBeep(0, 0.15, 740, 0.22);
      scheduleBeep(0.22, 0.25, 988, 0.22);
    } else {
      scheduleBeep(0, 0.14, 523, 0.18);
    }

    window.setTimeout(() => {
      void ctx.close();
    }, 1200);
  } catch {
    // Ignore audio context autoplay restrictions
  }
}

export function sendBrowserNotification(title: string, body: string): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}

export async function requestNotificationPermission(): Promise<void> {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch {
      // Ignore permission request errors
    }
  }
}
