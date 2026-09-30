import axios from 'axios';
import {
  API_CLIENT_HEADERS,
  ApiClientError,
  apiGet,
  parseApiFetchResponse,
  versionedApiPath,
} from '../utils/api';

describe('mobile API forward compatibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('ignores additive envelope, metadata, and resource fields from a newer API', async () => {
    const response = {
      status: 200,
      headers: { get: jest.fn().mockReturnValue('2') },
      json: jest.fn().mockResolvedValue({
        success: true,
        data: {
          id: 'project-1',
          name: 'Known name',
          fieldAddedByV2: { nested: true },
        },
        meta: { apiVersion: 'v2', futurePaginationShape: [] },
        futureEnvelopeField: true,
      }),
    } as unknown as Response;

    const project = await parseApiFetchResponse<{ id: string; name: string }>(response);
    expect(project.id).toBe('project-1');
    expect(project.name).toBe('Known name');
  });

  it('keeps unknown error codes actionable through the stable client error shape', async () => {
    const response = {
      status: 409,
      json: jest.fn().mockResolvedValue({
        success: false,
        error: {
          code: 'NEWER_API_CONFLICT',
          message: 'The operation needs a newer flow',
          details: { retryable: false, newDetail: 'ignored by old UI' },
        },
      }),
    } as unknown as Response;

    await expect(parseApiFetchResponse(response)).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'NEWER_API_CONFLICT',
      status: 409,
    } satisfies Partial<ApiClientError>);
  });

  it('moves legacy call sites to v1 while preserving explicit future versions', async () => {
    expect(versionedApiPath('/api/projects')).toBe('/api/v1/projects');
    expect(versionedApiPath('/api/v2/meta')).toBe('/api/v2/meta');
    expect(versionedApiPath('/api/versions')).toBe('/api/versions');

    (axios.get as jest.Mock).mockResolvedValue({
      status: 200,
      data: { success: true, data: [] },
    });
    await apiGet('/api/projects');
    expect(axios.get).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/projects$/));
    expect(axios.defaults.headers.common).toEqual(expect.objectContaining(API_CLIENT_HEADERS));
  });
});
