import { Phone } from 'lucide-react';
import { telHref } from '@/lib/portal/portal-notice';

/**
 * Who sent this link: the org's name and tap-to-call phone, shown at the top
 * of the token pages (portal, estimate) so a homeowner opening a texted link
 * knows which company it is from. Renders nothing when neither is known.
 */
export function BusinessIdentity({
  companyName,
  phone,
}: {
  readonly companyName: string | null;
  readonly phone: string | null;
}) {
  const tel = phone ? telHref(phone) : null;
  if (!companyName && !tel) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border pb-3">
      {companyName ? (
        <p className="font-heading text-[15px] font-semibold text-foreground">
          {companyName}
        </p>
      ) : (
        <span />
      )}
      {tel && phone && (
        <a
          href={tel}
          className="inline-flex min-h-11 items-center gap-1.5 text-[15px] font-medium text-link underline-offset-2 hover:underline"
        >
          <Phone className="size-4" aria-hidden="true" />
          {phone}
        </a>
      )}
    </div>
  );
}
