import type { LoginPageState } from "./control-login.js";

const shapes = ["initialState", "user", "info", "loggedIn", "guest", "userIdSnake", "userIdCamel"] as const;
const typeLabels = new Set(["undefined", "null", "boolean", "number", "string", "object", "array", "function", "symbol", "bigint"]);
const states = new Set<LoginPageState>(["authenticated", "qr_ready", "login_required", "restricted", "unavailable"]);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1000) : 0;
const booleanLabel = (value: unknown) => value === "true" || value === "false" ? value : "missing";

/** Opt-in, per-browser telemetry. Rebuild an allowlisted shape; never log page data directly. */
export function createLoginDiagnostics(enabled: boolean, emit: (line: string) => void = line => console.info(line)) {
  let last = "";
  return (value: unknown, result: LoginPageState): void => {
    if (!enabled || !states.has(result)) return;
    const source = record(value);
    if (!source) return;
    const rawShapes = record(source.shapes);
    const safeShapes = Object.fromEntries(shapes.map(key => {
      const shape = record(rawShapes?.[key]);
      return [key, { type: typeof shape?.type === "string" && typeLabels.has(shape.type) ? shape.type : "unknown", ref: shape?.ref === true }];
    }));
    const line = JSON.stringify({ event: "login-page-diagnostic", result, shapes: safeShapes,
      initialStatePresent: source.initialStatePresent === true, userPresent: source.userPresent === true,
      infoPresent: source.infoPresent === true, loggedIn: booleanLabel(source.loggedIn), guest: booleanLabel(source.guest),
      userIdValid: source.userIdValid === true,
      userIdSnakeProvided: source.userIdSnakeProvided === true, userIdCamelProvided: source.userIdCamelProvided === true,
      userIdSnakeValid: source.userIdSnakeValid === true, userIdCamelValid: source.userIdCamelValid === true,
      userIdConflict: source.userIdConflict === true,
      ownProfileMatches: count(source.ownProfileMatches), ownProfileMyTextMatches: count(source.ownProfileMyTextMatches),
      ownProfileVisibleMatches: count(source.ownProfileVisibleMatches),
      loginVisible: source.loginVisible === true, qrVisible: source.qrVisible === true, challengeVisible: source.challengeVisible === true });
    if (line === last) return;
    last = line;
    emit(line);
  };
}
