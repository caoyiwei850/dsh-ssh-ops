import assert from "node:assert/strict";
import { findReusableProfileConnection } from "../src/profile-connection.js";

const healthy = { id: "connection-a", profileId: "profile-a", host: "10.0.0.1", port: 22, username: "root", dead: false, closing: false, connecting: false };
const connections = [healthy, { ...healthy, id: "closing", closing: true }, { ...healthy, id: "dead", dead: true }];

assert.equal(findReusableProfileConnection(connections, "profile-a", { reuseExisting: true }), healthy);
assert.equal(findReusableProfileConnection(connections, "profile-a", { reuseExisting: false }), null);
assert.equal(findReusableProfileConnection(connections, "profile-a", { reuseExisting: true, hasProxyJumpOverride: true }), null);
assert.equal(findReusableProfileConnection(connections, "profile-b", { reuseExisting: true }), null);

console.log("profile connection reuse: healthy saved-route transport selected");
