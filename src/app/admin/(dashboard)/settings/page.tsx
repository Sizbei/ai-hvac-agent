'use client';

import {
  AlertCircle,
  Palette,
  Wrench,
  Building2,
  MessageSquarePlus,
  Code2,
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

export default function SettingsPage() {
  const settings = useOrgSettings();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Chatbot Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Customize how your AI assistant looks and behaves, which services it
          offers, and the answers it gives.
        </p>
      </div>

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
        <Tabs defaultValue="branding">
          <TabsList className="w-full justify-start overflow-x-auto">
            <TabsTrigger value="branding">
              <Palette className="size-4" />
              Branding
            </TabsTrigger>
            <TabsTrigger value="services">
              <Wrench className="size-4" />
              Services
            </TabsTrigger>
            <TabsTrigger value="business">
              <Building2 className="size-4" />
              Business Info
            </TabsTrigger>
            <TabsTrigger value="faqs">
              <MessageSquarePlus className="size-4" />
              Custom Q&amp;A
            </TabsTrigger>
            <TabsTrigger value="embed">
              <Code2 className="size-4" />
              Embed &amp; Keys
            </TabsTrigger>
          </TabsList>

          <TabsContent value="branding" className="mt-6">
            <BrandingPanel config={settings.config} onSave={settings.saveConfig} />
          </TabsContent>
          <TabsContent value="services" className="mt-6">
            <ServicesPanel config={settings.config} onSave={settings.saveConfig} />
          </TabsContent>
          <TabsContent value="business" className="mt-6">
            <BusinessInfoPanel
              config={settings.config}
              onSave={settings.saveConfig}
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
            <EmbedPanel config={settings.config} onSave={settings.saveConfig} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
