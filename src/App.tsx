import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { subscribeToAuthState } from './services/authService';
import type { AuthUser } from './types/wearable';
import { AuthPage } from './components/AuthPage';
import { Dashboard } from './components/Dashboard';
import { LiveTrackPage } from './components/LiveTrackPage';

function extractTrackSessionId(pathname: string): string | null {
  const match = pathname.match(/^\/track\/([a-zA-Z0-9_-]+)\/?$/);
  return match ? match[1] : null;
}

export const App: React.FC = () => {
  const [trackSessionId] = useState<string | null>(() =>
    typeof window !== 'undefined'
      ? extractTrackSessionId(window.location.pathname)
      : null
  );
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(!trackSessionId);

  useEffect(() => {
    if (trackSessionId) return;
    const unsubscribe = subscribeToAuthState((nextUser) => {
      setUser(nextUser);
      setLoading(false);
    });
    return unsubscribe;
  }, [trackSessionId]);

  // Public 5-minute live tracking page for emergency contacts (no sign-in required)
  if (trackSessionId) {
    return <LiveTrackPage sessionId={trackSessionId} />;
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0B1220] flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#5796F5]" />
      </div>
    );
  }

  return user ? <Dashboard user={user} /> : <AuthPage />;
};

export default App;
