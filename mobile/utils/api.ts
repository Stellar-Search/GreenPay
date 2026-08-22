import axios from 'axios';

export const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000';

export type ApiErrorPayload = {
  code: string;
  message: string;
  details?: unknown;
};

type ApiEnvelope<T> =
  | { success: true; data: T; meta?: Record<string, unknown> }
  | { success: false; error: ApiErrorPayload };

export class ApiClientError extends Error {
  code: string;
  status: number;
  details?: unknown;

  constructor(error: ApiErrorPayload, status: number) {
    super(error.message);
    this.name = 'ApiClientError';
    this.code = error.code;
    this.status = status;
    this.details = error.details;
  }
}

const malformedResponse: ApiErrorPayload = {
  code: 'MALFORMED_API_RESPONSE',
  message: 'Malformed API response',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isApiErrorPayload(value: unknown): value is ApiErrorPayload {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string'
  );
}

function unwrap<T>(body: unknown, status = 0): T {
  if (!isRecord(body) || typeof body.success !== 'boolean') {
    throw new ApiClientError(malformedResponse, status);
  }

  if (body.success === true) {
    return body.data as T;
  }

  if (isApiErrorPayload(body.error)) {
    throw new ApiClientError(body.error, status);
  }

  throw new ApiClientError(malformedResponse, status);
}

function rethrowAxiosError(error: unknown): never {
  if (
    typeof axios.isAxiosError === 'function' &&
    axios.isAxiosError(error) &&
    error.response
  ) {
    unwrap<never>(error.response.data, error.response.status);
    throw new ApiClientError(
      { code: 'HTTP_ERROR', message: 'Request failed' },
      error.response.status
    );
  }

  throw error;
}

export async function apiGet<T>(path: string): Promise<T> {
  try {
    const response = await axios.get<ApiEnvelope<T>>(`${API_URL}${path}`);
    return unwrap(response.data, response.status);
  } catch (error) {
    rethrowAxiosError(error);
  }
}

export async function apiPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  try {
    const response = await axios.post<ApiEnvelope<T>>(`${API_URL}${path}`, body);
    return unwrap(response.data, response.status);
  } catch (error) {
    rethrowAxiosError(error);
  }
}

export async function parseApiFetchResponse<T>(response: Response): Promise<T> {
  const body = await response.json();
  return unwrap<T>(body, response.status);
}
