import assert from "node:assert/strict";
import test from "node:test";
import { ReportStore } from "../dist/report-store.js";

test("report store is a no-op when persistence is not configured", async () => {
  const store = new ReportStore("");
  assert.equal(store.persistent, false);
  await store.put("a1", "report");
  assert.equal(await store.get("a1"), undefined);
});

test("report store writes and reads private HTML objects", async () => {
  const commands = [];
  const client = {
    async send(command) {
      commands.push(command);
      if (command.constructor.name === "GetObjectCommand") return { Body: { transformToString: async () => "stored report" } };
      return {};
    },
  };
  const store = new ReportStore("private-bucket", client);
  await store.put("abc-123", "stored report");
  assert.equal(await store.get("abc-123"), "stored report");
  assert.equal(commands[0].input.Key, "reports/abc-123.html");
  assert.equal(commands[0].input.ServerSideEncryption, "AES256");
  assert.equal(commands[1].input.Key, "reports/abc-123.html");
});

test("report store treats missing objects as absent", async () => {
  const store = new ReportStore("private-bucket", { async send() { throw Object.assign(new Error("missing"), { name: "NoSuchKey" }); } });
  assert.equal(await store.get("abc-123"), undefined);
});
