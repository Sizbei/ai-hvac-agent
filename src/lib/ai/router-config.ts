/**
 * Per-organization overlay applied to the deterministic router: which services
 * the org declines, business-info personalization of canned answers, and
 * admin-authored custom FAQs. Kept separate from the core router so routeMessage
 * stays a pure function that simply takes this config as input.
 *
 * SAFETY INVARIANT: none of this can suppress an emergency. The router applies
 * the emergency short-circuit BEFORE consulting any of this config.
 */

/** A custom FAQ as the router needs it (subset of the admin CustomFaq). */
export interface CustomFaqRule {
  readonly id: string;
  readonly answer: string;
  /** Lowercased trigger phrases; matched as substrings/word-boundaries. */
  readonly triggers: readonly string[];
}

import { normalize } from "./text-normalize";

export interface RouterOrgConfig {
  /** issueType values the org does NOT handle. */
  readonly disabledIssueTypes: readonly string[];
  /** Service tags (e.g. "boiler") the org does NOT offer. */
  readonly disabledServiceTags: readonly string[];
  /** Business info used to personalize specific FAQ answers. */
  readonly businessInfo: Readonly<Record<string, unknown>>;
  /** Active admin-authored FAQs. */
  readonly customFaqs: readonly CustomFaqRule[];
}

export const EMPTY_ORG_CONFIG: RouterOrgConfig = {
  disabledIssueTypes: [],
  disabledServiceTags: [],
  businessInfo: {},
  customFaqs: [],
};

/**
 * Maps a service tag the admin can disable to the knowledge-base intent ids it
 * governs. When a tag is disabled and one of these intents would match, the
 * router declines/redirects instead of answering "yes we do that".
 */
export const SERVICE_TAG_TO_INTENTS: Readonly<Record<string, readonly string[]>> =
  {
    boiler: ["equipment-boiler", "heating-no-hot-water"],
    water_heater: ["heating-no-hot-water"],
    commercial: [],
    ductless_minisplit: ["equipment-minisplit"],
    iaq_products: ["equipment-iaq-products"],
    new_installation: [
      "faq-install-vs-repair",
      "replacement-consultation",
      "pricing-cost-to-replace",
    ],
    duct_cleaning: ["maintenance-duct-cleaning"],
  };

/**
 * Maps a disabled issueType to the KB intent ids whose canned "we can help"
 * answer would contradict the org not offering it.
 */
export const ISSUE_TYPE_TO_INTENTS: Readonly<Record<string, readonly string[]>> =
  {
    installation: [
      "faq-install-vs-repair",
      "replacement-consultation",
      "pricing-cost-to-replace",
    ],
    maintenance: [
      "maintenance-tuneup",
      "maintenance-filter",
      "maintenance-seasonal-prep",
      "maintenance-duct-cleaning",
    ],
    air_quality: ["equipment-iaq-products"],
  };

/** The set of intent ids the org has effectively turned off. */
export function disabledIntentIds(config: RouterOrgConfig): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const tag of config.disabledServiceTags) {
    for (const id of SERVICE_TAG_TO_INTENTS[tag] ?? []) ids.add(id);
  }
  for (const issue of config.disabledIssueTypes) {
    for (const id of ISSUE_TYPE_TO_INTENTS[issue] ?? []) ids.add(id);
  }
  return ids;
}

/** Polite decline shown when a customer asks for a service the org doesn't offer. */
export function declineReply(): string {
  return "I'm sorry, but that's not a service we currently offer. Is there another heating or cooling issue I can help you with?";
}

/** Shortest trigger we'll match on, after normalization. Guards against an
 * admin entering a 1–2 char trigger (e.g. "a") that would match nearly every
 * message and hijack all routing. Kept in sync with the API's zod min. */
export const MIN_TRIGGER_LENGTH = 3;

/** Find the FIRST active custom FAQ whose trigger matches the message. The
 * trigger is normalized the SAME way as the message (lowercase, punctuation →
 * space, aliases) so admin phrasings like "A/C" match the normalized text. */
export function matchCustomFaq(
  normalizedText: string,
  customFaqs: readonly CustomFaqRule[],
): CustomFaqRule | null {
  for (const faq of customFaqs) {
    for (const trigger of faq.triggers) {
      const t = normalize(trigger);
      if (t.length >= MIN_TRIGGER_LENGTH && normalizedText.includes(t)) {
        return faq;
      }
    }
  }
  return null;
}

/**
 * Personalize a canned FAQ answer with the org's business info, when available.
 * Returns the personalized string, or the original canned response if there's
 * no relevant info to substitute. Conservative: only replaces for intents we
 * have a concrete field for; otherwise leaves the safe generic text.
 */
export function personalizeAnswer(
  intentId: string,
  cannedResponse: string,
  businessInfo: Readonly<Record<string, unknown>>,
): string {
  const str = (k: string): string | null => {
    const v = businessInfo[k];
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  };

  switch (intentId) {
    case "faq-service-area": {
      const area = str("serviceArea");
      return area
        ? `We serve ${area}. If you share your address or zip code, I can pass it along to confirm coverage — and we can start a request if you have an HVAC issue.`
        : cannedResponse;
    }
    case "faq-business-hours": {
      const hours = str("businessHours");
      return hours ? `Our hours are ${hours}.` : cannedResponse;
    }
    case "faq-phone-number": {
      const phone = str("phone");
      return phone
        ? `You can reach us at ${phone}. I can also start a request for you right here.`
        : cannedResponse;
    }
    case "faq-licensed-insured": {
      const li = str("licensedInsured");
      return li ? li : cannedResponse;
    }
    case "faq-payment-methods": {
      const pm = str("paymentMethods");
      return pm ? `We accept ${pm}.` : cannedResponse;
    }
    case "faq-financing": {
      const fin = businessInfo["financingAvailable"];
      if (fin === true) {
        return "Yes — we offer financing options, especially for new installations. Our team can review the details with you. Would you like me to start a request?";
      }
      if (fin === false) {
        return "We don't currently offer in-house financing, but our team can talk through your payment options. Would you like me to start a request?";
      }
      return cannedResponse;
    }
    default:
      return cannedResponse;
  }
}
