import React from 'react';
import SurfaceBox from '@/components/SurfaceBox';
import InstagramTesterNotice from '@/components/InstagramTesterNotice';
import SettingsSection from './SettingsSection';

export default function PlatformRequirementsSection() {
  return (
    <SettingsSection id="platforms" title="Platform requirements" description="What each platform needs before it can be added.">
      <SurfaceBox content={false} className="divide-y divide-divider">
        <div className="flex flex-col gap-1 px-5 py-4">
          <p className="text-sm font-medium text-ink">YouTube</p>
          <p className="text-sm text-ink-muted">Add a channel link or @handle in Accounts. The API key is already set on the server.</p>
        </div>
        <div className="flex flex-col gap-2 px-5 py-4">
          <p className="text-sm font-medium text-ink">Instagram</p>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-ink-muted marker:text-ink-faint">
            <li>The account must be an Instagram Business or Creator account.</li>
            <li>Get tester access from the administrator and accept the invite (below).</li>
            <li>In Accounts, choose Add account, then Instagram account, then Continue to Instagram.</li>
            <li>Approve the requested permissions. Instagram sends you back here automatically.</li>
          </ol>
          <InstagramTesterNotice className="mt-2" />
        </div>
        <div className="flex flex-col gap-1 px-5 py-4">
          <p className="text-sm font-medium text-ink">Cloudflare R2</p>
          <p className="text-sm text-ink-muted">Instagram needs every file at a public URL before publishing. Media uploads to R2 in retryable multipart chunks, then Instagram fetches it from the bucket's public custom domain.</p>
        </div>
      </SurfaceBox>
    </SettingsSection>
  );
}
