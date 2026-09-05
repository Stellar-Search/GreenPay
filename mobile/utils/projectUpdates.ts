export interface MobileProjectUpdate {
  id: string;
  projectId: string;
  title: string;
  body: string;
  createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parse only the stable fields understood by this mobile release. Unknown
 * fields and future moderation states are ignored, while malformed individual
 * entries are skipped so one newer record cannot strand the whole project
 * screen on an older installed application.
 */
export function parseProjectUpdates(value: unknown): MobileProjectUpdate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.projectId !== 'string' ||
      typeof item.title !== 'string' ||
      typeof item.body !== 'string' ||
      typeof item.createdAt !== 'string'
    ) {
      return [];
    }
    return [{
      id: item.id,
      projectId: item.projectId,
      title: item.title,
      body: item.body,
      createdAt: item.createdAt,
    }];
  });
}
