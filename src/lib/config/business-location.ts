/**
 * Single source of truth for the Spears Services base location.
 *
 * Used as the origin for address proximity bias (geocoding/autocomplete
 * results near the business rank higher) and for distance display
 * (e.g. how far a customer's address is from the shop). Import this
 * constant rather than re-declaring coordinates anywhere else.
 */
export const BUSINESS_BASE_LOCATION = {
  name: 'Spears Services',
  address: '3501 W Market St, Suite 1, Johnson City, TN 37604',
  latitude: 36.3340, // Johnson City, TN
  longitude: -82.3819,
  serviceRadiusKm: 50,
  timezone: 'America/New_York',
} as const;

export type BusinessLocation = typeof BUSINESS_BASE_LOCATION;
