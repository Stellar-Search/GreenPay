import type { ProjectSummary, RecoverySnapshot, WalletSession } from './session-state';

export type BackgroundRequest =
  | { type: 'GET_RECOVERY_STATE'; previousWorkerInstanceId: string | null }
  | { type: 'SET_WALLET_SESSION'; publicKey: string }
  | { type: 'CLEAR_WALLET_SESSION' }
  | { type: 'REFRESH_PROJECTS'; query?: string; sequence?: number };

export type BackgroundResponse =
  | { ok: true; snapshot: RecoverySnapshot }
  | { ok: true; wallet: WalletSession }
  | { ok: true; projects: ProjectSummary[]; sequence?: number; query?: string }
  | { ok: true }
  | { ok: false; error: string };
