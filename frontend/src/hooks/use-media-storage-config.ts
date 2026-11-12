import { useEffect, useState } from 'react';
import { api } from '../services/api';
import type { MediaStorageConfigResponse } from '@shared/types/instagram.ts';

async function fetchMediaStorageConfig(): Promise<MediaStorageConfigResponse | null> {
  try {
    const config = await api.getMediaStorageConfig();
    return config.configured ? config : null;
  } catch {
    // pages already show a missing config as an alert or a disabled upload field
    return null;
  }
}

// reloadKey lets a page refetch the config when something it depends on changes
export function useMediaStorageConfig(reloadKey?: unknown): MediaStorageConfigResponse | null {
  const [config, setConfig] = useState<MediaStorageConfigResponse | null>(null);

  useEffect(() => {
    const loadConfig = async () => {
      const nextConfig = await fetchMediaStorageConfig();
      if (nextConfig) setConfig(nextConfig);
    };
    loadConfig();
  }, [reloadKey]);

  return config;
}
