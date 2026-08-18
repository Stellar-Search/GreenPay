import type { BackgroundRequest, BackgroundResponse } from './messages';
import type { ProjectSummary } from './session-state';

export interface SearchCoordinatorClient {
  send(request: BackgroundRequest): Promise<BackgroundResponse>;
  renderSearchResults(projects: ProjectSummary[], sequence?: number, query?: string): void;
  hideDropdown(): void;
  getCurrentQuery(): string;
}

/**
 * Coordinates debounced project search requests across the popup/background
 * message boundary, tagging each request with a monotonic sequence number
 * and discarding stale out-of-order responses.
 */
export class SearchCoordinator {
  private latestSequence = 0;
  private latestQuery = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly client: SearchCoordinatorClient;
  private readonly debounceMs: number;

  constructor(client: SearchCoordinatorClient, debounceMs = 300) {
    this.client = client;
    this.debounceMs = debounceMs;
  }

  getLatestSequence(): number {
    return this.latestSequence;
  }

  getLatestQuery(): string {
    return this.latestQuery;
  }

  handleInput(rawQuery: string): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const query = rawQuery.trim();
    this.latestQuery = query;

    if (query.length < 2) {
      this.latestSequence++;
      this.client.hideDropdown();
      return;
    }

    const sequence = ++this.latestSequence;

    this.timer = setTimeout(async () => {
      try {
        const response = await this.client.send({
          type: 'REFRESH_PROJECTS',
          query,
          sequence,
        });

        if ('projects' in response) {
          this.processResponse(
            response.projects,
            response.sequence ?? sequence,
            response.query ?? query
          );
        }
      } catch {
        if (sequence === this.latestSequence) {
          this.client.hideDropdown();
        }
      }
    }, this.debounceMs);
  }

  processResponse(
    projects: ProjectSummary[],
    sequence?: number,
    query?: string
  ): boolean {
    if (sequence !== undefined && sequence !== this.latestSequence) {
      return false;
    }

    const currentQuery = this.client.getCurrentQuery().trim();
    if (query !== undefined && (query !== this.latestQuery || query !== currentQuery)) {
      return false;
    }

    this.client.renderSearchResults(projects, sequence, query);
    return true;
  }

  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
