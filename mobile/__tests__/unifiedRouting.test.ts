/**
 * __tests__/unifiedRouting.test.ts
 *
 * Test harness for the unified routing system covering cold start, warm start,
 * deep links, and push/local notification taps.
 */
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppInitProvider } from '../src/context/AppInitContext';
import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import { useDeepLink } from '../hooks/useDeepLink';

const mockPush = jest.fn();
let mockInitialUrl: string | null = null;
let mockInitialNotificationResponse: any = null;
let urlListener: ((event: { url: string }) => void) | null = null;
let notificationResponseListener: ((response: any) => void) | null = null;

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('expo-linking', () => ({
  getInitialURL: jest.fn(() => Promise.resolve(mockInitialUrl)),
  addEventListener: jest.fn((event: string, handler: (e: { url: string }) => void) => {
    urlListener = handler;
    return { remove: jest.fn(() => { urlListener = null; }) };
  }),
}));

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn().mockResolvedValue(undefined),
  getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  getExpoPushTokenAsync: jest.fn().mockResolvedValue({ data: 'ExponentPushToken[test]' }),
  getLastNotificationResponseAsync: jest.fn(() => Promise.resolve(mockInitialNotificationResponse)),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn((handler: (res: any) => void) => {
    notificationResponseListener = handler;
    return { remove: jest.fn(() => { notificationResponseListener = null; }) };
  }),
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
}));

jest.mock('../utils/recurringDonations', () => ({
  getRecurringDonation: jest.fn((id: string) => {
    if (id === 'rec_active') {
      return Promise.resolve({
        id: 'rec_active',
        projectId: 'proj-trees',
        amountXLM: '15.0000000',
        status: 'active',
      });
    }
    return Promise.resolve(null);
  }),
  rescheduleAllRecurringReminders: jest.fn().mockResolvedValue(undefined),
}));

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(AppInitProvider, null, children);

describe('Unified Routing System (Deep Links & Notification Taps)', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockInitialUrl = null;
    mockInitialNotificationResponse = null;
    urlListener = null;
    notificationResponseListener = null;
    jest.clearAllMocks();
  });

  describe('Cold Start Routing', () => {
    it('routes cold-start deep link after hydration completes', async () => {
      mockInitialUrl = 'greenpay://project/proj-cold-1';

      const { unmount } = renderHook(() => useDeepLink(), { wrapper });
      await act(async () => {});

      expect(mockPush).toHaveBeenCalledWith('/projects/proj-cold-1');
      expect(mockPush).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('routes cold-start notification tap after hydration completes', async () => {
      mockInitialNotificationResponse = {
        actionIdentifier: 'default',
        notification: {
          request: {
            content: {
              data: {
                type: 'project_update',
                projectId: 'proj-cold-notif',
                updateId: 'up-999',
              },
            },
          },
        },
      };

      const { unmount } = renderHook(() => useDeepLink(), { wrapper });
      await act(async () => {});

      expect(mockPush).toHaveBeenCalledWith('/projects/proj-cold-notif');
      expect(mockPush).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('routes cold-start donation notification tap with amount param', async () => {
      mockInitialNotificationResponse = {
        notification: {
          request: {
            content: {
              data: {
                type: 'donation',
                projectId: 'proj-ocean',
                amount: '50.00',
              },
            },
          },
        },
      };

      const { unmount } = renderHook(() => useDeepLink(), { wrapper });
      await act(async () => {});

      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/donate/[id]',
        params: { id: 'proj-ocean', amount: '50.00' },
      });
      unmount();
    });
  });

  describe('Warm Start Routing', () => {
    it('routes warm-start deep link immediately', async () => {
      const { unmount } = renderHook(() => useDeepLink(), { wrapper });
      await act(async () => {});

      expect(urlListener).toBeDefined();

      await act(async () => {
        urlListener?.({ url: 'greenpay://donate/proj-warm-1?amount=20' });
      });

      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/donate/[id]',
        params: { id: 'proj-warm-1', amount: '20' },
      });
      unmount();
    });

    it('routes warm-start milestone / project_update notification tap immediately', async () => {
      const { unmount } = renderHook(() => useDeepLink(), { wrapper });
      await act(async () => {});

      expect(notificationResponseListener).toBeDefined();

      await act(async () => {
        notificationResponseListener?.({
          notification: {
            request: {
              content: {
                data: {
                  type: 'milestone',
                  projectId: 'proj-warm-milestone',
                },
              },
            },
          },
        });
      });

      expect(mockPush).toHaveBeenCalledWith('/projects/proj-warm-milestone');
      unmount();
    });

    it('routes warm-start recurring reminder notification tap to donate screen for active reminder', async () => {
      const { unmount } = renderHook(() => useDeepLink(), { wrapper });
      await act(async () => {});

      expect(notificationResponseListener).toBeDefined();

      await act(async () => {
        notificationResponseListener?.({
          notification: {
            request: {
              content: {
                data: {
                  type: 'recurring',
                  recurringId: 'rec_active',
                },
              },
            },
          },
        });
      });

      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/donate/[id]',
        params: {
          id: 'proj-trees',
          recurringId: 'rec_active',
          amount: '15.0000000',
        },
      });
      unmount();
    });
  });

  describe('Hostile & Malformed Input Isolation', () => {
    it('does not route for malformed deep links', async () => {
      const { unmount } = renderHook(() => useDeepLink(), { wrapper });
      await act(async () => {});

      await act(async () => {
        urlListener?.({ url: 'greenpay://donate/../../etc/passwd' });
      });
      expect(mockPush).not.toHaveBeenCalled();

      await act(async () => {
        urlListener?.({ url: 'greenpay://donate/proj-1?evil=1' });
      });
      expect(mockPush).not.toHaveBeenCalled();

      unmount();
    });

    it('does not route for malformed or attacker-controlled notification payloads', async () => {
      const { unmount } = renderHook(() => useDeepLink(), { wrapper });
      await act(async () => {});

      await act(async () => {
        notificationResponseListener?.({
          notification: {
            request: {
              content: {
                data: {
                  type: 'project_update',
                  projectId: 'proj/../../etc/passwd',
                },
              },
            },
          },
        });
      });
      expect(mockPush).not.toHaveBeenCalled();

      await act(async () => {
        notificationResponseListener?.({
          notification: {
            request: {
              content: {
                data: {
                  url: 'https://evil.com/phishing',
                },
              },
            },
          },
        });
      });
      expect(mockPush).not.toHaveBeenCalled();

      unmount();
    });
  });
});
