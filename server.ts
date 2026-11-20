import express from 'express';
import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface TrackPoint {
  latitude: number;
  longitude: number;
  accuracy?: number;
  heartRate: number;
  timestamp: string;
}

interface TrackingSession {
  id: string;
  wearerName: string;
  createdAt: number;
  expiresAt: number | null;
  active: boolean;
  heartRate: number;
  pendantWorn: boolean | null;
  points: TrackPoint[];
}

interface DispatchContact {
  name: string;
  phone: string;
  channel?: 'sms' | 'whatsapp' | 'both';
}

interface DeliveryResult {
  contactName: string;
  phone: string;
  channel: 'sms' | 'whatsapp';
  status: 'sent' | 'failed' | 'unconfigured';
  sid?: string;
  error?: string;
}

const sessions = new Map<string, TrackingSession>();
const sseClients = new Map<string, Set<Response>>();

function broadcastSession(session: TrackingSession): void {
  const clients = sseClients.get(session.id);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify(session)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

function getEffectiveSession(id: string): TrackingSession | null {
  return sessions.get(id) ?? null;
}

function normalizePhone(raw: string): string {
  const withoutWa = raw.trim().replace(/^whatsapp:/i, '').trim();
  const cleaned = withoutWa.replace(/[\s\-()]/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return `+${cleaned.slice(2)}`;
  return `+${cleaned}`;
}

async function sendTwilioMessage(params: {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  body: string;
}): Promise<{ ok: boolean; sid?: string; error?: string }> {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(params.accountSid)}/Messages.json`;
  const credentials = Buffer.from(
    `${params.accountSid}:${params.authToken}`
  ).toString('base64');

  const form = new URLSearchParams();
  form.set('From', params.from);
  form.set('To', params.to);
  form.set('Body', params.body);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });

    const json = (await response.json()) as {
      sid?: string;
      message?: string;
      code?: number;
    };

    if (!response.ok) {
      const detail = json.message
        ? `${json.message}${json.code ? ` (Twilio ${json.code})` : ''}`
        : `Twilio HTTP ${response.status}`;
      console.error(`[Twilio] Failed to ${params.to} from ${params.from}: ${detail}`);
      return {
        ok: false,
        error: detail,
      };
    }

    return { ok: true, sid: json.sid };
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : 'Network error calling Twilio';
    console.error(`[Twilio] Network error to ${params.to}: ${msg}`);
    return {
      ok: false,
      error: msg,
    };
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer(): Promise<void> {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());

  // Check whether Twilio credentials are configured on server (booleans only)
  app.get('/api/config/status', (_req: Request, res: Response) => {
    const hasAuth = Boolean(
      (process.env.TWILIO_ACCOUNT_SID || '').trim() &&
        (process.env.TWILIO_AUTH_TOKEN || '').trim()
    );
    res.json({
      twilioSmsConfigured: Boolean(
        hasAuth && (process.env.TWILIO_SMS_FROM || '').trim()
      ),
      twilioWhatsappConfigured: hasAuth,
    });
  });

  // Create a continuous live tracking session (stays active until SOS is cancelled)
  app.post('/api/track/sessions', (req: Request, res: Response) => {
    const body = req.body as {
      wearerName?: string;
      heartRate?: number;
      pendantWorn?: boolean | null;
      latitude?: number;
      longitude?: number;
      accuracy?: number;
      origin?: string;
    };

    const id = crypto.randomBytes(6).toString('hex');
    const now = Date.now();
    const initialPoints: TrackPoint[] = [];

    if (
      typeof body.latitude === 'number' &&
      typeof body.longitude === 'number' &&
      !Number.isNaN(body.latitude) &&
      !Number.isNaN(body.longitude)
    ) {
      initialPoints.push({
        latitude: body.latitude,
        longitude: body.longitude,
        accuracy: body.accuracy,
        heartRate: typeof body.heartRate === 'number' ? body.heartRate : 0,
        timestamp: new Date(now).toISOString(),
      });
    }

    const session: TrackingSession = {
      id,
      wearerName:
        typeof body.wearerName === 'string' && body.wearerName.trim()
          ? body.wearerName.trim()
          : 'SafeWear Wearer',
      createdAt: now,
      expiresAt: null,
      active: true,
      heartRate: typeof body.heartRate === 'number' ? body.heartRate : 0,
      pendantWorn:
        typeof body.pendantWorn === 'boolean' ? body.pendantWorn : null,
      points: initialPoints,
    };

    sessions.set(id, session);

    // Always generate HTTPS public tracking link for non-localhost hosts
    let baseOrigin = '';
    if (
      typeof body.origin === 'string' &&
      /^https?:\/\/[^/\s]+$/i.test(body.origin.trim())
    ) {
      baseOrigin = body.origin.trim();
    } else {
      const host =
        (req.headers['x-forwarded-host'] as string | undefined) ||
        req.get('host') ||
        'localhost:3000';
      const isLocal =
        host.startsWith('localhost') || host.startsWith('127.0.0.1');
      const proto = isLocal ? 'http' : 'https';
      baseOrigin = `${proto}://${host}`;
    }

    const trackingUrl = `${baseOrigin}/track/${id}`;

    res.status(201).json({
      sessionId: id,
      trackingUrl,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    });
  });

  // Append a live GPS & heart rate update to an active tracking session
  app.post('/api/track/sessions/:id/update', (req: Request, res: Response) => {
    const session = getEffectiveSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Tracking session not found' });
      return;
    }

    if (!session.active) {
      res.status(410).json({ error: 'Tracking session has ended' });
      return;
    }

    const body = req.body as {
      latitude?: number;
      longitude?: number;
      accuracy?: number;
      heartRate?: number;
      pendantWorn?: boolean | null;
    };

    if (typeof body.heartRate === 'number' && !Number.isNaN(body.heartRate)) {
      session.heartRate = Math.round(body.heartRate);
    }
    if (typeof body.pendantWorn === 'boolean') {
      session.pendantWorn = body.pendantWorn;
    }

    if (
      typeof body.latitude === 'number' &&
      typeof body.longitude === 'number' &&
      !Number.isNaN(body.latitude) &&
      !Number.isNaN(body.longitude)
    ) {
      session.points.push({
        latitude: body.latitude,
        longitude: body.longitude,
        accuracy: body.accuracy,
        heartRate: session.heartRate,
        timestamp: new Date().toISOString(),
      });
      if (session.points.length > 500) {
        session.points = session.points.slice(-500);
      }
    }

    broadcastSession(session);
    res.json({ ok: true, pointCount: session.points.length });
  });

  // Stop an active tracking session early
  app.post('/api/track/sessions/:id/stop', (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Tracking session not found' });
      return;
    }
    session.active = false;
    broadcastSession(session);
    res.json({ ok: true });
  });

  // Public JSON endpoint for contacts viewing the tracking page
  app.get('/api/track/sessions/:id', (req: Request, res: Response) => {
    const session = getEffectiveSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Tracking session not found or expired' });
      return;
    }
    res.json(session);
  });

  // Public Server-Sent Events (SSE) stream for live updates
  app.get('/api/track/sessions/:id/stream', (req: Request, res: Response) => {
    const session = getEffectiveSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Tracking session not found' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let set = sseClients.get(session.id);
    if (!set) {
      set = new Set();
      sseClients.set(session.id, set);
    }
    set.add(res);

    res.write(`data: ${JSON.stringify(session)}\n\n`);

    const keepAlive = setInterval(() => {
      const current = getEffectiveSession(session.id);
      if (current) {
        res.write(`: ping\n\n`);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      set?.delete(res);
    });
  });

  // Automatic hands-free SOS alert dispatch via Twilio SMS & WhatsApp
  app.post('/api/sos/dispatch', async (req: Request, res: Response) => {
    const body = req.body as {
      wearerName?: string;
      heartRate?: number;
      latitude?: number | null;
      longitude?: number | null;
      trackingUrl?: string;
      contacts?: DispatchContact[];
    };

    const contacts = Array.isArray(body.contacts) ? body.contacts : [];
    if (contacts.length === 0) {
      res.status(400).json({ error: 'No emergency contacts provided' });
      return;
    }

    const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
    const authToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
    const smsFrom = normalizePhone(process.env.TWILIO_SMS_FROM || '');
    const waNormalized = normalizePhone(process.env.TWILIO_WHATSAPP_FROM || '');
    const whatsappFrom = waNormalized ? `whatsapp:${waNormalized}` : '';

    const wearer =
      typeof body.wearerName === 'string' && body.wearerName.trim()
        ? body.wearerName.trim()
        : 'SafeWear User';
    const hr =
      typeof body.heartRate === 'number' && body.heartRate > 0
        ? `${Math.round(body.heartRate)} BPM`
        : 'Reading...';
    const coords =
      typeof body.latitude === 'number' && typeof body.longitude === 'number'
        ? `${body.latitude.toFixed(5)}, ${body.longitude.toFixed(5)}`
        : 'Acquiring GPS';
    const mapsFallback =
      typeof body.latitude === 'number' && typeof body.longitude === 'number'
        ? `https://maps.google.com/?q=${body.latitude.toFixed(5)},${body.longitude.toFixed(5)}`
        : '';

    const messageText = [
      `EMERGENCY SOS from ${wearer} (SafeWear)`,
      `Heart Rate: ${hr}`,
      `Coordinates: ${coords}`,
      body.trackingUrl
        ? `Live Location Link (Active until SOS cancelled): ${body.trackingUrl}`
        : mapsFallback
          ? `Map: ${mapsFallback}`
          : '',
    ]
      .filter(Boolean)
      .join('\n');

    const results: DeliveryResult[] = [];

    for (const contact of contacts) {
      const normalized = normalizePhone(contact.phone);
      if (!normalized) continue;

      const requested = contact.channel || 'both';
      const channels: Array<'sms' | 'whatsapp'> =
        requested === 'both' ? ['whatsapp', 'sms'] : [requested];

      for (const ch of channels) {
        if (!accountSid || !authToken) {
          results.push({
            contactName: contact.name,
            phone: normalized,
            channel: ch,
            status: 'unconfigured',
            error:
              'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not configured on server',
          });
          continue;
        }

        if (ch === 'sms') {
          if (!smsFrom) {
            results.push({
              contactName: contact.name,
              phone: normalized,
              channel: 'sms',
              status: 'unconfigured',
              error: 'TWILIO_SMS_FROM not configured on server',
            });
            continue;
          }
          const outcome = await sendTwilioMessage({
            accountSid,
            authToken,
            from: smsFrom,
            to: normalized,
            body: messageText,
          });
          results.push({
            contactName: contact.name,
            phone: normalized,
            channel: 'sms',
            status: outcome.ok ? 'sent' : 'failed',
            sid: outcome.sid,
            error: outcome.error,
          });
        } else {
          const sandboxFrom = 'whatsapp:+14155238886';
          const effectiveFrom = whatsappFrom || sandboxFrom;
          let outcome = await sendTwilioMessage({
            accountSid,
            authToken,
            from: effectiveFrom,
            to: `whatsapp:${normalized}`,
            body: messageText,
          });
          if (
            !outcome.ok &&
            effectiveFrom !== sandboxFrom &&
            outcome.error &&
            (outcome.error.includes('572002') ||
              outcome.error.includes('63007') ||
              outcome.error.includes('21606'))
          ) {
            outcome = await sendTwilioMessage({
              accountSid,
              authToken,
              from: sandboxFrom,
              to: `whatsapp:${normalized}`,
              body: messageText,
            });
          }
          results.push({
            contactName: contact.name,
            phone: normalized,
            channel: 'whatsapp',
            status: outcome.ok ? 'sent' : 'failed',
            sid: outcome.sid,
            error: outcome.error,
          });
        }
      }
    }

    const sentCount = results.filter((r) => r.status === 'sent').length;
    res.json({
      dispatched: sentCount > 0,
      sentCount,
      totalAttempted: results.length,
      results,
      messagePreview: messageText,
    });
  });

  // Mount Vite middleware in development, or serve built dist/ in production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.use((req: Request, res: Response, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) {
        next();
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const PORT = 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SafeWear server running on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
