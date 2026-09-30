/**
 * utils/navigationDestinations.ts
 *
 * Unified destination model and allowlist validator for all external triggers
 * entering GreenPay mobile (deep links, universal HTTPS links, and push/local
 * notification taps).
 *
 * Security boundary:
 *   Both deep links and notification payloads carry attacker-influenceable data.
 *   Externally supplied values must never become routes directly. Every entry
 *   point resolves to a strongly-typed AppDestination whose parameters are
 *   strictly validated against allowlists and safe charsets before navigation
 *   can occur.
 *
 * Never throws; always resolves to a well-formed AppDestination or null.
 */
import { StrKey } from '@stellar/stellar-sdk';
import { getRecurringDonation, RecurringDonation } from './recurringDonations';

export const ALLOWED_HOST = 'greenpay.app';
export const ALLOWED_PATH_DONATE = '/donate';
export const CUSTOM_SCHEME = 'greenpay://';
export const MAX_RAW_LENGTH = 4000;

/** Safe charset and length for project and recurring IDs: 1-64 chars of [a-zA-Z0-9_-]. */
export const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Safe numeric amount format: positive decimal with up to 7 fractional digits. */
export const SAFE_AMOUNT_RE = /^[0-9]+(\.[0-9]{1,7})?$/;

export const ALLOWED_SCREENS = [
  'home',
  'projects',
  'impact',
  'leaderboard',
  'recurring',
  'scan',
  'sync-conflicts',
] as const;

export type AllowedScreen = (typeof ALLOWED_SCREENS)[number];

export type AppDestination =
  | { type: 'project'; projectId: string }
  | { type: 'donate'; projectId: string; amount?: string; recurringId?: string }
  | { type: 'recurring'; recurringId?: string; projectId?: string }
  | { type: 'profile'; address: string }
  | { type: 'screen'; screen: AllowedScreen };

function containsControlOrNullChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}

export function isValidProjectId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 && SAFE_ID_RE.test(id);
}

export function isValidRecurringId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 && SAFE_ID_RE.test(id);
}

export function isValidStellarAddress(address: unknown): address is string {
  if (typeof address !== 'string' || address.length !== 56 || !address.startsWith('G')) {
    return false;
  }
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

export function isValidAmount(amount: unknown): amount is string {
  if (typeof amount !== 'string' && typeof amount !== 'number') return false;
  const str = String(amount).trim();
  if (str.length === 0 || str.length > 20) return false;
  const num = Number(str);
  if (isNaN(num) || num <= 0 || !isFinite(num)) return false;
  return SAFE_AMOUNT_RE.test(str);
}

export function isValidScreen(screen: unknown): screen is AllowedScreen {
  return typeof screen === 'string' && (ALLOWED_SCREENS as readonly string[]).includes(screen as AllowedScreen);
}

/** Shared raw string input validation. */
function validateRawString(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_RAW_LENGTH) return null;
  if (containsControlOrNullChars(raw)) return null;
  return raw.trim();
}

/**
 * Resolves an OS deep link or universal HTTPS link to a typed AppDestination.
 * Returns null for any malformed, untrusted, or disallowed input. Never throws.
 */
export function resolveDeepLinkDestination(raw: unknown): AppDestination | null {
  try {
    const trimmed = validateRawString(raw);
    if (!trimmed) return null;

    // Custom-scheme form: greenpay://<segment>/<id> or greenpay://<screen>
    if (trimmed.toLowerCase().startsWith(CUSTOM_SCHEME)) {
      if (!trimmed.startsWith(CUSTOM_SCHEME)) {
        // Reject case mutations like GREENPAY://
        return null;
      }
      const pathAndQuery = trimmed.slice(CUSTOM_SCHEME.length);
      if (pathAndQuery.length === 0) return null;

      const qIndex = pathAndQuery.indexOf('?');
      const pathPart = qIndex === -1 ? pathAndQuery : pathAndQuery.slice(0, qIndex);
      const queryPart = qIndex === -1 ? '' : pathAndQuery.slice(qIndex + 1);

      // Check for illegal path traversal or characters
      if (pathPart.includes('..') || pathPart.includes('\\')) return null;

      const segments = pathPart.split('/').filter(Boolean);
      if (segments.length === 0) return null;

      // Single segment screen: greenpay://impact, greenpay://leaderboard, etc.
      if (segments.length === 1) {
        if (queryPart.length > 0) return null;
        const seg = segments[0];
        if (isValidScreen(seg)) {
          return { type: 'screen', screen: seg };
        }
        if (seg === 'projects') {
          return { type: 'screen', screen: 'projects' };
        }
        if (seg === 'home') {
          return { type: 'screen', screen: 'home' };
        }
        return null;
      }

      // Two-segment paths: greenpay://<action>/<param>
      if (segments.length === 2) {
        const [action, param] = segments;

        if (action === 'project' || action === 'projects') {
          if (queryPart.length > 0) return null;
          if (isValidProjectId(param)) {
            return { type: 'project', projectId: param };
          }
          return null;
        }

        if (action === 'donate') {
          if (!isValidProjectId(param)) return null;

          let amount: string | undefined;
          let recurringId: string | undefined;

          if (queryPart) {
            const params = new URLSearchParams(queryPart);
            for (const [key, value] of params.entries()) {
              if (key === 'amount') {
                if (!isValidAmount(value)) return null;
                amount = value;
              } else if (key === 'recurringId') {
                if (!isValidRecurringId(value)) return null;
                recurringId = value;
              } else {
                return null; // Reject unexpected query parameters
              }
            }
          }

          return {
            type: 'donate',
            projectId: param,
            ...(amount ? { amount } : {}),
            ...(recurringId ? { recurringId } : {}),
          };
        }

        if (action === 'recurring') {
          if (queryPart.length > 0) return null;
          if (isValidRecurringId(param)) {
            return { type: 'recurring', recurringId: param };
          }
          return null;
        }

        if (action === 'profile') {
          if (queryPart.length > 0) return null;
          if (isValidStellarAddress(param)) {
            return { type: 'profile', address: param };
          }
          return null;
        }
      }

      return null;
    }

    // HTTPS Universal Link form: https://greenpay.app/...
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }

    if (url.protocol !== 'https:') return null;
    if (
      url.hostname !== ALLOWED_HOST ||
      url.username !== '' ||
      url.password !== '' ||
      (url.port !== '' && url.port !== '443')
    ) {
      return null;
    }

    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const pathSegments = pathname.split('/').filter(Boolean);

    // https://greenpay.app/donate?projectId=...
    if (pathname === ALLOWED_PATH_DONATE || pathname === '/donate') {
      let projectId: string | undefined;
      let amount: string | undefined;
      let recurringId: string | undefined;

      for (const [key, value] of url.searchParams.entries()) {
        if (key === 'projectId') {
          if (!isValidProjectId(value)) return null;
          projectId = value;
        } else if (key === 'amount') {
          if (!isValidAmount(value)) return null;
          amount = value;
        } else if (key === 'recurringId') {
          if (!isValidRecurringId(value)) return null;
          recurringId = value;
        } else {
          return null; // Reject unexpected query parameters
        }
      }

      if (!projectId) return null;

      return {
        type: 'donate',
        projectId,
        ...(amount ? { amount } : {}),
        ...(recurringId ? { recurringId } : {}),
      };
    }

    // https://greenpay.app/projects/<id> or /project/<id>
    if (pathSegments.length === 2 && (pathSegments[0] === 'projects' || pathSegments[0] === 'project')) {
      if (url.search.length > 0) return null;
      const projectId = pathSegments[1];
      if (isValidProjectId(projectId)) {
        return { type: 'project', projectId };
      }
      return null;
    }

    // https://greenpay.app/profile/<address>
    if (pathSegments.length === 2 && pathSegments[0] === 'profile') {
      if (url.search.length > 0) return null;
      const address = pathSegments[1];
      if (isValidStellarAddress(address)) {
        return { type: 'profile', address };
      }
      return null;
    }

    // https://greenpay.app/recurring, /impact, /leaderboard, etc.
    if (pathSegments.length === 1) {
      if (url.search.length > 0) return null;
      const screen = pathSegments[0];
      if (isValidScreen(screen)) {
        return { type: 'screen', screen };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Resolves an incoming push notification or local notification payload to a typed AppDestination.
 * Accepts Expo NotificationResponse, raw Notification, or parsed data object.
 * Never throws; returns null on invalid or untrusted data.
 */
export function resolveNotificationDestination(raw: unknown): AppDestination | null {
  try {
    if (!raw || typeof raw !== 'object') return null;

    let data: Record<string, unknown> | null = null;

    // Handle Expo NotificationResponse structure: response.notification.request.content.data
    const anyRaw = raw as any;
    if (anyRaw.notification?.request?.content?.data) {
      data = anyRaw.notification.request.content.data;
    } else if (anyRaw.request?.content?.data) {
      data = anyRaw.request.content.data;
    } else if (anyRaw.content?.data) {
      data = anyRaw.content.data;
    } else if (anyRaw.data && typeof anyRaw.data === 'object') {
      data = anyRaw.data;
    } else {
      data = anyRaw as Record<string, unknown>;
    }

    if (!data || typeof data !== 'object') return null;

    // 1. If payload embeds a deep link URL, resolve through deep link parser
    if (typeof data.url === 'string' && data.url.length > 0) {
      const parsedUrl = resolveDeepLinkDestination(data.url);
      if (parsedUrl) return parsedUrl;
    }

    const type = typeof data.type === 'string' ? data.type.trim() : '';
    const projectId = typeof data.projectId === 'string' ? data.projectId.trim() : undefined;
    const recurringId = typeof data.recurringId === 'string' ? data.recurringId.trim() : undefined;
    const amount = typeof data.amount === 'string' || typeof data.amount === 'number'
      ? String(data.amount).trim()
      : undefined;
    const address = typeof data.address === 'string'
      ? data.address.trim()
      : typeof data.walletAddress === 'string'
      ? data.walletAddress.trim()
      : undefined;
    const screen = typeof data.screen === 'string' ? data.screen.trim() : undefined;

    // 2. Project updates / milestone notifications
    if (
      type === 'project_update' ||
      type === 'project_update_removed' ||
      type === 'milestone' ||
      type === 'project'
    ) {
      if (isValidProjectId(projectId)) {
        return { type: 'project', projectId };
      }
      return null;
    }

    // 3. Donation notifications
    if (type === 'donation' || type === 'donate') {
      if (isValidProjectId(projectId)) {
        if (amount !== undefined && !isValidAmount(amount)) return null;
        if (recurringId !== undefined && !isValidRecurringId(recurringId)) return null;
        return {
          type: 'donate',
          projectId,
          ...(amount ? { amount } : {}),
          ...(recurringId ? { recurringId } : {}),
        };
      }
      return null;
    }

    // 4. Recurring donation reminders
    if (type === 'recurring' || type === 'recurring_reminder') {
      if (recurringId !== undefined && !isValidRecurringId(recurringId)) return null;
      if (projectId !== undefined && !isValidProjectId(projectId)) return null;
      if (recurringId) {
        return {
          type: 'recurring',
          recurringId,
          ...(projectId ? { projectId } : {}),
        };
      }
      if (projectId) {
        return { type: 'donate', projectId };
      }
      return { type: 'screen', screen: 'recurring' };
    }

    // 5. Explicit screen navigation
    if (isValidScreen(screen)) {
      return { type: 'screen', screen };
    }

    // 6. Fallback: payload contains recurringId
    if (recurringId !== undefined) {
      if (!isValidRecurringId(recurringId)) return null;
      if (projectId !== undefined && !isValidProjectId(projectId)) return null;
      return {
        type: 'recurring',
        recurringId,
        ...(projectId ? { projectId } : {}),
      };
    }

    // 7. Fallback: payload contains valid projectId
    if (projectId !== undefined) {
      if (!isValidProjectId(projectId)) return null;
      return { type: 'project', projectId };
    }

    // 8. Fallback: payload contains valid Stellar address
    if (address !== undefined) {
      if (!isValidStellarAddress(address)) return null;
      return { type: 'profile', address };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Universal destination resolver: accepts a deep link URL, notification payload, or destination object
 * and returns a validated AppDestination or null.
 */
export function resolveAnyDestination(input: unknown): AppDestination | null {
  if (!input) return null;
  if (typeof input === 'string') {
    return resolveDeepLinkDestination(input);
  }
  if (typeof input === 'object') {
    const obj = input as any;
    if (obj.type === 'project' && isValidProjectId(obj.projectId)) {
      return { type: 'project', projectId: obj.projectId };
    }
    if (obj.type === 'donate' && isValidProjectId(obj.projectId)) {
      return {
        type: 'donate',
        projectId: obj.projectId,
        ...(obj.amount && isValidAmount(obj.amount) ? { amount: String(obj.amount) } : {}),
        ...(obj.recurringId && isValidRecurringId(obj.recurringId) ? { recurringId: obj.recurringId } : {}),
      };
    }
    if (obj.type === 'recurring') {
      if (isValidRecurringId(obj.recurringId)) {
        return {
          type: 'recurring',
          recurringId: obj.recurringId,
          ...(obj.projectId && isValidProjectId(obj.projectId) ? { projectId: obj.projectId } : {}),
        };
      }
      return { type: 'screen', screen: 'recurring' };
    }
    if (obj.type === 'profile' && isValidStellarAddress(obj.address)) {
      return { type: 'profile', address: obj.address };
    }
    if (obj.type === 'screen' && isValidScreen(obj.screen)) {
      return { type: 'screen', screen: obj.screen };
    }
    return resolveNotificationDestination(input);
  }
  return null;
}

/**
 * Safely navigates to a validated AppDestination using the Expo Router instance.
 * Resolves recurring donations to donate screen if active, or falls back to monthly giving.
 */
export async function navigateToDestination(
  router: { push: (href: any) => void },
  destination: AppDestination,
  helpers?: {
    getRecurringDonation?: (id: string) => Promise<RecurringDonation | null>;
  }
): Promise<boolean> {
  if (!destination || typeof destination !== 'object') return false;

  try {
    switch (destination.type) {
      case 'project': {
        router.push(`/projects/${destination.projectId}`);
        return true;
      }
      case 'donate': {
        if (destination.recurringId || destination.amount) {
          router.push({
            pathname: '/donate/[id]',
            params: {
              id: destination.projectId,
              ...(destination.recurringId ? { recurringId: destination.recurringId } : {}),
              ...(destination.amount ? { amount: destination.amount } : {}),
            },
          });
        } else {
          router.push(`/donate/${destination.projectId}`);
        }
        return true;
      }
      case 'recurring': {
        if (destination.recurringId) {
          const getter = helpers?.getRecurringDonation || getRecurringDonation;
          const entry = await getter(destination.recurringId);
          if (entry && entry.status === 'active') {
            router.push({
              pathname: '/donate/[id]',
              params: {
                id: entry.projectId,
                recurringId: entry.id,
                amount: entry.amountXLM,
              },
            });
            return true;
          }
        }
        router.push('/recurring');
        return true;
      }
      case 'profile': {
        router.push(`/profile/${destination.address}`);
        return true;
      }
      case 'screen': {
        const screenRoutes: Record<AllowedScreen, string> = {
          home: '/',
          projects: '/projects',
          impact: '/impact',
          leaderboard: '/leaderboard',
          recurring: '/recurring',
          scan: '/scan',
          'sync-conflicts': '/sync-conflicts',
        };
        const targetRoute = screenRoutes[destination.screen];
        if (targetRoute) {
          router.push(targetRoute);
          return true;
        }
        return false;
      }
      default:
        return false;
    }
  } catch (err) {
    console.error('Error navigating to destination:', err);
    return false;
  }
}
