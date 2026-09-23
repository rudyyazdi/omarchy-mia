import { describe, expect, it } from "vitest";
import { REDACTED, redactSensitivePairs, redactValue, registerSecret } from "./redact.ts";

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
        env: { MAX_THINKING_TOKENS: "8000", API_TOKENS: "abc", CACHE_TOKENS: "1234567890" },
        access_token: "abc",
        refresh_token: "def",
        id_token: "ghi",
        token: { value: "jkl" },
        tokens: "opaque",
        authTokens: ["mno"],
        output_tokens: { value: "pqr" },
        tokenSet: { access: "stu" },
        secret_tokens: 1234,
        passwordTokens: 99,
        password: 123456,
        secret: true,
      }),
    ).toEqual({
      usage: { input_tokens: 1200, cache_read_input_tokens: 3, inputTokens: 5 },
      env: { MAX_THINKING_TOKENS: "8000", API_TOKENS: REDACTED, CACHE_TOKENS: REDACTED },
      access_token: REDACTED,
      refresh_token: REDACTED,
      id_token: REDACTED,
      token: REDACTED,
      tokens: REDACTED,
      authTokens: REDACTED,
      output_tokens: REDACTED,
      tokenSet: REDACTED,
      secret_tokens: REDACTED,
      passwordTokens: REDACTED,
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

describe("redactSensitivePairs", () => {
  it.each([
    ['{"api_key":"short', `{"api_key":"${REDACTED}`],
    ['{"api_key" : "short", "text":"kept"}', `{"api_key" : "${REDACTED}", "text":"kept"}`],
    ['{"secret":"a\\"b","text":"kept', `{"secret":"${REDACTED}","text":"kept`],
    ['{"secret":"a\\"b', `{"secret":"${REDACTED}`],
    ['{"password":123456,"text":"kept', `{"password":"${REDACTED}","text":"kept`],
    ['{"password":12', `{"password":"${REDACTED}"`],
    [
      '{"auth":{"token":true,"value":"x"},"text":"kept',
      `{"auth":{"token":"${REDACTED}","value":"x"},"text":"kept`,
    ],
    ['{"credentials":{"value":"x"},"text":"kept', `{"credentials":"${REDACTED}","text":"kept`],
    ['{"credentials":["x","y"', `{"credentials":"${REDACTED}`],
    ['{"credentials":{"value":"}"', `{"credentials":"${REDACTED}`],
    ['{"\\u0074oken":"short', `{"\\u0074oken":"${REDACTED}`],
    [
      '{"text":"say \\"password\\": short","more":"kept',
      '{"text":"say \\"password\\": short","more":"kept',
    ],
    [
      '{"usage":{"input_tokens":1200,"output_tokens":3',
      '{"usage":{"input_tokens":1200,"output_tokens":3',
    ],
    [
      '{"MAX_THINKING_TOKENS":"8000","API_TOKENS":"abc',
      `{"MAX_THINKING_TOKENS":"8000","API_TOKENS":"${REDACTED}`,
    ],
    ['{"api_key":', '{"api_key":'],
    ['{"api_ke', '{"api_ke'],
    ['error: "token": abc123 then more', `error: "token": "${REDACTED}" then more`],
  ])("%s", (text, expected) => {
    expect(redactSensitivePairs(text)).toBe(expected);
  });
});
