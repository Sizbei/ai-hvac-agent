// Design tokens for the HVAC customer chat UI
// Colors match the CSS variables in globals.css

export const COLORS = {
  primary: '#2563EB',      // Blue -- trust, professionalism
  primaryLight: '#DBEAFE', // Blue-100 for subtle backgrounds
  accent: '#F97316',       // Orange -- warmth, action CTAs
  accentLight: '#FFF7ED',  // Orange-50 for subtle accent backgrounds
  slate50: '#F8FAFC',
  slate100: '#F1F5F9',
  slate200: '#E2E8F0',
  slate500: '#64748B',
  slate700: '#334155',
  slate900: '#0F172A',
  white: '#FFFFFF',
  success: '#16A34A',      // Green-600 for confirmed states
  error: '#DC2626',        // Red-600 for errors
} as const;

export const ANIMATION = {
  messageSlideUp: { duration: 0.2, ease: 'easeOut' as const },
  fadeIn: { duration: 0.2, ease: 'easeOut' as const },
  typingPulse: { duration: 0.6, repeat: Infinity, repeatType: 'reverse' as const },
  cardFadeIn: { duration: 0.3, ease: 'easeOut' as const },
} as const;

export const LAYOUT = {
  maxChatWidth: 'max-w-lg',    // Desktop max width
  mobileBreakpoint: 'md',       // Below this = full-screen chat
} as const;
