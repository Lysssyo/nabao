export interface RunState {
  id: string; trigger: "manual" | "scheduled"; status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string; finishedAt: string | null; result: string | null; message: string; errorCode: string | null;
}
export interface LoginState {
  status: "idle" | "starting" | "waiting" | "waiting_browser" | "authenticated" | "expired" | "cancelled" | "failed" | "restricted";
  startedAt: string | null; expiresAt: string | null; verifiedAt: string | null; message: string; previewAvailable: boolean;
}
export interface SessionState {
  status: "unchecked" | "checking" | "authenticated" | "expired" | "failed" | "restricted";
  checkedAt: string | null; message: string;
}
export interface ControlStatus {
  available: true; busy: boolean; session: SessionState; run: RunState | null;
  schedule: { enabled: boolean; intervalMinutes: number; nextRunAt: string | null };
  login: LoginState; sources: { id: string; name: string; profileUrl: string }[];
}
export class ControlError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
