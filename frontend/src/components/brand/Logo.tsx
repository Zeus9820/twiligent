import React from 'react';
import { cn } from '@/lib/utils';

const LOGO_DIR = '/Logos';

// css shows one of both lockups, so it is right before the theme hook runs
export interface LogoProps {
  variant?: 'lockup' | 'wordmark' | 'mark';
  className?: string;
}

export function Logo({ variant = 'lockup', className }: LogoProps) {
  if (variant === 'wordmark') {
    return (
      <span className={cn('inline-flex shrink-0 select-none items-center whitespace-nowrap font-display text-sm font-bold tracking-tight text-ink', className)}>Kratos Studio</span>
    );
  }

  if (variant === 'mark') {
    return (
      <img
        src={`${LOGO_DIR}/game-of-kratos-emblem.svg`}
        alt="Kratos Studio"
        className={cn('h-6 w-auto shrink-0 select-none', className)}
        draggable={false}
      />
    );
  }

  return (
    <span className={cn('inline-flex shrink-0 select-none items-center gap-2', className)}>
      <img src={`${LOGO_DIR}/game-of-kratos-emblem.svg`} alt="" className="h-full w-auto" draggable={false} />
      <span className="whitespace-nowrap font-display text-lg font-bold tracking-tight text-ink">Kratos Studio</span>
    </span>
  );
}
