import { describe, it, expect, afterEach } from 'vitest';
import { envName, envTone, parseEnvLinks } from './environment';

// envName() reads process.env.NEXT_PUBLIC_ENV_NAME; we restore it after each test.
afterEach(() => {
  delete process.env.NEXT_PUBLIC_ENV_NAME;
});

describe('envName', () => {
  it('defaults to production when the env var is absent', () => {
    expect(envName()).toBe('production');
  });

  it('defaults to production when the env var is empty', () => {
    process.env.NEXT_PUBLIC_ENV_NAME = '';
    expect(envName()).toBe('production');
  });

  it('returns the lower-cased env name', () => {
    process.env.NEXT_PUBLIC_ENV_NAME = 'Staging';
    expect(envName()).toBe('staging');
  });

  it('returns test when set to TEST', () => {
    process.env.NEXT_PUBLIC_ENV_NAME = 'TEST';
    expect(envName()).toBe('test');
  });
});

describe('envTone', () => {
  it('maps production to destructive', () => {
    expect(envTone('production')).toBe('destructive');
  });

  it('maps PRODUCTION (case-insensitive) to destructive', () => {
    expect(envTone('PRODUCTION')).toBe('destructive');
  });

  it('maps staging to warning', () => {
    expect(envTone('staging')).toBe('warning');
  });

  it('maps STAGING to warning', () => {
    expect(envTone('STAGING')).toBe('warning');
  });

  it('maps test to positive', () => {
    expect(envTone('test')).toBe('positive');
  });

  it('maps dev to positive', () => {
    expect(envTone('dev')).toBe('positive');
  });

  it('maps unknown names to positive', () => {
    expect(envTone('preview')).toBe('positive');
  });
});

describe('parseEnvLinks', () => {
  it('returns [] when json is undefined', () => {
    expect(parseEnvLinks(undefined, 'staging')).toEqual([]);
  });

  it('returns [] on empty string', () => {
    expect(parseEnvLinks('', 'staging')).toEqual([]);
  });

  it('returns [] on malformed JSON', () => {
    expect(parseEnvLinks('{bad json', 'staging')).toEqual([]);
  });

  it('returns [] when JSON is an array (wrong shape)', () => {
    expect(parseEnvLinks('[]', 'staging')).toEqual([]);
  });

  it('returns [] when JSON is a primitive', () => {
    expect(parseEnvLinks('"hello"', 'staging')).toEqual([]);
  });

  it('drops the entry matching self (case-insensitive)', () => {
    const json = JSON.stringify({
      production: 'https://app.example.com',
      staging: 'https://staging.example.com',
    });
    const links = parseEnvLinks(json, 'Staging');
    expect(links.map((l) => l.name)).not.toContain('staging');
    expect(links.map((l) => l.name)).toContain('production');
  });

  it('drops entries with non-http(s) URLs', () => {
    const json = JSON.stringify({
      production: 'https://app.example.com',
      evil: 'javascript:alert(1)',
      ftp: 'ftp://files.example.com',
    });
    const links = parseEnvLinks(json, 'staging');
    expect(links.map((l) => l.name)).toEqual(['production']);
  });

  it('drops entries whose URL is not a valid URL at all', () => {
    const json = JSON.stringify({
      production: 'https://app.example.com',
      bad: 'not-a-url',
    });
    const links = parseEnvLinks(json, 'staging');
    expect(links.map((l) => l.name)).toEqual(['production']);
  });

  it('drops entries with non-string URL values', () => {
    const json = JSON.stringify({
      production: 'https://app.example.com',
      broken: 42,
    });
    const links = parseEnvLinks(json, 'staging');
    expect(links.map((l) => l.name)).toEqual(['production']);
  });

  it('orders: production > staging > test, then others alphabetically', () => {
    const json = JSON.stringify({
      alpha: 'https://alpha.example.com',
      test: 'https://test.example.com',
      production: 'https://app.example.com',
      staging: 'https://staging.example.com',
      beta: 'https://beta.example.com',
    });
    const links = parseEnvLinks(json, 'dev');
    expect(links.map((l) => l.name)).toEqual([
      'production',
      'staging',
      'test',
      'alpha',
      'beta',
    ]);
  });

  it('returns correct url values', () => {
    const json = JSON.stringify({
      production: 'https://app.example.com',
      staging: 'https://staging.example.com',
    });
    const links = parseEnvLinks(json, 'test');
    expect(links.find((l) => l.name === 'production')?.url).toBe(
      'https://app.example.com',
    );
  });

  it('handles http:// URLs (not just https)', () => {
    const json = JSON.stringify({ local: 'http://localhost:3000' });
    const links = parseEnvLinks(json, 'staging');
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('http://localhost:3000');
  });
});
