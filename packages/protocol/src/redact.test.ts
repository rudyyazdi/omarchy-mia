import { describe, expect, it } from "vitest";
import { REDACTED, redactValue, registerSecret } from "./redact.ts";

describe("redactValue", () => {
  it("replaces registered secrets throughout nested values without mutating the input", () => {
    const secret = "registered-redaction-fixture";
    registerSecret(secret);
    const input = { nested: [{ text: `${secret} and ${secret}` }], suffix: `before ${secret}` };
    expect(redactValue(input)).toEqual({
      nested: [{ text: `${REDACTED} and ${REDACTED}` }],
      suffix: `before ${REDACTED}`,
    });
    expect(input.nested[0]?.text).toBe(`${secret} and ${secret}`);
  });

  it("preserves ordinary values and ignores short registrations", () => {
    registerSecret("short");
    const input = { text: "short and ordinary", nested: [null, true, 42, { value: "hello" }] };
    expect(redactValue(input)).toEqual(input);
  });

  it("redacts sensitive keys as whole subtrees and credential-shaped text", () => {
    expect(
      redactValue({ authorization: { value: "anything" }, text: "key sk-ant-abcdefghijk" }),
    ).toEqual({ authorization: REDACTED, text: `key ${REDACTED}` });
  });
});
