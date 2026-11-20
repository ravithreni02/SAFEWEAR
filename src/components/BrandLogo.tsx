import React, { useState } from 'react';
import { Shield } from 'lucide-react';

interface BrandLogoProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE_CLASSES: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'h-8 w-8 p-1 rounded-lg',
  md: 'h-10 w-10 p-1 rounded-xl',
  lg: 'h-20 w-20 p-2 rounded-2xl',
};

export const BrandLogo: React.FC<BrandLogoProps> = ({
  size = 'sm',
  className = '',
}) => {
  const [failed, setFailed] = useState(false);

  return (
    <div
      className={`inline-flex shrink-0 items-center justify-center bg-[#F4F7FA] border border-white/15 overflow-hidden ${SIZE_CLASSES[size]} ${className}`}
    >
      {failed ? (
        <Shield className="h-3/4 w-3/4 text-[#17365D]" />
      ) : (
        <img
          src="/assets/aistudio/image_b5ee755c.png"
          alt="SafeWear logo"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="h-full w-full object-contain"
        />
      )}
    </div>
  );
};
