import { describe, expect, it } from 'vitest';
import { seatsFull, seatUsageCopy } from './seat-usage';

describe('seat usage', () => {
  it('is full at or over the limit', () => {
    expect(seatsFull({ used: 1, limit: 2 })).toBe(false);
    expect(seatsFull({ used: 2, limit: 2 })).toBe(true);
    expect(seatsFull({ used: 3, limit: 2 })).toBe(true);
  });

  it('describes usage', () => {
    expect(seatUsageCopy({ used: 5, limit: 5 })).toBe("You've used 5 of 5 seats.");
    expect(seatUsageCopy({ used: 0, limit: 1 })).toBe("You've used 0 of 1 seat.");
  });
});
