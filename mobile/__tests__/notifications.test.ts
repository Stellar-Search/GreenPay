import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Linking, Platform } from 'react-native';
import {
  registerDeviceToken,
  setupNotificationChannel,
  syncPushTokenWithWallet,
  handleTokenRotation,
  getStoredPushToken,
  saveStoredPushToken,
  requestNotificationPermissionsWithRationale,
  openNotificationSettings,
  followProject,
  unfollowProject,
  STORED_PUSH_TOKEN_KEY,
  PENDING_REGISTRATION_KEY,
} from '../utils/notifications';

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn().mockResolvedValue(undefined),
  getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted', canAskAgain: true }),
  requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted', canAskAgain: true }),
  getExpoPushTokenAsync: jest.fn().mockResolvedValue({ data: 'ExponentPushToken[mock-token]' }),
  scheduleNotificationAsync: jest.fn().mockResolvedValue('notif-test'),
  cancelScheduledNotificationAsync: jest.fn().mockResolvedValue(undefined),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
  AndroidImportance: {
    HIGH: 4,
    MAX: 5,
  },
}));

jest.mock('react-native/Libraries/Linking/Linking', () => ({
  openSettings: jest.fn().mockResolvedValue(undefined),
  openURL: jest.fn().mockResolvedValue(undefined),
}));

const store = (AsyncStorage as any).__store as Record<string, string>;

describe('notifications utility', () => {
  beforeEach(() => {
    Object.keys(store).forEach((key) => delete store[key]);
    jest.clearAllMocks();
    (AsyncStorage.getItem as jest.Mock).mockImplementation((key: string) => {
      return Promise.resolve(store[key] ?? null);
    });
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

  describe('Android Notification Channel', () => {
    it('creates the default notification channel on Android', async () => {
      const originalPlatform = Platform.OS;
      (Platform as any).OS = 'android';

      await setupNotificationChannel();

      expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith('default', {
        name: 'Default',
        importance: 4,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#227239',
        sound: 'default',
        enableLights: true,
        enableVibrate: true,
      });

      (Platform as any).OS = originalPlatform;
    });
  });

  describe('Device token registration & retries', () => {
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
        PENDING_REGISTRATION_KEY,
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
        PENDING_REGISTRATION_KEY,
        JSON.stringify({ token: 'ExponentPushToken[test]' })
      );
    });

    it('clears any pending retry and saves stored token after successful registration', async () => {
      store[PENDING_REGISTRATION_KEY] = JSON.stringify({ token: 'old-token' });
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({ success: true, data: { tokenId: 'uuid-123' } }),
      });

      await expect(registerDeviceToken('ExponentPushToken[test]')).resolves.toBe(true);

      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(PENDING_REGISTRATION_KEY);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(STORED_PUSH_TOKEN_KEY, 'ExponentPushToken[test]');
    });
  });

  describe('Wallet Lifecycle Integration', () => {
    it('syncPushTokenWithWallet registers stored token with connected wallet address', async () => {
      store[STORED_PUSH_TOKEN_KEY] = 'ExponentPushToken[device-1]';
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({ success: true, data: {} }),
      });

      const result = await syncPushTokenWithWallet('GA4JHZX455IELW533547WFB5LV57LLSUJURFFIIYG7AV4HTQNW4W4FUD');
      expect(result).toBe(true);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('notifications/register'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            token: 'ExponentPushToken[device-1]',
            platform: Platform.OS,
            walletAddress: 'GA4JHZX455IELW533547WFB5LV57LLSUJURFFIIYG7AV4HTQNW4W4FUD',
          }),
        })
      );
    });

    it('syncPushTokenWithWallet disassociates wallet address when wallet disconnects', async () => {
      store[STORED_PUSH_TOKEN_KEY] = 'ExponentPushToken[device-1]';
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({ success: true, data: {} }),
      });

      const result = await syncPushTokenWithWallet(null);
      expect(result).toBe(true);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('notifications/register'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            token: 'ExponentPushToken[device-1]',
            platform: Platform.OS,
            walletAddress: null,
          }),
        })
      );
    });
  });

  describe('Token Rotation', () => {
    it('handles token rotation without leaving stale registrations', async () => {
      store[STORED_PUSH_TOKEN_KEY] = 'ExponentPushToken[old-token]';
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({ success: true, data: {} }),
      });

      const result = await handleTokenRotation(
        'ExponentPushToken[new-token]',
        'GA4JHZX455IELW533547WFB5LV57LLSUJURFFIIYG7AV4HTQNW4W4FUD'
      );

      expect(result).toBe(true);
      expect(store[STORED_PUSH_TOKEN_KEY]).toBe('ExponentPushToken[new-token]');

      // Should register new token
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('notifications/register'),
        expect.objectContaining({
          body: JSON.stringify({
            token: 'ExponentPushToken[new-token]',
            platform: Platform.OS,
            walletAddress: 'GA4JHZX455IELW533547WFB5LV57LLSUJURFFIIYG7AV4HTQNW4W4FUD',
          }),
        })
      );

      // Should clear old token wallet link
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('notifications/register'),
        expect.objectContaining({
          body: JSON.stringify({
            token: 'ExponentPushToken[old-token]',
            platform: Platform.OS,
            walletAddress: null,
          }),
        })
      );
    });
  });

  describe('Permission Rationale & Recoverable Denial', () => {
    it('returns granted immediately if already granted', async () => {
      (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: 'granted',
        canAskAgain: true,
      });

      const result = await requestNotificationPermissionsWithRationale();
      expect(result.granted).toBe(true);
      expect(result.needsSettings).toBe(false);
      expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    });

    it('requests permission if undetermined and user can be asked', async () => {
      (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: 'undetermined',
        canAskAgain: true,
      });
      (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: 'granted',
        canAskAgain: true,
      });

      const result = await requestNotificationPermissionsWithRationale('Project updates');
      expect(result.granted).toBe(true);
      expect(Notifications.requestPermissionsAsync).toHaveBeenCalled();
    });

    it('detects permanently denied permission and flags recoverable settings requirement', async () => {
      (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: 'denied',
        canAskAgain: false,
      });

      const result = await requestNotificationPermissionsWithRationale();
      expect(result.granted).toBe(false);
      expect(result.needsSettings).toBe(true);
      expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    });

    it('openNotificationSettings invokes Linking.openSettings', async () => {
      await openNotificationSettings();
      expect(Linking.openSettings).toHaveBeenCalled();
    });
  });

  describe('Follow & Unfollow Projects', () => {
    it('follows project with push token and wallet address', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 201,
        json: jest.fn().mockResolvedValue({ success: true, data: { followId: 'f-1' } }),
      });

      const ok = await followProject('proj-123', 'ExponentPushToken[test]', 'GB456');
      expect(ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('notifications/follow'),
        expect.objectContaining({
          body: JSON.stringify({
            projectId: 'proj-123',
            token: 'ExponentPushToken[test]',
            walletAddress: 'GB456',
          }),
        })
      );
    });

    it('unfollows project with push token', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({ success: true, data: { deleted: true } }),
      });

      const ok = await unfollowProject('proj-123', 'ExponentPushToken[test]');
      expect(ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('notifications/unfollow'),
        expect.objectContaining({
          body: JSON.stringify({
            projectId: 'proj-123',
            token: 'ExponentPushToken[test]',
          }),
        })
      );
    });
  });
});
