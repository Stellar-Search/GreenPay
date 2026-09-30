/**
 * __tests__/navigationDestinations.test.ts
 *
 * Comprehensive unit and fuzz tests for the unified destination model
 * and allowlist validation (navigationDestinations.ts).
 */
import fc from 'fast-check';
import {
  resolveDeepLinkDestination,
  resolveNotificationDestination,
  resolveAnyDestination,
  navigateToDestination,
  isValidProjectId,
  isValidRecurringId,
  isValidStellarAddress,
  isValidAmount,
  isValidScreen,
  AppDestination,
} from '../utils/navigationDestinations';

describe('navigationDestinations validation helpers', () => {
  it('validates project IDs strictly', () => {
    expect(isValidProjectId('proj-123')).toBe(true);
    expect(isValidProjectId('proj_ABC-456')).toBe(true);
    expect(isValidProjectId('12345')).toBe(true);
    expect(isValidProjectId('')).toBe(false);
    expect(isValidProjectId('a'.repeat(65))).toBe(false);
    expect(isValidProjectId('../etc/passwd')).toBe(false);
    expect(isValidProjectId('proj/123')).toBe(false);
    expect(isValidProjectId('proj?evil=1')).toBe(false);
    expect(isValidProjectId(null)).toBe(false);
    expect(isValidProjectId(123)).toBe(false);
  });

  it('validates recurring IDs strictly', () => {
    expect(isValidRecurringId('rec_123_456')).toBe(true);
    expect(isValidRecurringId('rec-abc')).toBe(true);
    expect(isValidRecurringId('')).toBe(false);
    expect(isValidRecurringId('rec/123')).toBe(false);
    expect(isValidRecurringId(null)).toBe(false);
  });

  it('validates Stellar addresses strictly', () => {
    const validKey = 'GA4JHZX455IELW533547WFB5LV57LLSUJURFFIIYG7AV4HTQNW4W4FUD';
    expect(isValidStellarAddress(validKey)).toBe(true);
    expect(isValidStellarAddress('invalid-address')).toBe(false);
    expect(isValidStellarAddress('SA4JHZX455IELW533547WFB5LV57LLSUJURFFIIYG7AV4HTQNW4W4FUD')).toBe(false);
    expect(isValidStellarAddress(null)).toBe(false);
    expect(isValidStellarAddress(123)).toBe(false);
  });

  it('validates amounts strictly', () => {
    expect(isValidAmount('10')).toBe(true);
    expect(isValidAmount('10.5')).toBe(true);
    expect(isValidAmount('0.0000001')).toBe(true);
    expect(isValidAmount(50)).toBe(true);
    expect(isValidAmount('0')).toBe(false);
    expect(isValidAmount('-5')).toBe(false);
    expect(isValidAmount('10.12345678')).toBe(false); // exceeds 7 decimals
    expect(isValidAmount('abc')).toBe(false);
    expect(isValidAmount(null)).toBe(false);
  });

  it('validates screen allowlist strictly', () => {
    expect(isValidScreen('home')).toBe(true);
    expect(isValidScreen('projects')).toBe(true);
    expect(isValidScreen('impact')).toBe(true);
    expect(isValidScreen('leaderboard')).toBe(true);
    expect(isValidScreen('recurring')).toBe(true);
    expect(isValidScreen('scan')).toBe(true);
    expect(isValidScreen('sync-conflicts')).toBe(true);
    expect(isValidScreen('admin')).toBe(false);
    expect(isValidScreen('settings')).toBe(false);
    expect(isValidScreen('')).toBe(false);
  });
});

describe('resolveDeepLinkDestination', () => {
  describe('Custom Scheme greenpay://', () => {
    it('resolves project URLs', () => {
      expect(resolveDeepLinkDestination('greenpay://project/proj-42')).toEqual({
        type: 'project',
        projectId: 'proj-42',
      });
      expect(resolveDeepLinkDestination('greenpay://projects/proj-42')).toEqual({
        type: 'project',
        projectId: 'proj-42',
      });
    });

    it('resolves donate URLs with and without params', () => {
      expect(resolveDeepLinkDestination('greenpay://donate/proj-42')).toEqual({
        type: 'donate',
        projectId: 'proj-42',
      });
      expect(resolveDeepLinkDestination('greenpay://donate/proj-42?amount=25.5')).toEqual({
        type: 'donate',
        projectId: 'proj-42',
        amount: '25.5',
      });
      expect(
        resolveDeepLinkDestination('greenpay://donate/proj-42?amount=25.5&recurringId=rec-100')
      ).toEqual({
        type: 'donate',
        projectId: 'proj-42',
        amount: '25.5',
        recurringId: 'rec-100',
      });
    });

    it('resolves recurring URLs', () => {
      expect(resolveDeepLinkDestination('greenpay://recurring/rec-100')).toEqual({
        type: 'recurring',
        recurringId: 'rec-100',
      });
      expect(resolveDeepLinkDestination('greenpay://recurring')).toEqual({
        type: 'screen',
        screen: 'recurring',
      });
    });

    it('resolves profile URLs with valid Stellar public key', () => {
      const addr = 'GA4JHZX455IELW533547WFB5LV57LLSUJURFFIIYG7AV4HTQNW4W4FUD';
      expect(resolveDeepLinkDestination(`greenpay://profile/${addr}`)).toEqual({
        type: 'profile',
        address: addr,
      });
    });

    it('resolves standalone app screens', () => {
      expect(resolveDeepLinkDestination('greenpay://impact')).toEqual({
        type: 'screen',
        screen: 'impact',
      });
      expect(resolveDeepLinkDestination('greenpay://leaderboard')).toEqual({
        type: 'screen',
        screen: 'leaderboard',
      });
      expect(resolveDeepLinkDestination('greenpay://scan')).toEqual({
        type: 'screen',
        screen: 'scan',
      });
      expect(resolveDeepLinkDestination('greenpay://sync-conflicts')).toEqual({
        type: 'screen',
        screen: 'sync-conflicts',
      });
      expect(resolveDeepLinkDestination('greenpay://home')).toEqual({
        type: 'screen',
        screen: 'home',
      });
    });

    it('rejects hostile / malformed custom-scheme URLs', () => {
      expect(resolveDeepLinkDestination('greenpay://donate/../../etc/passwd')).toBeNull();
      expect(resolveDeepLinkDestination('greenpay://donate/proj-1?evil=1')).toBeNull();
      expect(resolveDeepLinkDestination('greenpay://donate/proj-1?amount=-50')).toBeNull();
      expect(resolveDeepLinkDestination('greenpay://donate/proj-1/extra-segment')).toBeNull();
      expect(resolveDeepLinkDestination('greenpay://unknown-segment/123')).toBeNull();
      expect(resolveDeepLinkDestination('greenpay://profile/not-a-stellar-key')).toBeNull();
      expect(resolveDeepLinkDestination('GREENPAY://project/42')).toBeNull();
      expect(resolveDeepLinkDestination('greenpay://evil.com/donate/123')).toBeNull();
    });
  });

  describe('HTTPS Universal Links', () => {
    it('resolves https://greenpay.app/donate?projectId=...', () => {
      expect(
        resolveDeepLinkDestination('https://greenpay.app/donate?projectId=proj-99')
      ).toEqual({
        type: 'donate',
        projectId: 'proj-99',
      });
      expect(
        resolveDeepLinkDestination('https://greenpay.app/donate?projectId=proj-99&amount=5.00')
      ).toEqual({
        type: 'donate',
        projectId: 'proj-99',
        amount: '5.00',
      });
    });

    it('resolves https://greenpay.app/projects/<id>', () => {
      expect(resolveDeepLinkDestination('https://greenpay.app/projects/proj-99')).toEqual({
        type: 'project',
        projectId: 'proj-99',
      });
      expect(resolveDeepLinkDestination('https://greenpay.app/project/proj-99')).toEqual({
        type: 'project',
        projectId: 'proj-99',
      });
    });

    it('resolves https://greenpay.app/recurring, /impact, /leaderboard', () => {
      expect(resolveDeepLinkDestination('https://greenpay.app/recurring')).toEqual({
        type: 'screen',
        screen: 'recurring',
      });
      expect(resolveDeepLinkDestination('https://greenpay.app/impact')).toEqual({
        type: 'screen',
        screen: 'impact',
      });
      expect(resolveDeepLinkDestination('https://greenpay.app/leaderboard')).toEqual({
        type: 'screen',
        screen: 'leaderboard',
      });
    });

    it('rejects untrusted hosts, invalid paths, and parameter injection on HTTPS links', () => {
      expect(resolveDeepLinkDestination('https://evil.com/donate?projectId=proj-99')).toBeNull();
      expect(resolveDeepLinkDestination('https://greenpay.app.evil.com/donate?projectId=proj-99')).toBeNull();
      expect(resolveDeepLinkDestination('https://greenpay.app/donate?projectId=proj-99&attacker=true')).toBeNull();
      expect(resolveDeepLinkDestination('http://greenpay.app/donate?projectId=proj-99')).toBeNull();
      expect(resolveDeepLinkDestination('https://greenpay.app/unknown')).toBeNull();
      expect(resolveDeepLinkDestination('https://greenpay.app/projects/../../etc/passwd')).toBeNull();
    });
  });
});

describe('resolveNotificationDestination', () => {
  it('resolves milestone / project_update push notifications', () => {
    expect(
      resolveNotificationDestination({
        type: 'project_update',
        projectId: 'proj-ocean-clean',
        updateId: 'up-123',
      })
    ).toEqual({
      type: 'project',
      projectId: 'proj-ocean-clean',
    });

    expect(
      resolveNotificationDestination({
        type: 'project_update_removed',
        projectId: 'proj-ocean-clean',
      })
    ).toEqual({
      type: 'project',
      projectId: 'proj-ocean-clean',
    });

    expect(
      resolveNotificationDestination({
        type: 'milestone',
        projectId: 'proj-reforest',
      })
    ).toEqual({
      type: 'project',
      projectId: 'proj-reforest',
    });
  });

  it('resolves donation notifications', () => {
    expect(
      resolveNotificationDestination({
        type: 'donation',
        projectId: 'proj-clean-water',
        amount: '100.00',
      })
    ).toEqual({
      type: 'donate',
      projectId: 'proj-clean-water',
      amount: '100.00',
    });
  });

  it('resolves recurring donation reminders', () => {
    expect(
      resolveNotificationDestination({
        type: 'recurring',
        recurringId: 'rec_month_5',
        projectId: 'proj-clean-water',
      })
    ).toEqual({
      type: 'recurring',
      recurringId: 'rec_month_5',
      projectId: 'proj-clean-water',
    });

    expect(
      resolveNotificationDestination({
        type: 'recurring_reminder',
        recurringId: 'rec_month_5',
      })
    ).toEqual({
      type: 'recurring',
      recurringId: 'rec_month_5',
    });
  });

  it('resolves notification payloads wrapped in Expo NotificationResponse format', () => {
    const expoResponse = {
      actionIdentifier: 'default',
      notification: {
        request: {
          content: {
            title: 'Project Update',
            body: 'Milestone reached!',
            data: {
              type: 'project_update',
              projectId: 'proj-amazon-protect',
            },
          },
        },
      },
    };

    expect(resolveNotificationDestination(expoResponse)).toEqual({
      type: 'project',
      projectId: 'proj-amazon-protect',
    });
  });

  it('resolves notifications carrying deep link URLs', () => {
    expect(
      resolveNotificationDestination({
        url: 'greenpay://donate/proj-solar?amount=50',
      })
    ).toEqual({
      type: 'donate',
      projectId: 'proj-solar',
      amount: '50',
    });
  });

  it('rejects hostile / malformed notification payloads', () => {
    expect(resolveNotificationDestination(null)).toBeNull();
    expect(resolveNotificationDestination({})).toBeNull();
    expect(resolveNotificationDestination({ type: 'unknown_type' })).toBeNull();
    expect(resolveNotificationDestination({ type: 'project_update', projectId: '../../bad' })).toBeNull();
    expect(resolveNotificationDestination({ type: 'donation', projectId: 'proj-1', amount: '-50' })).toBeNull();
    expect(resolveNotificationDestination({ url: 'https://evil.com/phishing' })).toBeNull();
    expect(resolveNotificationDestination('raw string')).toBeNull();
  });
});

describe('navigateToDestination', () => {
  let mockRouter: { push: jest.Mock };

  beforeEach(() => {
    mockRouter = { push: jest.fn() };
  });

  it('routes to project screen', async () => {
    await navigateToDestination(mockRouter, { type: 'project', projectId: 'proj-1' });
    expect(mockRouter.push).toHaveBeenCalledWith('/projects/proj-1');
  });

  it('routes to donate screen with and without params', async () => {
    await navigateToDestination(mockRouter, { type: 'donate', projectId: 'proj-1' });
    expect(mockRouter.push).toHaveBeenCalledWith('/donate/proj-1');

    await navigateToDestination(mockRouter, {
      type: 'donate',
      projectId: 'proj-1',
      amount: '10',
      recurringId: 'rec-1',
    });
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/donate/[id]',
      params: { id: 'proj-1', amount: '10', recurringId: 'rec-1' },
    });
  });

  it('routes recurring destination to donate screen if active entry exists', async () => {
    const mockGetter = jest.fn().mockResolvedValue({
      id: 'rec-1',
      projectId: 'proj-green',
      amountXLM: '20.0000000',
      status: 'active',
    });

    await navigateToDestination(
      mockRouter,
      { type: 'recurring', recurringId: 'rec-1' },
      { getRecurringDonation: mockGetter }
    );

    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/donate/[id]',
      params: { id: 'proj-green', recurringId: 'rec-1', amount: '20.0000000' },
    });
  });

  it('routes recurring destination to /recurring if entry is cancelled/not found', async () => {
    const mockGetter = jest.fn().mockResolvedValue(null);

    await navigateToDestination(
      mockRouter,
      { type: 'recurring', recurringId: 'rec-missing' },
      { getRecurringDonation: mockGetter }
    );

    expect(mockRouter.push).toHaveBeenCalledWith('/recurring');
  });

  it('routes to standalone screens and profile', async () => {
    await navigateToDestination(mockRouter, { type: 'screen', screen: 'impact' });
    expect(mockRouter.push).toHaveBeenCalledWith('/impact');

    await navigateToDestination(mockRouter, { type: 'screen', screen: 'leaderboard' });
    expect(mockRouter.push).toHaveBeenCalledWith('/leaderboard');

    const addr = 'GA4JHZX455IELW533547WFB5LV57LLSUJURFFIIYG7AV4HTQNW4W4FUD';
    await navigateToDestination(mockRouter, { type: 'profile', address: addr });
    expect(mockRouter.push).toHaveBeenCalledWith(`/profile/${addr}`);
  });
});

describe('Property-based Fuzzing (Fast-Check)', () => {
  it('resolveDeepLinkDestination never throws on arbitrary input strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (input) => {
        let result: AppDestination | null = null;
        expect(() => {
          result = resolveDeepLinkDestination(input);
        }).not.toThrow();
        if (result) {
          expect(typeof result).toBe('object');
          expect(result.type).toBeDefined();
        }
      }),
      { numRuns: 300 }
    );
  });

  it('resolveDeepLinkDestination never throws on full unicode strings with control chars', () => {
    fc.assert(
      fc.property(fc.fullUnicodeString({ maxLength: 500 }), (input) => {
        let result: AppDestination | null = null;
        expect(() => {
          result = resolveDeepLinkDestination(input);
        }).not.toThrow();
        if (result) {
          expect(typeof result).toBe('object');
        }
      }),
      { numRuns: 300 }
    );
  });

  it('resolveNotificationDestination never throws on arbitrary objects and types', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        let result: AppDestination | null = null;
        expect(() => {
          result = resolveNotificationDestination(input);
        }).not.toThrow();
        if (result) {
          expect(typeof result).toBe('object');
          expect(result.type).toBeDefined();
        }
      }),
      { numRuns: 300 }
    );
  });

  it('resolveAnyDestination never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        let result: AppDestination | null = null;
        expect(() => {
          result = resolveAnyDestination(input);
        }).not.toThrow();
        if (result) {
          expect(typeof result).toBe('object');
        }
      }),
      { numRuns: 300 }
    );
  });
});
