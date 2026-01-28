import { describe, it, expect } from 'vitest';
import { createSentryPlugin, SentryPlugin } from './index';

describe('opencode-sentry', () => {
  it('exports createSentryPlugin function', () => {
    expect(typeof createSentryPlugin).toBe('function');
  });

  it('exports default SentryPlugin', () => {
    expect(typeof SentryPlugin).toBe('function');
  });
});
