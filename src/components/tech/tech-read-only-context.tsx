'use client';

import { createContext, useContext } from 'react';

/**
 * True while the platform owner views /tech as a technician (spec P7): the
 * proxy refuses every write, so the clock and status buttons render disabled.
 * Provided by the tech layout.
 */
const TechReadOnlyContext = createContext(false);

export const TechReadOnlyProvider = TechReadOnlyContext.Provider;

export function useTechReadOnly(): boolean {
  return useContext(TechReadOnlyContext);
}
