/**
 * lib/socketEvents.ts
 *
 * Frontend TypeScript contract definitions, types, and runtime validators
 * for Socket.IO realtime events.
 */
import {
  SOCKET_EVENTS,
  validateDonationPayload as rawValidateDonationPayload,
  validateAISummaryPayload as rawValidateAISummaryPayload,
  validateSocketEvent as rawValidateSocketEvent,
} from "../../shared/socketEvents";

export { SOCKET_EVENTS };

export type SocketEventName = typeof SOCKET_EVENTS[keyof typeof SOCKET_EVENTS];

export interface DonationSocketPayload {
  projectId: string;
  donorAddress: string;
  amountXLM: number;
  transactionHash: string;
  timestamp: string;
}

export interface AISummarySocketPayload {
  projectId: string;
  aiSummary: string;
  aiSummaryGeneratedAt: string;
  aiSummaryModel: string;
}

export type ValidationResult<T> =
  | { success: true; data: T; error?: undefined }
  | { success: false; error: string; data?: undefined };

/**
 * Validate a donation socket payload at runtime before consuming.
 */
export function validateDonationPayload(data: unknown): ValidationResult<DonationSocketPayload> {
  const res = rawValidateDonationPayload(data);
  if (res.success) {
    return { success: true, data: res.data as DonationSocketPayload };
  }
  return { success: false, error: res.error };
}

/**
 * Validate an AI summary socket payload at runtime before consuming.
 */
export function validateAISummaryPayload(data: unknown): ValidationResult<AISummarySocketPayload> {
  const res = rawValidateAISummaryPayload(data);
  if (res.success) {
    return { success: true, data: res.data as AISummarySocketPayload };
  }
  return { success: false, error: res.error };
}

/**
 * Generic socket event payload validation helper.
 */
export function validateSocketEvent<T = unknown>(eventName: string, payload: unknown): ValidationResult<T> {
  const res = rawValidateSocketEvent(eventName, payload);
  if (res.success && "data" in res) {
    return { success: true, data: res.data as T };
  }
  return { success: false, error: ("error" in res && res.error) ? res.error : "Invalid event payload" };
}
