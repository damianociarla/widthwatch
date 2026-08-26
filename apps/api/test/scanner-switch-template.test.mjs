import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseDocument } from "yaml";

const template = fileURLToPath(new URL("../../../infra/aws/scanner-switch.yml", import.meta.url));

test("scanner control-plane template defines both enabled and disabled contracts", async () => {
  const document = parseDocument(await readFile(template, "utf8"));
  assert.deepEqual(document.errors, []);

  const condition = document.getIn(["Conditions", "ScannerEnabled"], true);
  assert.equal(condition.tag, "!Equals");
  assert.equal(condition.items[0].tag, "!Ref");
  assert.deepEqual(condition.toJSON(), ["PublicScannerEnabled", "true"]);

  const rule = document.getIn(["Resources", "ScannerSwitchRuleGroup", "Properties", "Rules", 0], true);
  const action = rule.get("Action", true);
  assert.equal(action.tag, "!If");
  assert.deepEqual(action.toJSON(), [
    "ScannerEnabled",
    { Count: {} },
    {
      Block: {
        CustomResponse: {
          ResponseCode: 403,
          CustomResponseBodyKey: "ScannerPaused",
          ResponseHeaders: [
            { Name: "Access-Control-Allow-Origin", Value: "https://damianociarla.github.io" },
            { Name: "Cache-Control", Value: "no-store" },
          ],
        },
      },
    },
  ]);
  assert.deepEqual(rule.get("Statement", true).toJSON(), {
    AndStatement: {
      Statements: [
        {
          ByteMatchStatement: {
            FieldToMatch: { UriPath: {} },
            PositionalConstraint: "EXACTLY",
            SearchString: "/v1/scans",
            TextTransformations: [{ Priority: 0, Type: "NONE" }],
          },
        },
        {
          ByteMatchStatement: {
            FieldToMatch: { Method: {} },
            PositionalConstraint: "EXACTLY",
            SearchString: "POST",
            TextTransformations: [{ Priority: 0, Type: "NONE" }],
          },
        },
      ],
    },
  });

  const pausedBody = document.getIn(["Resources", "ScannerSwitchRuleGroup", "Properties", "CustomResponseBodies", "ScannerPaused"], true).toJSON();
  assert.equal(pausedBody.ContentType, "APPLICATION_JSON");
  assert.deepEqual(JSON.parse(pausedBody.Content), {
    error: "scanner_paused",
    message: "The public scanner is temporarily paused.",
  });

  const publicStatus = document.getIn(["Outputs", "PublicScannerStatus", "Value"], true);
  assert.equal(publicStatus.tag, "!If");
  assert.deepEqual(publicStatus.toJSON(), ["ScannerEnabled", "ENABLED", "DISABLED"]);
});
