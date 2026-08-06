# User-input masking

Use an explicit marker when a value you supply must remain available to Yantra's
tools but must never be shown to the model.

```bash
yantra do "log into xyz.com as @username{u1} with @password{p1}"
```

Yantra replaces those values before creating the run or opening a provider
session. The model sees stable tokens such as `{{user:username:1}}`; a tool sees
the real value only at its execution boundary.

<!-- parser-example: {"input":"@{demo-value}","segments":[{"kind":"value","tag":"secret","value":"demo-value"}]} -->
<!-- parser-example: {"input":"@password{demo-value}","segments":[{"kind":"value","tag":"password","value":"demo-value"}]} -->
<!-- parser-example: {"input":"@{a{b}c}","segments":[{"kind":"value","tag":"secret","value":"a{b}c"}]} -->
<!-- parser-example: {"input":"@@{x}","segments":[{"kind":"literal","text":"@{x}"}]} -->

## Guarantee boundaries

| Layer                                                   | Guarantee                                                                    | When to use it                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------- |
| Explicit `@{...}` or `@tag{...}` marker                 | **Absolute:** the marked value does not enter model prompts or run artifacts | Whenever the value matters                   |
| Keyword look-around (`password p1`)                     | Best-effort and English-anchored                                             | Defense-in-depth when a value was not marked |
| Shape detection (email, card, phone, API key, SSN, VIN) | Best-effort                                                                  | Defense-in-depth for recognizable formats    |

If it matters, mark it. A username, password, national ID, or account number has
no universal shape, and keyword vocabulary varies by language and region.
Markers guarantee separation from the LLM; they do not hide plaintext from your
terminal process, shell history, or other local software that can inspect command
arguments.

## Grammar

| Form             | Meaning                                             | Example                 |
| ---------------- | --------------------------------------------------- | ----------------------- |
| `@{value}`       | Generic protected value (`secret`)                  | `@{demo-value}`         |
| `@tag{value}`    | Protected value with a specific tag                 | `@password{demo-value}` |
| Balanced braces  | Braces inside a value nest naturally                | `@{{"mode":"demo"}}`    |
| Backslash escape | `\{`, `\}`, and `\\` mean literal `{`, `}`, and `\` | `@{p\}1}`               |
| `@@` opt-out     | One literal `@`; `@@{x}` becomes literal `@{x}`     | `@@{x}`                 |

<!-- parser-example: {"input":"@{{\"mode\":\"demo\"}}","segments":[{"kind":"value","tag":"secret","value":"{\"mode\":\"demo\"}"}]} -->
<!-- parser-example: {"input":"@{p\\}1}","segments":[{"kind":"value","tag":"secret","value":"p}1"}]} -->

Marker bodies may contain 1–2048 characters and may not be empty or
whitespace-only. A marker-looking sequence inside a marker body is just part of
that value; it is not parsed again.

The closed tag vocabulary is:

`secret`, `username`, `password`, `pin`, `otp`, `national_id`, `vin`, `account`,
`dob`, `address`, `email`, `phone`, `ssn`, `credit_card`, and `api_key`.

`auth_param` is reserved for Yantra's internal URL detector and cannot be used
as a marker tag. Unknown tags fail loudly so a typo cannot quietly weaken the
user's intent.

### Validation errors

Malformed markers are validation failures: `yantra do`, `ask`, and `research`
exit with code `1`, before a run directory, browser, or provider session is
created. Messages name a 1-based column and never echo the marked value.

| Input                               | Result                                                                |
| ----------------------------------- | --------------------------------------------------------------------- |
| `@{unfinished`                      | Unterminated marker; close it with `}`, or use `@@{` for literal text |
| `@passwrd{x}`                       | Unknown tag; use a listed tag or bare `@{...}`                        |
| `@auth_param{x}`                    | Unknown tag because `auth_param` is internal-only                     |
| `@{}` or `@{   }`                   | Empty value                                                           |
| A value longer than 2048 characters | Value too long                                                        |
| Literal `{{user:email:1}}`          | Reserved placeholder namespace; use a marker instead                  |

A final escaped brace has the expected balanced-brace consequence:
`@{C:\Users\x\}` treats `\}` as data and therefore remains unterminated.

## Shell quoting

The `@{...}` opening survives bash, PowerShell, cmd, and YAML unchanged. Quote
the whole goal as you normally would:

```bash
# bash/zsh and PowerShell: single quotes prevent interpolation
yantra do 'log into xyz.com as @username{u1} with @password{p1}'

# cmd.exe
yantra do "log into xyz.com as @username{u1} with @password{p1}"
```

Yantra deliberately does not use `${...}`: bash and PowerShell expand that form
inside double quotes, destroying the value before Yantra can protect it. `#`
would collide with YAML comments, and `!` can trigger bash history expansion.

## What the model and tools see

For this input:

```text
log into xyz.com as @username{u1} with @password{p1}
```

the model receives:

```text
log into xyz.com as {{user:username:1}} with {{user:password:1}}
```

The model passes a placeholder verbatim to a tool. Yantra resolves it in memory,
applies the ordinary host, credential, consent, and URL policies, executes the
tool, then masks an echoed value back to the same placeholder before returning
the result to the model.

Values of eight or more characters are echo-masked wherever they occur. Shorter
values are masked only at token boundaries to avoid corrupting unrelated text
(`u1` must not rewrite `Ju1ce`). A marked value under three characters produces
an advisory warning because a site that embeds it inside a larger token may not
be fully echo-masked. This caveat affects echoed tool output, not ingress
redaction: the marked value still never enters the model prompt.

## Persistence and durable credentials

Marked values never enter run artifacts or promoted workflow YAML. A promoted
workflow stores a neutral description such as `[user-provided password]`, not a
dangling placeholder and not the original value. The value must be supplied
again for a later live task.

Markers are run-scoped plaintext, not a credential store. For durable website
credentials, use Yantra's keychain-backed opaque secret references; those keep a
host binding and resolve only at the same execution boundary.
