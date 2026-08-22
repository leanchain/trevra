import { afterEach, describe, expect, it, vi } from 'vitest';
import { updateLinkedInManagerSeat, updateLinkedInSeatCapabilities } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LinkedIn manager client API wiring', () => {
  it('sends warmupOverride to the manager seat PATCH endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ seat: { seatKey: 'owner', warmupOverride: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const seat = await updateLinkedInManagerSeat('owner', { warmupOverride: true });
    expect(seat.warmupOverride).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/linkedin/manager/seats/owner');
    expect(init.method).toBe('PATCH');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(String(init.body))).toEqual({ warmupOverride: true });
  });

  it('uses the separate capabilities endpoint only when the form asks for it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ seat: { seatKey: 'owner' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await updateLinkedInSeatCapabilities('owner', {
      inmail: 'unknown',
      premium: false,
      salesNavigator: false,
      recruiter: false,
      inmailMonthlyBudget: null,
      inmailPaidCreditCap: null
    });
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/linkedin/manager/seats/owner/capabilities');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({
      inmail: 'unknown',
      premium: false,
      salesNavigator: false,
      recruiter: false,
      inmailMonthlyBudget: null,
      inmailPaidCreditCap: null
    });
  });
});
