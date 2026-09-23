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

  it("keeps token counts readable and still redacts every credential under a token key", () => {
    expect(
      redactValue({
        usage: { input_tokens: 1200, cache_read_input_tokens: 3, inputTokens: 5 },
        access_token: "abc",
        refresh_token: "def",
        id_token: "ghi",
        token: { value: "jkl" },
        tokens: "opaque",
        authTokens: ["mno"],
        output_tokens: { value: "pqr" },
        tokenSet: { access: "stu" },
        password: 123456,
        secret: true,
      }),
    ).toEqual({
      usage: { input_tokens: 1200, cache_read_input_tokens: 3, inputTokens: 5 },
      access_token: REDACTED,
      refresh_token: REDACTED,
      id_token: REDACTED,
      token: REDACTED,
      tokens: REDACTED,
      authTokens: REDACTED,
      output_tokens: REDACTED,
      tokenSet: REDACTED,
      password: REDACTED,
      secret: REDACTED,
    });
  });

  it("redacts secret-shaped keys and keeps a __proto__ key as data", () => {
    const redacted = redactValue(
      JSON.parse('{"headers":{"sk-ant-abcdefghijklmnop":1},"__proto__":{"text":"kept"}}'),
    );
    expect(JSON.stringify(redacted)).toBe(
      `{"headers":{"${REDACTED}":1},"__proto__":{"text":"kept"}}`,
    );
  });
});
