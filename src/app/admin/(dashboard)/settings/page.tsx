'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  Palette,
  Wrench,
  Building2,
  MessageSquarePlus,
  Code2,
  SlidersHorizontal,
  Clock,
  Plug,
  Truck,
  ClipboardList,
  Tag,
} from 'lucide-react';
import { useOrgSettings } from '@/hooks/use-org-settings';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { BrandingPanel } from '@/components/admin/settings/branding-panel';
import { ServicesPanel } from '@/components/admin/settings/services-panel';
import { BusinessInfoPanel } from '@/components/admin/settings/business-info-panel';
import { CustomFaqsPanel } from '@/components/admin/settings/custom-faqs-panel';
import { EmbedPanel } from '@/components/admin/settings/embed-panel';
import { ConversationLimitsPanel } from '@/components/admin/settings/conversation-limits-panel';
import { AfterHoursPanel } from '@/components/admin/settings/after-hours-panel';
import { DispatchPanel } from '@/components/admin/settings/dispatch-panel';
import { GoogleCalendarPanel } from '@/components/admin/settings/google-calendar-panel';
import { HousecallProPanel } from '@/components/admin/settings/housecall-pro-panel';
import { FieldpulsePanel } from '@/components/admin/settings/fieldpulse-panel';
import { AiModelPanel } from '@/components/admin/settings/ai-model-panel';
import { PlatformLinkPanel } from '@/components/admin/settings/platform-link-panel';
import { TagsPanel } from '@/components/admin/settings/tags-panel';
import { JobTypesPanel } from '@/components/admin/settings/job-types-panel';
import { BillingLinkPanel } from '@/components/admin/settings/billing-link-panel';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { BackToGuideBanner } from '@/components/admin/setup/back-to-guide-banner';
import { useFromSetup } from '@/hooks/use-open-from-param';
import { refreshOnboarding } from '@/lib/admin/onboarding-store';
import type { BannerEvent } from '@/lib/admin/setup-card-view';
import type { StepId } from '@/lib/admin/onboarding-state';
import type { OrgConfigUpdate } from '@/lib/admin/org-config-types';

/** The setup step a deep-linked tab belongs to (spec §3). */
const SETUP_STEP_BY_TAB: Readonly<Record<string, StepId>> = {
  business: 'phone_hours',
  branding: 'brand',
  embed: 'chat_widget',
};

export default function SettingsPage() {
  useEffect(() => { document.title = 'Settings · Spears Admin'; }, []);
  const settings = useOrgSettings();
  const initialTab = useSearchParams().get('tab') ?? 'branding';
  const fromSetup = useFromSetup();
  const [bannerEvent, setBannerEvent] = useState<BannerEvent>(null);
  const setupStep = fromSetup ? SETUP_STEP_BY_TAB[initialTab] : undefined;

  // Setup-guide tabs: a successful save refreshes the guide so the banner can
  // flip; the 'saved' event only counts on the tab the banner belongs to.
  async function saveFromSetup(tab: string, update: OrgConfigUpdate): Promise<boolean> {
    const ok = await settings.saveConfig(update);
    if (ok && fromSetup && tab === initialTab) {
      setBannerEvent('saved');
      void refreshOnboarding({ force: true });
    }
    return ok;
  }

  return (
    <PageShell narrow>
      <PageHeader
        title="Settings"
        subtitle="Customize how your AI assistant looks and behaves, which services it offers, and the answers it gives."
      />

      {setupStep && <BackToGuideBanner stepId={setupStep} event={bannerEvent} />}

      {settings.error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{settings.error}</AlertDescription>
        </Alert>
      )}

      {settings.isLoading || !settings.config ? (
        <div className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <Tabs defaultValue={initialTab}>
          <TabsList className="h-auto w-full flex-wrap justify-start gap-y-1 group-data-horizontal/tabs:h-auto">
            <TabsTrigger value="branding">
              <Palette className="size-4" />
              Branding
            </TabsTrigger>
            <TabsTrigger value="services">
              <Wrench className="size-4" />
              Services
            </TabsTrigger>
            <TabsTrigger value="job-types">
              <ClipboardList className="size-4" />
              Job types
            </TabsTrigger>
            <TabsTrigger value="tags">
              <Tag className="size-4" />
              Tags
            </TabsTrigger>
            <TabsTrigger value="business">
              <Building2 className="size-4" />
              Business info
            </TabsTrigger>
            <TabsTrigger value="faqs">
              <MessageSquarePlus className="size-4" />
              Custom Q&amp;A
            </TabsTrigger>
            <TabsTrigger value="embed">
              <Code2 className="size-4" />
              Embed &amp; keys
            </TabsTrigger>
            <TabsTrigger value="limits">
              <SlidersHorizontal className="size-4" />
              Limits
            </TabsTrigger>
            <TabsTrigger value="after-hours">
              <Clock className="size-4" />
              After-hours
            </TabsTrigger>
            <TabsTrigger value="dispatch">
              <Truck className="size-4" />
              Dispatch
            </TabsTrigger>
            <TabsTrigger value="integrations">
              <Plug className="size-4" />
              Integrations
            </TabsTrigger>
          </TabsList>

          <TabsContent value="branding" className="mt-6">
            <BrandingPanel config={settings.config} onSave={(u) => saveFromSetup('branding', u)} />
          </TabsContent>
          <TabsContent value="services" className="mt-6">
            <ServicesPanel config={settings.config} onSave={settings.saveConfig} />
          </TabsContent>
          <TabsContent value="job-types" className="mt-6">
            <JobTypesPanel />
          </TabsContent>
          <TabsContent value="tags" className="mt-6">
            <TagsPanel />
          </TabsContent>
          <TabsContent value="business" className="mt-6">
            <BusinessInfoPanel
              config={settings.config}
              onSave={(u) => saveFromSetup('business', u)}
            />
          </TabsContent>
          <TabsContent value="faqs" className="mt-6">
            <CustomFaqsPanel
              faqs={settings.faqs}
              onCreate={settings.createFaq}
              onUpdate={settings.updateFaq}
              onDelete={settings.deleteFaq}
            />
          </TabsContent>
          <TabsContent value="embed" className="mt-6">
            <EmbedPanel config={settings.config} onSave={(u) => saveFromSetup('embed', u)} />
          </TabsContent>
          <TabsContent value="limits" className="mt-6">
            <ConversationLimitsPanel
              config={settings.config}
              onSave={settings.saveConfig}
            />
          </TabsContent>
          <TabsContent value="after-hours" className="mt-6">
            <AfterHoursPanel
              config={settings.config}
              onSave={settings.saveConfig}
            />
          </TabsContent>
          <TabsContent value="dispatch" className="mt-6">
            <DispatchPanel config={settings.config} onSave={settings.saveConfig} />
          </TabsContent>
          <TabsContent value="integrations" className="mt-6 space-y-6">
            <GoogleCalendarPanel />
            <HousecallProPanel />
            <FieldpulsePanel />
            {/* Super-admin only — self-hides for everyone else (the data
                endpoint is super_admin-gated and the panel renders null on 403). */}
            <AiModelPanel />
            {/* Super_admin/platform-admin only — self-hides otherwise (probes
                the gated billing endpoint and renders null on 403). */}
            <BillingLinkPanel />
            {/* Platform-admin only — self-hides for everyone else (probes the
                platform-gated endpoint and renders null on 403). */}
            <PlatformLinkPanel />
          </TabsContent>
        </Tabs>
      )}
    </PageShell>
  );
}
