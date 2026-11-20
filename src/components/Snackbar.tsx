import React from 'react';

interface SnackbarProps {
  message: string | null;
}

export const Snackbar: React.FC<SnackbarProps> = ({ message }) => {
  if (!message) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-lg bg-[#23314A] px-4 py-3 text-sm text-white shadow-xl border border-white/10"
    >
      {message}
    </div>
  );
};
