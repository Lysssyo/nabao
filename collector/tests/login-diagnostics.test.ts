import test from "node:test";
import assert from "node:assert/strict";
import { createLoginDiagnostics } from "../src/login-diagnostics.js";

const sample = { shapes: {
  initialState: { type: "object", ref: false }, user: { type: "object", ref: false }, info: { type: "object", ref: true },
  loggedIn: { type: "object", ref: true }, guest: { type: "boolean", ref: false },
  userIdSnake: { type: "string", ref: false }, userIdCamel: { type: "undefined", ref: false },
}, initialStatePresent: true, userPresent: true, infoPresent: true, loggedIn: "true", guest: "false", userIdValid: true,
  userIdSnakeProvided: true, userIdCamelProvided: false, userIdSnakeValid: true, userIdCamelValid: false, userIdConflict: false,
  ownProfileMatches: 2, ownProfileMyTextMatches: 2, ownProfileVisibleMatches: 1, loginVisible: false, qrVisible: false, challengeVisible: false };

test("opt-in login diagnostics emit only fixed labels and counts, excluding arbitrary private input", () => {
  const lines: string[] = [];
  const emit = createLoginDiagnostics(true, line => lines.push(line));
  const secret = "SECRET-cookie-token https://private.example /private/profile";
  emit({ ...sample, userId: secret, text: secret, cookies: secret, arbitraryKey: secret,
    shapes: { ...sample.shapes, arbitraryKey: { type: secret, ref: secret }, userIdSnake: { type: "string", ref: false, raw: secret } } }, "authenticated");
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0]!, /SECRET|private|cookie|token|arbitraryKey|raw/);
  const diagnostic = JSON.parse(lines[0]!);
  assert.equal(diagnostic.result, "authenticated"); assert.equal(diagnostic.guest, "false");
  assert.equal(diagnostic.userIdValid, true); assert.equal(diagnostic.ownProfileVisibleMatches, 1);
  assert.equal(diagnostic.shapes.info.ref, true);
  emit({ ...sample, loggedIn: secret, guest: secret, ownProfileMatches: secret,
    shapes: { ...sample.shapes, userIdSnake: { type: secret, ref: secret } } }, "unavailable");
  assert.equal(JSON.parse(lines[1]!).shapes.userIdSnake.type, "unknown");
  assert.equal(JSON.parse(lines[1]!).loggedIn, "missing");
  assert.doesNotMatch(lines[1]!, /SECRET|private|cookie|token/);
});

test("login diagnostics are disabled by default and deduplicate each browser's repeated DOM reads", () => {
  const lines: string[] = [];
  createLoginDiagnostics(false, line => lines.push(line))(sample, "authenticated");
  assert.equal(lines.length, 0);
  const emit = createLoginDiagnostics(true, line => lines.push(line));
  for (let attempt = 0; attempt < 100; attempt++) emit(sample, "authenticated");
  assert.equal(lines.length, 1);
  emit({ ...sample, loginVisible: true }, "login_required");
  assert.equal(lines.length, 2);
  createLoginDiagnostics(true, line => lines.push(line))(sample, "authenticated");
  assert.equal(lines.length, 3, "a new browser has its own diagnostic history");
});
