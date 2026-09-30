import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundRequest, BackgroundResponse } from '../messages';
import { SearchCoordinator, type SearchCoordinatorClient } from '../popup-search';
import type { ProjectSummary } from '../session-state';

function createMockProject(id: string, name: string): ProjectSummary {
  return {
    id,
    name,
    description: `Description for ${name}`,
    category: 'Conservation',
    walletAddress: 'GDUQ24STT6QESP4QW33O4KDVYMRTBHWZ3ZE6HXX5TCNWUZH6MRT7PADV',
  };
}

describe('SearchCoordinator request sequencing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('tags each search request with a monotonically increasing sequence number and query', async () => {
    const sentRequests: BackgroundRequest[] = [];
    let currentQuery = '';

    const client: SearchCoordinatorClient = {
      send: vi.fn(async (request: BackgroundRequest): Promise<BackgroundResponse> => {
        sentRequests.push(request);
        return { ok: true, projects: [] };
      }),
      renderSearchResults: vi.fn(),
      hideDropdown: vi.fn(),
      getCurrentQuery: () => currentQuery,
    };

    const coordinator = new SearchCoordinator(client, 300);

    currentQuery = 'ocean';
    coordinator.handleInput(currentQuery);
    await vi.advanceTimersByTimeAsync(300);

    expect(sentRequests).toHaveLength(1);
    expect(sentRequests[0]).toEqual({
      type: 'REFRESH_PROJECTS',
      query: 'ocean',
      sequence: 1,
    });

    currentQuery = 'ocean cleanup';
    coordinator.handleInput(currentQuery);
    await vi.advanceTimersByTimeAsync(300);

    expect(sentRequests).toHaveLength(2);
    expect(sentRequests[1]).toEqual({
      type: 'REFRESH_PROJECTS',
      query: 'ocean cleanup',
      sequence: 2,
    });
  });

  it('simulates out-of-order response resolution and asserts only the latest query results render', async () => {
    type Resolver = (response: BackgroundResponse) => void;
    const resolvers: Record<number, Resolver> = {};
    const rendered: ProjectSummary[][] = [];
    let currentQuery = '';

    const client: SearchCoordinatorClient = {
      send: vi.fn((request: BackgroundRequest): Promise<BackgroundResponse> => {
        if (request.type === 'REFRESH_PROJECTS' && request.sequence) {
          const seq = request.sequence;
          return new Promise<BackgroundResponse>((resolve) => {
            resolvers[seq] = resolve;
          });
        }
        return Promise.resolve({ ok: true, projects: [] });
      }),
      renderSearchResults: vi.fn((projects: ProjectSummary[]) => {
        rendered.push(projects);
      }),
      hideDropdown: vi.fn(),
      getCurrentQuery: () => currentQuery,
    };

    const coordinator = new SearchCoordinator(client, 300);

    const projectO = [createMockProject('1', 'Ocean')];
    const projectOC = [createMockProject('2', 'Ocean Cleanup')];

    // User types "oc" past debounce window for "o"
    currentQuery = 'o_query';
    coordinator.handleInput('o_query');
    await vi.advanceTimersByTimeAsync(300); // Request 1 (seq 1) is sent

    currentQuery = 'oc_query';
    coordinator.handleInput('oc_query');
    await vi.advanceTimersByTimeAsync(300); // Request 2 (seq 2) is sent

    expect(resolvers[1]).toBeDefined();
    expect(resolvers[2]).toBeDefined();

    // Jitter: Request 2 finishes FIRST
    resolvers[2]({
      ok: true,
      projects: projectOC,
      sequence: 2,
      query: 'oc_query',
    });
    // Allow microtasks to execute
    await Promise.resolve();

    expect(client.renderSearchResults).toHaveBeenCalledTimes(1);
    expect(rendered).toEqual([projectOC]);

    // Later: Request 1 finishes (out of order / stale)
    resolvers[1]({
      ok: true,
      projects: projectO,
      sequence: 1,
      query: 'o_query',
    });
    await Promise.resolve();

    // The stale results from request 1 must NOT be rendered
    expect(client.renderSearchResults).toHaveBeenCalledTimes(1);
    expect(rendered).toEqual([projectOC]);
  });

  it('cancels previous debounce timer when a new keystroke arrives within debounce window', async () => {
    const send = vi.fn(async (): Promise<BackgroundResponse> => {
      return { ok: true, projects: [] };
    });
    let currentQuery = '';

    const client: SearchCoordinatorClient = {
      send,
      renderSearchResults: vi.fn(),
      hideDropdown: vi.fn(),
      getCurrentQuery: () => currentQuery,
    };

    const coordinator = new SearchCoordinator(client, 300);

    currentQuery = 'tr';
    coordinator.handleInput('tr');
    await vi.advanceTimersByTimeAsync(150); // halfway through debounce

    currentQuery = 'tree';
    coordinator.handleInput('tree');
    await vi.advanceTimersByTimeAsync(150); // 300ms from start, but only 150ms from second input
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(150); // 300ms from second input
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'REFRESH_PROJECTS',
      query: 'tree',
      sequence: 2,
    });
  });

  it('hides dropdown and invalidates pending sequence on queries shorter than 2 characters', async () => {
    const send = vi.fn(async (): Promise<BackgroundResponse> => {
      return { ok: true, projects: [] };
    });
    const hideDropdown = vi.fn();
    let currentQuery = '';

    const client: SearchCoordinatorClient = {
      send,
      renderSearchResults: vi.fn(),
      hideDropdown,
      getCurrentQuery: () => currentQuery,
    };

    const coordinator = new SearchCoordinator(client, 300);

    currentQuery = 'a';
    coordinator.handleInput('a');
    await vi.advanceTimersByTimeAsync(300);

    expect(send).not.toHaveBeenCalled();
    expect(hideDropdown).toHaveBeenCalledTimes(1);
    expect(coordinator.getLatestSequence()).toBe(1);
  });

  it('ignores response if current query changed before response resolution', () => {
    let currentQuery = 'trees';
    const renderSearchResults = vi.fn();

    const client: SearchCoordinatorClient = {
      send: vi.fn(),
      renderSearchResults,
      hideDropdown: vi.fn(),
      getCurrentQuery: () => currentQuery,
    };

    const coordinator = new SearchCoordinator(client, 300);
    coordinator.handleInput('trees');

    // Simulate query input changed to 'forest' before async response finishes
    currentQuery = 'forest';

    const accepted = coordinator.processResponse(
      [createMockProject('1', 'Old Trees')],
      1,
      'trees'
    );

    expect(accepted).toBe(false);
    expect(renderSearchResults).not.toHaveBeenCalled();
  });

  it('does not hide dropdown when a stale request fails', async () => {
    type Rejector = (error: Error) => void;
    let rejectReq1!: Rejector;
    let currentQuery = '';

    const client: SearchCoordinatorClient = {
      send: vi.fn((request: BackgroundRequest): Promise<BackgroundResponse> => {
        if (request.type === 'REFRESH_PROJECTS' && request.sequence === 1) {
          return new Promise<BackgroundResponse>((_, reject) => {
            rejectReq1 = reject;
          });
        }
        return Promise.resolve({ ok: true, projects: [createMockProject('2', 'Active')] });
      }),
      renderSearchResults: vi.fn(),
      hideDropdown: vi.fn(),
      getCurrentQuery: () => currentQuery,
    };

    const coordinator = new SearchCoordinator(client, 300);

    currentQuery = 'first';
    coordinator.handleInput('first');
    await vi.advanceTimersByTimeAsync(300);

    currentQuery = 'second';
    coordinator.handleInput('second');
    await vi.advanceTimersByTimeAsync(300);

    // Request 1 fails after request 2 is already active
    rejectReq1(new Error('Network failure'));
    await Promise.resolve();

    expect(client.hideDropdown).not.toHaveBeenCalled();
  });
});
