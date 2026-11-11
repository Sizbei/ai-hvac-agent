import { describe, expect, it } from 'vitest';
import { addressCity, formatAddressDisplay, formatPhoneDisplay } from './contact-format';

describe('formatPhoneDisplay', () => {
  it('formats US numbers the way people write them', () => {
    expect(formatPhoneDisplay('+1 (423) 555-0142')).toBe('(423) 555-0142');
    expect(formatPhoneDisplay('4235550187')).toBe('(423) 555-0187');
    expect(formatPhoneDisplay('423-555-0187')).toBe('(423) 555-0187');
    expect(formatPhoneDisplay('1-423-555-0187')).toBe('(423) 555-0187');
    expect(formatPhoneDisplay('+14235550187')).toBe('(423) 555-0187');
  });

  it('keeps an extension', () => {
    expect(formatPhoneDisplay('423-555-0187 x12')).toBe('(423) 555-0187 ext. 12');
    expect(formatPhoneDisplay('(423) 555-0187 ext. 4')).toBe('(423) 555-0187 ext. 4');
  });

  it('leaves numbers it cannot read unchanged', () => {
    expect(formatPhoneDisplay('423555014')).toBe('423555014');
    expect(formatPhoneDisplay(' 5551234 ')).toBe('5551234');
    expect(formatPhoneDisplay('+44 20 7946 0958')).toBe('+44 20 7946 0958');
  });

  it('returns null for nothing', () => {
    expect(formatPhoneDisplay(null)).toBeNull();
    expect(formatPhoneDisplay('   ')).toBeNull();
  });
});

describe('formatAddressDisplay', () => {
  it('joins a ZIP split from its state', () => {
    expect(formatAddressDisplay('900 Larkspur Street, Maple Hollow, TN, 37601')).toBe(
      '900 Larkspur Street, Maple Hollow, TN 37601',
    );
  });

  it('collapses a repeated city and state', () => {
    expect(formatAddressDisplay('254 Quarry Rd, Fernbrook, TN, Fernbrook, TN 37690')).toBe(
      '254 Quarry Rd, Fernbrook, TN 37690',
    );
    expect(formatAddressDisplay('5299 Highway 67 West, Mountain City, Tn., Mountain City, TN')).toBe(
      '5299 Highway 67 West, Mountain City, TN',
    );
  });

  it('drops empty segments', () => {
    expect(formatAddressDisplay('585 Rd, Birchvale, , Birchvale, TN 37694')).toBe(
      '585 Rd, Birchvale, TN 37694',
    );
    expect(formatAddressDisplay('2011 N Wren St, , , Maple Hollow, TN 37601')).toBe(
      '2011 N Wren St, Maple Hollow, TN 37601',
    );
  });

  it('keeps a city named like its state', () => {
    expect(formatAddressDisplay('120 Broadway, New York, New York 10271')).toBe(
      '120 Broadway, New York, New York 10271',
    );
  });

  it('leaves a tidy address and partial addresses alone', () => {
    expect(formatAddressDisplay('701 Juniper Ave, Kestrel, TN 37620')).toBe('701 Juniper Ave, Kestrel, TN 37620');
    expect(formatAddressDisplay('425 W. Thistle St')).toBe('425 W. Thistle St');
    expect(formatAddressDisplay('Main St, Co')).toBe('Main St, CO');
  });

  it('returns null for nothing', () => {
    expect(formatAddressDisplay(null)).toBeNull();
    expect(formatAddressDisplay(' , ')).toBeNull();
  });
});

describe('addressCity', () => {
  it('finds the city before the state', () => {
    expect(addressCity('211 North Wren Street, Maple Hollow, Tennessee 37601')).toBe('Maple Hollow');
    expect(addressCity('701 Juniper Ave, Kestrel, TN 37620')).toBe('Kestrel');
    expect(addressCity('900 Larkspur Street, Maple Hollow, TN, 37601')).toBe('Maple Hollow');
    expect(addressCity('Boone, NC')).toBe('Boone');
    expect(addressCity('P.o. Box 1210, Sherwood, OR 97140')).toBe('Sherwood');
  });

  it('returns null when the address has no city', () => {
    expect(addressCity('Larkin Health Care, 1633 Fernhill Dr')).toBeNull();
    expect(addressCity('P & Q Hair Care, Inc., 1315 Osprey Ave')).toBeNull();
    expect(addressCity('120 Broadway, New York 10271')).toBeNull();
    expect(addressCity('425 W. Thistle St')).toBeNull();
    expect(addressCity(null)).toBeNull();
  });
});

describe('formatAddressDisplay — erased', () => {
  it('reads the erasure sentinel as words', () => {
    expect(formatAddressDisplay('[deleted]')).toBe('Erased address');
  });
});
