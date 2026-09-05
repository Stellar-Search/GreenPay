/**
 * utils/notifications.ts
 * Push notification setup, permissions, channels, and token lifecycle helpers.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { AppState, Linking, Platform } from 'react-native';
import { apiFetch, parseApiFetchResponse } from './api';

export const PENDING_REGISTRATION_KEY = 'greenpay:pendingPushRegistration';
export const STORED_PUSH_TOKEN_KEY = 'greenpay:storedPushToken';

export type PendingRegistration = {
  token: string;
  walletAddress?: string;
};

export interface NotificationPermissionResult {
  granted: boolean;
  status: Notifications.PermissionStatus | 'granted' | 'denied' | 'undetermined';
  canAskAgain: boolean;
  needsSettings: boolean;
}

// Configure notification behavior for foreground presentation
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

/**
 * Set up the Android notification channel before any notification arrives.
 * Required on Android 8.0+ (API 26+) for notification display settings to take effect.
 */
export async function setupNotificationChannel(): Promise<void> {
  if (Platform.OS === 'android') {
    try {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#227239',
        sound: 'default',
        enableLights: true,
        enableVibrate: true,
      });
    } catch (error) {
      console.warn('Failed to set up Android notification channel:', error);
    }
  }
}

export async function getStoredPushToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(STORED_PUSH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function saveStoredPushToken(token: string): Promise<void> {
  try {
    await AsyncStorage.setItem(STORED_PUSH_TOKEN_KEY, token);
  } catch (error) {
    console.error('Error saving stored push token:', error);
  }
}

export async function clearStoredPushToken(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORED_PUSH_TOKEN_KEY);
  } catch (error) {
    console.error('Error clearing stored push token:', error);
  }
}

export async function savePendingRegistration(token: string, walletAddress?: string) {
  await AsyncStorage.setItem(
    PENDING_REGISTRATION_KEY,
    JSON.stringify({ token, walletAddress })
  );
}

export async function clearPendingRegistration() {
  await AsyncStorage.removeItem(PENDING_REGISTRATION_KEY);
}

export async function retryPendingRegistration(): Promise<void> {
  const pendingRegistration = await AsyncStorage.getItem(PENDING_REGISTRATION_KEY);
  if (!pendingRegistration) return;

  try {
    const { token, walletAddress } = JSON.parse(pendingRegistration) as PendingRegistration;
    if (token) {
      await registerDeviceToken(token, walletAddress);
    }
  } catch (error) {
    console.error('Error retrying pending push registration:', error);
  }
}

async function postJson(path: string, body: Record<string, unknown>): Promise<boolean> {
  const response = await apiFetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  try {
    await parseApiFetchResponse<unknown>(response);
  } catch (error) {
    console.error('Push notification request failed:', error);
    return false;
  }

  return true;
}

/**
 * Check current notification permission status without prompting.
 */
export async function checkNotificationPermissions(): Promise<NotificationPermissionResult> {
  try {
    const result = await Notifications.getPermissionsAsync();
    const granted = result.status === 'granted';
    const canAskAgain = result.canAskAgain ?? true;
    return {
      granted,
      status: result.status,
      canAskAgain,
      needsSettings: !granted && !canAskAgain,
    };
  } catch (error) {
    console.error('Error checking notification permissions:', error);
    return {
      granted: false,
      status: 'undetermined' as any,
      canAskAgain: true,
      needsSettings: false,
    };
  }
}

/**
 * Request notification permissions
 */
export async function requestNotificationPermissions(): Promise<string | null> {
  const { status: existingStatus, canAskAgain } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  
  if (existingStatus !== 'granted' && canAskAgain !== false) {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  
  if (finalStatus !== 'granted') {
    console.log('Push notification permission denied by user');
    return null;
  }
  
  return finalStatus;
}

/**
 * Request notification permissions on explicit user intent with rationale.
 * Returns structured result indicating whether settings need to be opened for recoverable denial.
 */
export async function requestNotificationPermissionsWithRationale(
  _rationale?: string
): Promise<NotificationPermissionResult> {
  try {
    await setupNotificationChannel();
    const current = await Notifications.getPermissionsAsync();
    if (current.status === 'granted') {
      return {
        granted: true,
        status: current.status,
        canAskAgain: current.canAskAgain ?? true,
        needsSettings: false,
      };
    }

    if (current.canAskAgain === false) {
      return {
        granted: false,
        status: current.status,
        canAskAgain: false,
        needsSettings: true,
      };
    }

    const requested = await Notifications.requestPermissionsAsync();
    const granted = requested.status === 'granted';
    return {
      granted,
      status: requested.status,
      canAskAgain: requested.canAskAgain ?? true,
      needsSettings: !granted && requested.canAskAgain === false,
    };
  } catch (error) {
    console.error('Error requesting notification permissions with rationale:', error);
    return {
      granted: false,
      status: 'denied' as any,
      canAskAgain: false,
      needsSettings: false,
    };
  }
}

/**
 * Direct the user to the device app settings screen to recover from denied permissions.
 */
export async function openNotificationSettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch (error) {
    console.error('Error opening notification settings:', error);
  }
}

/**
 * Get the device's push token and save it locally.
 */
export async function getPushToken(): Promise<string | null> {
  try {
    await setupNotificationChannel();
    const permissionStatus = await requestNotificationPermissions();
    if (!permissionStatus) return null;
    
    const tokenResult = await Notifications.getExpoPushTokenAsync({
      projectId: process.env.EXPO_PUBLIC_PROJECT_ID || '',
    });
    
    const token = tokenResult?.data;
    if (token) {
      await saveStoredPushToken(token);
    }
    return token ?? null;
  } catch (error) {
    console.error('Error getting push token:', error);
    return null;
  }
}

/**
 * Register device token with backend and link to walletAddress if provided.
 */
export async function registerDeviceToken(
  token: string,
  walletAddress?: string
): Promise<boolean> {
  try {
    const platform = Platform.OS;
    
    const registered = await postJson('/api/notifications/register', {
      token,
      platform,
      walletAddress: walletAddress || null,
    });

    if (!registered) {
      await savePendingRegistration(token, walletAddress);
      return false;
    }

    await saveStoredPushToken(token);
    await clearPendingRegistration();
    console.log('Device token registered successfully');
    return true;
  } catch (error) {
    console.error('Network error registering device token:', error);
    await savePendingRegistration(token, walletAddress);
    return false;
  }
}

/**
 * Synchronize the active push token with a newly connected or disconnected wallet.
 * Passing undefined/null as walletAddress disassociates the device token from any wallet.
 */
export async function syncPushTokenWithWallet(
  walletAddress?: string | null
): Promise<boolean> {
  const storedToken = await getStoredPushToken();
  if (!storedToken) {
    const pending = await AsyncStorage.getItem(PENDING_REGISTRATION_KEY);
    if (pending) {
      try {
        const parsed = JSON.parse(pending) as PendingRegistration;
        if (parsed.token) {
          return await registerDeviceToken(parsed.token, walletAddress || undefined);
        }
      } catch {}
    }
    return false;
  }
  return await registerDeviceToken(storedToken, walletAddress || undefined);
}

/**
 * Handle push token rotation: updates local storage, registers the new token,
 * and clears wallet association on the previous token so no stale registrations remain.
 */
export async function handleTokenRotation(
  newToken: string,
  walletAddress?: string | null
): Promise<boolean> {
  if (!newToken) return false;
  const oldToken = await getStoredPushToken();

  await saveStoredPushToken(newToken);
  const success = await registerDeviceToken(newToken, walletAddress || undefined);

  if (oldToken && oldToken !== newToken) {
    try {
      await postJson('/api/notifications/register', {
        token: oldToken,
        platform: Platform.OS,
        walletAddress: null,
      });
    } catch {
      // Non-fatal: backend Expo receipt checking prunes dead tokens
    }
  }

  return success;
}

/**
 * Follow a project for push notifications
 */
export async function followProject(
  projectId: string,
  token: string,
  walletAddress?: string
): Promise<boolean> {
  try {
    const followed = await postJson('/api/notifications/follow', {
      projectId,
      token,
      walletAddress,
    });

    if (!followed) return false;
    
    console.log(`Followed project ${projectId}`);
    return true;
  } catch (error) {
    console.error('Network error following project:', error);
    return false;
  }
}

/**
 * Unfollow a project
 */
export async function unfollowProject(
  projectId: string,
  token: string
): Promise<boolean> {
  try {
    const unfollowed = await postJson('/api/notifications/unfollow', {
      projectId,
      token,
    });

    if (!unfollowed) return false;
    
    console.log(`Unfollowed project ${projectId}`);
    return true;
  } catch (error) {
    console.error('Network error unfollowing project:', error);
    return false;
  }
}

/**
 * Get all projects followed by the device
 */
export async function getFollowedProjects(token: string): Promise<any[]> {
  try {
    const response = await apiFetch(`/api/notifications/follows?token=${encodeURIComponent(token)}`);
    return await parseApiFetchResponse<any[]>(response);
  } catch (error) {
    console.error('Error getting followed projects:', error);
    return [];
  }
}

/**
 * Set up notification listener and background retry handlers.
 */
export function setupNotificationListener(options?: {
  onNotificationReceived?: (notification: Notifications.Notification) => void;
  onNotificationResponse?: (response: Notifications.NotificationResponse) => void;
  onPushTokenRotated?: (newToken: string) => void;
  getWalletAddress?: () => Promise<string | null>;
}) {
  void setupNotificationChannel();

  const notificationSubscription = Notifications.addNotificationReceivedListener((notification) => {
    console.log('Notification received:', notification);
    options?.onNotificationReceived?.(notification);
  });

  let responseSubscription: Notifications.Subscription | null = null;
  if (options?.onNotificationResponse) {
    responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
      options.onNotificationResponse!(response);
    });
  }

  let tokenSubscription: Notifications.Subscription | null = null;
  if (typeof Notifications.addPushTokenListener === 'function') {
    tokenSubscription = Notifications.addPushTokenListener(async (tokenData) => {
      const newToken = tokenData?.data;
      if (newToken) {
        const walletAddress = options?.getWalletAddress ? await options.getWalletAddress() : null;
        await handleTokenRotation(newToken, walletAddress);
        options?.onPushTokenRotated?.(newToken);
      }
    });
  }

  const appStateSubscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      retryPendingRegistration();
    }
  });
  
  return {
    remove: () => {
      notificationSubscription.remove();
      responseSubscription?.remove();
      tokenSubscription?.remove();
      appStateSubscription.remove();
    },
  };
}
