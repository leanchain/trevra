import { describe, expect, it, vi } from 'vitest';
import { TrevraBillingClient, billingEnabled } from './billing-client.js';

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('TrevraBillingClient', () => {
  it('uses Authward discovery + client_credentials and scopes every request to trevra', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/.well-known/openid-configuration')) {
        return json({ token_endpoint: 'https://auth.example.test/api/auth/oauth2/token' });
      }
      if (url.endsWith('/api/auth/oauth2/token')) {
        return json({ access_token: 'machine-token', expires_in: 900 });
      }
      if (url.endsWith('/subscription')) return json({ status: 'inactive', plan_code: null });
      if (url.endsWith('/credits')) {
        return json({
          balance: '0',
          usage: '0',
          available: '0',
          period_start: null,
          period_end: null
        });
      }
      if (url.endsWith('/entitlements')) return json({ features: {} });
      if (url.includes('/v1/trevra/customers/')) {
        return json({
          id: 'cus_internal',
          product: 'trevra',
          external_customer_id: 'ws_123',
          name: 'Acme',
          billing_email: null,
          currency: 'USD',
          stripe_customer_id: null,
          plan_code: null
        });
      }
      return json({ error: 'unexpected' }, 500);
    });
    const fetchImpl = fetchSpy as unknown as typeof fetch;

    const client = new TrevraBillingClient(
      {
        baseUrl: 'https://billing.example.test',
        authwardIssuer: 'https://auth.example.test',
        clientId: 'trevra-billing',
        clientSecret: 'secret',
        audience: 'https://billing.olaryn.com'
      },
      fetchImpl
    );

    const snapshot = await client.workspaceSnapshot({ workspaceId: 'ws_123', name: 'Acme' });
    expect(snapshot.customer.product).toBe('trevra');
    expect(snapshot.credits.available).toBe('0');

    const tokenCall = calls.find((call) => call.url.endsWith('/api/auth/oauth2/token'));
    expect(String(tokenCall?.init?.body)).toContain('grant_type=client_credentials');
    expect(String(tokenCall?.init?.body)).toContain('scope=billing%3Aaccess');
    expect(String(tokenCall?.init?.body)).toContain('resource=https%3A%2F%2Fbilling.olaryn.com');
    expect(tokenCall?.init?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from('trevra-billing:secret').toString('base64')}`
    });

    const productCalls = calls.filter((call) => call.url.includes('/v1/'));
    expect(productCalls).toHaveLength(4);
    expect(productCalls.every((call) => call.url.includes('/v1/trevra/customers/ws_123'))).toBe(
      true
    );
    expect(
      fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/oauth2/token'))
    ).toHaveLength(1);
  });

  it('stays disabled unless endpoint, secret, and Authward issuer are all present', () => {
    expect(billingEnabled({})).toBe(false);
    expect(
      billingEnabled({
        BILLING_BASE_URL: 'https://billing.olaryn.com',
        BILLING_CLIENT_SECRET: 'secret',
        AUTHWARD_ISSUER: 'https://auth.olaryn.com'
      })
    ).toBe(true);
  });
});
