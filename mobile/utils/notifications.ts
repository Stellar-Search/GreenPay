/**
 * utils/notifications.ts
 * Push notification setup and helpers
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';
import { apiFetch, parseApiFetchResponse } from './api';

const PENDING_REGISTRATION_KEY = 'greenpay:pendingPushRegistration';

type PendingRegistration = {
  token: string;
  walletAddress?: string;
};

// Configure notification behavior
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

async function savePendingRegistration(token: string, walletAddress?: string) {
  await AsyncStorage.setItem(
    PENDING_REGISTRATION_KEY,
    JSON.stringify({ token, walletAddress })
  );
}

async function clearPendingRegistration() {
  await AsyncStorage.removeItem(PENDING_REGISTRATION_KEY);
}

async function retryPendingRegistration() {
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
 * Request notification permissions
 */
export async function requestNotificationPermissions(): Promise<string | null> {
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  
  if (existingStatus !== 'granted') {
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
 * Get the device's push token
 */
export async function getPushToken(): Promise<string | null> {
  try {
    const permissionStatus = await requestNotificationPermissions();
    if (!permissionStatus) return null;
    
    const token = await Notifications.getExpoPushTokenAsync({
      projectId: process.env.EXPO_PUBLIC_PROJECT_ID || '',
    });
    
    return token.data;
  } catch (error) {
    console.error('Error getting push token:', error);
    return null;
  }
}

/**
 * Register device token with backend
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
      walletAddress,
    });

    if (!registered) {
      await savePendingRegistration(token, walletAddress);
      return false;
    }

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
 * Set up notification listener
 */
export function setupNotificationListener() {
  const notificationSubscription = Notifications.addNotificationReceivedListener(notification => {
    console.log('Notification received:', notification);
  });

  const appStateSubscription = AppState.addEventListener('change', state => {
    if (state === 'active') {
      retryPendingRegistration();
    }
  });
  
  return {
    remove: () => {
      notificationSubscription.remove();
      appStateSubscription.remove();
    },
  };
}
