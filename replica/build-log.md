# Build log

S07 | 2026-10-31 | partial | S08 job record page not promoted (detail sheet still used); no multi-contact/location-record picker (M0); office bookings do not notify the customer or technician; leadSource left null (no "office" enum value) | service_requests.session_id is NOT NULL so each office booking gets a synthetic session; tech app hides pending jobs so assigned bookings flip pending→assigned; conflict gate had to move before the insert to avoid orphan/duplicate requests on the 409 retry; fieldset/grid min-width overflow in the dialog
