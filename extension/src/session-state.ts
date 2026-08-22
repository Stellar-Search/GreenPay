import { isValidStellarAddress } from './stellar-address';

export const SESSION_SCHEMA_VERSION = 1;
export const WALLET_SESSION_TTL_MS = 15 * 60 * 1000;
export const PROJECT_CACHE_TTL_MS = 5 * 60 * 1000;

export const STORAGE_KEYS = {
  session: 'greenpay.sessionState',
  projects: 'greenpay.projectCache',
  lastPopupWorker: 'greenpay.lastPopupWorkerId',
} as const;

export interface WalletSession {
  publicKey: string;
  network: 'TESTNET';
  validatedAt: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  walletAddress: string;
}

interface PersistedSessionState {
  schemaVersion: number;
  wallet: WalletSession | null;
}

interface PersistedProjectCache {
  schemaVersion: number;
  projects: ProjectSummary[];
  cachedAt: number;
}

export interface RecoverySnapshot {
  workerInstanceId: string;
  workerRestarted: boolean;
  wallet: WalletSession | null;
  projects: ProjectSummary[] | null;
  needsWalletValidation: boolean;
}

export interface StorageArea {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWalletSession(value: unknown): value is WalletSession {
  return (
    isRecord(value) &&
    typeof value.publicKey === 'string' &&
    isValidStellarAddress(value.publicKey) &&
    value.network === 'TESTNET' &&
    typeof value.validatedAt === 'number'
  );
}

function isProject(value: unknown): value is ProjectSummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.category === 'string' &&
    typeof value.walletAddress === 'string'
  );
}

/**
 * Owns the state that may be cached in the MV3 worker. Every mutation is
 * persisted before it is exposed so a terminated worker can reconstruct it.
 */
export class WorkerSessionState {
  private wallet: WalletSession | null = null;
  private projects: ProjectSummary[] | null = null;
  private projectsCachedAt: number | null = null;
  private initialized = false;
  private initialization: Promise<void> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sessionStorage: StorageArea,
    private readonly localStorage: StorageArea,
    private readonly now: () => number = Date.now,
    readonly workerInstanceId: string = crypto.randomUUID()
  ) {}

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previousQueue = this.mutationQueue;
    let releaseLock!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    try {
      await previousQueue.catch(() => {});
      return await operation();
    } finally {
      releaseLock();
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initialization) return this.initialization;

    this.initialization = this.loadPersistedState();
    try {
      await this.initialization;
    } finally {
      this.initialization = null;
    }
  }

  private async loadPersistedState(): Promise<void> {
    const [sessionResult, projectResult] = await Promise.all([
      this.sessionStorage.get(STORAGE_KEYS.session),
      this.localStorage.get(STORAGE_KEYS.projects),
    ]);

    const persistedSession = sessionResult[STORAGE_KEYS.session];
    if (
      isRecord(persistedSession) &&
      persistedSession.schemaVersion === SESSION_SCHEMA_VERSION &&
      isWalletSession(persistedSession.wallet) &&
      this.now() >= persistedSession.wallet.validatedAt &&
      this.now() - persistedSession.wallet.validatedAt <= WALLET_SESSION_TTL_MS
    ) {
      this.wallet = persistedSession.wallet;
    } else {
      await this.sessionStorage.remove(STORAGE_KEYS.session);
    }

    const persistedProjects = projectResult[STORAGE_KEYS.projects];
    if (
      isRecord(persistedProjects) &&
      persistedProjects.schemaVersion === SESSION_SCHEMA_VERSION &&
      Array.isArray(persistedProjects.projects) &&
      persistedProjects.projects.every(isProject) &&
      typeof persistedProjects.cachedAt === 'number' &&
      this.now() >= persistedProjects.cachedAt &&
      this.now() - persistedProjects.cachedAt <= PROJECT_CACHE_TTL_MS
    ) {
      this.projects = persistedProjects.projects;
      this.projectsCachedAt = persistedProjects.cachedAt;
    } else {
      await this.localStorage.remove(STORAGE_KEYS.projects);
    }

    this.initialized = true;
  }

  async snapshot(previousWorkerInstanceId: string | null): Promise<RecoverySnapshot> {
    return this.runExclusive(async () => {
      await this.initialize();
      await this.invalidateExpiredState();
      return {
        workerInstanceId: this.workerInstanceId,
        workerRestarted:
          previousWorkerInstanceId !== null &&
          previousWorkerInstanceId !== this.workerInstanceId,
        wallet: this.wallet,
        projects: this.projects,
        // Cached wallet identity is a UI hint, never proof of current access.
        needsWalletValidation: true,
      };
    });
  }

  async setWallet(publicKey: string): Promise<WalletSession> {
    return this.runExclusive(async () => {
      await this.initialize();
      if (!isValidStellarAddress(publicKey)) {
        throw new Error('Invalid Stellar public key');
      }

      this.wallet = {
        publicKey,
        network: 'TESTNET',
        validatedAt: this.now(),
      };
      const persisted: PersistedSessionState = {
        schemaVersion: SESSION_SCHEMA_VERSION,
        wallet: this.wallet,
      };
      await this.sessionStorage.set({ [STORAGE_KEYS.session]: persisted });
      return this.wallet;
    });
  }

  async clearWallet(): Promise<void> {
    return this.runExclusive(async () => {
      await this.initialize();
      this.wallet = null;
      await this.sessionStorage.remove(STORAGE_KEYS.session);
    });
  }

  async setProjects(projects: ProjectSummary[]): Promise<ProjectSummary[]> {
    return this.runExclusive(async () => {
      await this.initialize();
      this.projects = projects.filter(isProject);
      this.projectsCachedAt = this.now();
      const persisted: PersistedProjectCache = {
        schemaVersion: SESSION_SCHEMA_VERSION,
        projects: this.projects,
        cachedAt: this.projectsCachedAt,
      };
      await this.localStorage.set({ [STORAGE_KEYS.projects]: persisted });
      return this.projects;
    });
  }

  private async invalidateExpiredState(): Promise<void> {
    const now = this.now();
    const removals: Promise<void>[] = [];
    if (
      this.wallet &&
      (now < this.wallet.validatedAt ||
        now - this.wallet.validatedAt > WALLET_SESSION_TTL_MS)
    ) {
      this.wallet = null;
      removals.push(this.sessionStorage.remove(STORAGE_KEYS.session));
    }
    if (
      this.projects &&
      this.projectsCachedAt !== null &&
      (now < this.projectsCachedAt ||
        now - this.projectsCachedAt > PROJECT_CACHE_TTL_MS)
    ) {
      this.projects = null;
      this.projectsCachedAt = null;
      removals.push(this.localStorage.remove(STORAGE_KEYS.projects));
    }
    await Promise.all(removals);
  }
}
