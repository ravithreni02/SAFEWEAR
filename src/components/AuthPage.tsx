import React, { useState, useRef, useEffect } from 'react';
import {
  User,
  Mail,
  Lock,
  Eye,
  EyeOff,
  Loader2,
} from 'lucide-react';
import {
  friendlyAuthError,
  signInWithGoogleAuth,
  submitEmailPasswordAuth,
} from '../services/authService';
import { BrandLogo } from './BrandLogo';
import { Snackbar } from './Snackbar';

interface FormErrors {
  name?: string;
  email?: string;
  password?: string;
}

export const AuthPage: React.FC = () => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLogin, setIsLogin] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [hidePassword, setHidePassword] = useState(true);
  const [errors, setErrors] = useState<FormErrors>({});
  const [snackbarMessage, setSnackbarMessage] = useState<string | null>(null);

  const snackbarTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (snackbarTimerRef.current !== null) {
        window.clearTimeout(snackbarTimerRef.current);
      }
    };
  }, []);

  const showError = (message: string) => {
    setSnackbarMessage(message);
    if (snackbarTimerRef.current !== null) {
      window.clearTimeout(snackbarTimerRef.current);
    }
    snackbarTimerRef.current = window.setTimeout(() => {
      setSnackbarMessage(null);
    }, 4000);
  };

  const validateForm = (): boolean => {
    const nextErrors: FormErrors = {};

    if (!isLogin && name.trim().length === 0) {
      nextErrors.name = 'Please enter your name';
    }

    const trimmedEmail = email.trim();
    if (trimmedEmail.length === 0 || !trimmedEmail.includes('@')) {
      nextErrors.email = 'Enter a valid email address';
    }

    if (password.length < 6) {
      nextErrors.password = 'Password must be at least 6 characters';
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm()) return;

    setIsLoading(true);
    try {
      await submitEmailPasswordAuth({
        isLogin,
        name,
        email,
        password,
      });
    } catch (error) {
      showError(friendlyAuthError(error));
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setIsLoading(true);
    try {
      await signInWithGoogleAuth();
    } catch (error) {
      showError(friendlyAuthError(error));
    } finally {
      setIsLoading(false);
    }
  };

  const toggleMode = () => {
    setIsLogin((prev) => !prev);
    setErrors({});
  };

  return (
    <div className="min-h-screen bg-[#0B1220] text-white flex items-center justify-center p-6">
      <div className="w-full max-w-[440px]">
        <form onSubmit={handleSubmit} noValidate className="flex flex-col">
          <div className="flex justify-center">
            <BrandLogo size="lg" />
          </div>

          <h1 className="mt-4 text-center text-[30px] font-bold tracking-tight">
            SafeWear
          </h1>

          <p className="mt-2 text-center text-sm text-white/60">
            {isLogin
              ? 'Sign in to access your safety dashboard'
              : 'Create your SafeWear account'}
          </p>

          <div className="mt-[30px] flex flex-col gap-3.5">
            {!isLogin && (
              <div>
                <label className="block text-xs text-white/70 mb-1.5">
                  Full name
                </label>
                <div className="relative">
                  <User className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-white/60" />
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Full name"
                    autoComplete="name"
                    className="w-full rounded-md border border-white/25 bg-transparent py-3.5 pl-11 pr-3.5 text-sm text-white placeholder-white/40 outline-none focus:border-[#5796F5]"
                  />
                </div>
                {errors.name && (
                  <p className="mt-1 text-xs text-red-400">{errors.name}</p>
                )}
              </div>
            )}

            <div>
              <label className="block text-xs text-white/70 mb-1.5">
                Email address
              </label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-white/60" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Email address"
                  autoComplete="email"
                  className="w-full rounded-md border border-white/25 bg-transparent py-3.5 pl-11 pr-3.5 text-sm text-white placeholder-white/40 outline-none focus:border-[#5796F5]"
                />
              </div>
              {errors.email && (
                <p className="mt-1 text-xs text-red-400">{errors.email}</p>
              )}
            </div>

            <div>
              <label className="block text-xs text-white/70 mb-1.5">
                Password
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-white/60" />
                <input
                  type={hidePassword ? 'password' : 'text'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  autoComplete={isLogin ? 'current-password' : 'new-password'}
                  className="w-full rounded-md border border-white/25 bg-transparent py-3.5 pl-11 pr-11 text-sm text-white placeholder-white/40 outline-none focus:border-[#5796F5]"
                />
                <button
                  type="button"
                  onClick={() => setHidePassword((prev) => !prev)}
                  aria-label={hidePassword ? 'Show password' : 'Hide password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/60 hover:text-white cursor-pointer"
                >
                  {hidePassword ? (
                    <EyeOff className="h-5 w-5" />
                  ) : (
                    <Eye className="h-5 w-5" />
                  )}
                </button>
              </div>
              {errors.password && (
                <p className="mt-1 text-xs text-red-400">{errors.password}</p>
              )}
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="mt-[22px] flex h-[50px] w-full items-center justify-center rounded-full bg-[#1C2A44] text-sm font-medium text-[#A8C7FA] shadow hover:bg-[#243658] disabled:opacity-50 transition-colors cursor-pointer"
          >
            {isLoading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : isLogin ? (
              'Log In'
            ) : (
              'Create Account'
            )}
          </button>

          <button
            type="button"
            disabled={isLoading}
            onClick={handleGoogleSignIn}
            className="mt-3.5 flex h-11 w-full items-center justify-center gap-2 rounded-full border border-white/25 text-sm font-medium text-[#A8C7FA] hover:bg-white/5 disabled:opacity-50 transition-colors cursor-pointer"
          >
            <span className="text-lg font-bold leading-none">G</span>
            <span>Continue with Google</span>
          </button>

          <button
            type="button"
            disabled={isLoading}
            onClick={toggleMode}
            className="mt-[18px] text-center text-sm font-medium text-[#A8C7FA] hover:underline disabled:opacity-50 cursor-pointer"
          >
            {isLogin
              ? "Don't have an account? Sign up"
              : 'Already have an account? Log in'}
          </button>
        </form>
      </div>

      <Snackbar message={snackbarMessage} />
    </div>
  );
};
