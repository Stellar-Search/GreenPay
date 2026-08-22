import AsyncStorage from '@react-native-async-storage/async-storage';
import { registerDeviceToken } from '../utils/notifications';

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));

const store = (AsyncStorage as any).__store as Record<string, string>;

describe('notification registration', () => {
  beforeEach(() => {
    Object.keys(store).forEach((key) => delete store[key]);
    jest.clearAllMocks();
    (AsyncStorage.setItem as jest.Mock).mockImplementation((key: string, value: string) => {
      store[key] = value;
      return Promise.resolve();
    });
    (AsyncStorage.removeItem as jest.Mock).mockImplementation((key: string) => {
      delete store[key];
      return Promise.resolve();
    });
    global.fetch = jest.fn();
  });

  it('returns false and queues a retry when registration gets a 4xx response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      json: jest.fn().mockResolvedValue({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
      }),
    });

    await expect(registerDeviceToken('ExponentPushToken[test]', 'GB123')).resolves.toBe(false);

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'greenpay:pendingPushRegistration',
      JSON.stringify({ token: 'ExponentPushToken[test]', walletAddress: 'GB123' })
    );
  });

  it('returns false and queues a retry when registration gets a 5xx response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      json: jest.fn().mockResolvedValue({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      }),
    });

    await expect(registerDeviceToken('ExponentPushToken[test]')).resolves.toBe(false);

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'greenpay:pendingPushRegistration',
      JSON.stringify({ token: 'ExponentPushToken[test]' })
    );
  });

  it('clears any pending retry after successful registration', async () => {
    store['greenpay:pendingPushRegistration'] = JSON.stringify({ token: 'old-token' });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ success: true, data: null }),
    });

    await expect(registerDeviceToken('ExponentPushToken[test]')).resolves.toBe(true);

    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('greenpay:pendingPushRegistration');
  });
});
