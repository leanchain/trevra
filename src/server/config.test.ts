import { describe, expect, it } from 'vitest';
import { validateEnvironment } from './config.js';

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://trevra:password@localhost:5432/trevra',
  APP_ORIGIN: 'http://localhost:43173,http://localhost:43887'
};

describe('runtime configuration', () => {
  it('treats empty optional URL environment values as unset', () => {
    expect(() => validateEnvironment({
      ...base,
      PUBLIC_REGISTRY_API_URL: '',
      TREVRA_SANDBOX_GATEWAY_URL: '',
      BETTER_AUTH_URL: '',
      PUBLIC_SITE_URL: ''
    })).not.toThrow();
  });
});
