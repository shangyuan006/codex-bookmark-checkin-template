import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyLinuxDoSession,
  providerSessionProbeUrl,
} from "../src/oauth-provider-session.mjs";
import { parseProviderSessionProbe } from "../src/reauth-checkin.mjs";

test("LinuxDO provider session probe uses a fixed endpoint and returns no identity", () => {
  assert.equal(providerSessionProbeUrl("LinuxDO"), "https://linux.do/session/current.json");
  assert.equal(providerSessionProbeUrl("GitHub"), null);
  assert.equal(classifyLinuxDoSession({ current_user: { id: 123, username: "private" } }), "valid");
  assert.equal(classifyLinuxDoSession({ current_user: null }), "invalid");
  assert.equal(classifyLinuxDoSession(null), "unknown");
});

test("provider session probe parser exposes only a fixed status", () => {
  assert.deepEqual(
    parseProviderSessionProbe('startup\n{"status":"valid","username":"private"}\n'),
    { status: "valid" },
  );
  assert.deepEqual(parseProviderSessionProbe("not json"), { status: "unknown" });
});
