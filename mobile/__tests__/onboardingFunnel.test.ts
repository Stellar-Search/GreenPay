/**
 * __tests__/onboardingFunnel.test.ts
 *
 * The rule worth protecting here is the one that is easy to break by accident:
 * telemetry must never fire on an offline device, because the donate screen
 * promises that going offline touches the network not at all.
 */
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { track, getSessionId, completeFunnel, clearSession } from '../utils/funnel';

const SESSION_ID = '44444444-4444-4444-8444-444444444444';

function mockFetchReturning(body: unknown) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: body }),
  });
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
  return fetchMock;
}

function online() {
  (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: true, isInternetReachable: true });
}

function offline() {
  (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: false, isInternetReachable: false });
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  await clearSession();
});

describe('offline silence', () => {
  it('makes no network call at all when the device is offline', async () => {
    // The donate screen promises that going offline costs the donor nothing
    // and touches the network not at all. Telemetry underneath that promise
    // breaks it, and on a metered connection spends the donor's money to
    // record that they tried to spend their money.
    offline();
    const fetchMock = mockFetchReturning({ sessionId: SESSION_ID });

    await track('donate_intent', { path: 'connected_wallet' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not start a session while offline', async () => {
    offline();
    const fetchMock = mockFetchReturning({ sessionId: SESSION_ID });

    await expect(getSessionId()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not close a session while offline', async () => {
    offline();
    const fetchMock = mockFetchReturning({});

    await completeFunnel('completed');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats unknown reachability as offline rather than guessing', async () => {
    // NetInfo reports isInternetReachable: null before its first probe
    // resolves. Guessing "online" there is exactly the case that fires a
    // request during the offline donate flow.
    (NetInfo.fetch as jest.Mock).mockResolvedValue({
      isConnected: false,
      isInternetReachable: null,
    });
    const fetchMock = mockFetchReturning({ sessionId: SESSION_ID });

    await track('donate_intent');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a NetInfo failure as offline', async () => {
    (NetInfo.fetch as jest.Mock).mockRejectedValue(new Error('no radio'));
    const fetchMock = mockFetchReturning({ sessionId: SESSION_ID });

    await track('donate_intent');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('online behaviour', () => {
  it('starts one session and reuses it', async () => {
    online();
    const fetchMock = mockFetchReturning({ sessionId: SESSION_ID });

    await expect(getSessionId()).resolves.toBe(SESSION_ID);
    await expect(getSessionId()).resolves.toBe(SESSION_ID);

    const sessionCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith('/onboarding/sessions'),
    );
    expect(sessionCalls).toHaveLength(1);
  });

  it('records a stage against the session', async () => {
    online();
    const fetchMock = mockFetchReturning({ sessionId: SESSION_ID });

    await track('path_selected', { path: 'sponsored_account', projectId: 'proj-1' });

    const eventCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).endsWith('/onboarding/events'),
    );
    expect(eventCall).toBeDefined();
    expect(JSON.parse(eventCall![1].body)).toMatchObject({
      sessionId: SESSION_ID,
      stage: 'path_selected',
      path: 'sponsored_account',
    });
  });

  it('sends no device identifier of any kind', async () => {
    // Instrumenting a donation funnel is not a licence to build a profile.
    online();
    const fetchMock = mockFetchReturning({ sessionId: SESSION_ID });

    await track('donate_intent', { path: 'connected_wallet' });

    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse((init as { body: string }).body);
      expect(Object.keys(body)).not.toContain('deviceId');
      expect(Object.keys(body)).not.toContain('pushToken');
      expect(Object.keys(body)).not.toContain('advertisingId');
    }
  });

  it('never throws when the request fails', async () => {
    // A telemetry outage that stopped people donating would be a spectacular
    // own goal for a feature justified by conversion.
    online();
    (global as unknown as { fetch: unknown }).fetch = jest
      .fn()
      .mockRejectedValue(new Error('server on fire'));

    await expect(track('donation_recorded')).resolves.toBeUndefined();
  });

  it('never throws when the server answers with an error status', async () => {
    online();
    (global as unknown as { fetch: unknown }).fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, json: async () => ({}) });

    await expect(getSessionId()).resolves.toBeNull();
  });

  it('clears the session once the funnel completes', async () => {
    online();
    mockFetchReturning({ sessionId: SESSION_ID });

    await getSessionId();
    await completeFunnel('completed', 'sponsored_account');

    await expect(AsyncStorage.getItem('greenpay_onboarding_session')).resolves.toBeNull();
  });

  it('keeps the session open on an abandoned outcome, so the sweeper can see it', async () => {
    online();
    mockFetchReturning({ sessionId: SESSION_ID });

    await getSessionId();
    await completeFunnel('abandoned');

    await expect(AsyncStorage.getItem('greenpay_onboarding_session')).resolves.toBe(SESSION_ID);
  });
});
