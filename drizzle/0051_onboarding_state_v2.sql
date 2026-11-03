UPDATE organization_settings SET onboarding_state = onboarding_state
  || CASE WHEN onboarding_state->>'dismissed' = 'true' AND NOT (onboarding_state ? 'dismissedAt')
          THEN jsonb_build_object('dismissedAt', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ELSE '{}'::jsonb END
  || CASE WHEN onboarding_state->>'embedViewed' = 'true' AND onboarding_state #> '{flags,embedCopied}' IS NULL
          THEN jsonb_build_object('flags', COALESCE(onboarding_state->'flags','{}'::jsonb) || '{"embedCopied":true}'::jsonb) ELSE '{}'::jsonb END
WHERE jsonb_typeof(onboarding_state) = 'object'
  AND ((onboarding_state->>'dismissed' = 'true' AND NOT (onboarding_state ? 'dismissedAt'))
    OR (onboarding_state->>'embedViewed' = 'true' AND onboarding_state #> '{flags,embedCopied}' IS NULL));
--> statement-breakpoint
UPDATE organization_settings s SET company_name = left(o.name, 120)
  FROM organizations o WHERE o.id = s.organization_id AND s.company_name IS NULL;
