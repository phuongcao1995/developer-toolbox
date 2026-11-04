// Regex library, cheat sheet and saved-pattern helpers (pure data + validation, no DOM).
// Every library pattern is tested to compile with its flags and to match its own sample (tests/unit/regex-tester-library.test.mjs).
const r = String.raw;

/** @type {{id:string, category:string, name:string, pattern:string, flags:string, description:string, sample:string, limitations:string}[]} */
export const LIBRARY = [
  // ---- Validation ----
  { id: 'email', category: 'Validation', name: 'Email address', pattern: r`[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+`, flags: 'g', description: 'Finds typical email addresses in text.', sample: 'Write to ada@example.com or bob.smith+news@mail.example.co.uk, not to nobody@.', limitations: 'Not a full RFC 5322 implementation: quoted local parts, comments and IP-literal domains are not handled. The only real validation is sending a message.' },
  { id: 'email-strict', category: 'Validation', name: 'Email address (whole string)', pattern: r`^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$`, flags: 'gm', description: 'One address per line; the whole line must be an address.', sample: 'ada@example.com\nnot an email\nbob@mail.example.org', limitations: 'Not RFC 5322 compliant; rejects internationalised addresses and quoted local parts.' },
  { id: 'username', category: 'Validation', name: 'Username policy', pattern: r`^(?=.{3,16}$)[a-z][a-z0-9_-]*$`, flags: 'gmi', description: '3 to 16 characters, starts with a letter, then letters, digits, "_" or "-".', sample: 'ada_lovelace\nx\n9lives\nok-user', limitations: 'Example policy only; adjust length and characters to your own rules. Does not check reserved names.' },
  { id: 'password', category: 'Validation', name: 'Password policy (lookaheads)', pattern: r`^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\w\s]).{8,}$`, flags: 'gm', description: 'At least 8 characters with a lower-case letter, an upper-case letter, a digit and a symbol.', sample: 'Passw0rd!\nweakpass\nSTRONG#pass1', limitations: 'Composition rules are weak security advice (length and breached-password checks matter more). Greedy lookaheads are fine here because the text is short.' },
  { id: 'trim', category: 'Validation', name: 'Leading / trailing whitespace', pattern: r`^[ \t]+|[ \t]+$`, flags: 'gm', description: 'Finds spaces and tabs at the start or end of each line (replace with nothing to trim).', sample: '   padded line   \nclean\n\ttabbed', limitations: 'Only spaces and tabs; use \\s for all whitespace, which also eats line breaks.' },
  { id: 'blank-lines', category: 'Validation', name: 'Blank lines', pattern: r`^[ \t]*$\n?`, flags: 'gm', description: 'Matches empty or whitespace-only lines (replace with nothing to remove them).', sample: 'one\n\n   \ntwo\n', limitations: 'Line-ending handling differs between \\n and \\r\\n files.' },
  { id: 'cc-like', category: 'Validation', name: 'Credit-card-like number', pattern: r`\b(?:\d{4}[ -]?){3}\d{4}\b`, flags: 'g', description: 'Finds 16-digit groups such as 4111 1111 1111 1111.', sample: 'Card 4111 1111 1111 1111 and 5500-0000-0000-0004, not 1234.', limitations: 'Shape check only: the Luhn checksum is NOT validated and card brands/lengths (Amex has 15) are not distinguished. Never store real card numbers.' },

  // ---- Network ----
  { id: 'url', category: 'Network', name: 'URL (http/https)', pattern: r`https?:\/\/(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s]*)?`, flags: 'gi', description: 'Web addresses with optional port and path.', sample: 'Docs at https://developer.mozilla.org/en-US/docs and http://example.com:3000/app (not ftp://x.org).', limitations: 'Does not match localhost, IP hosts or userinfo; trailing punctuation such as ")" or "." is included in the match.' },
  { id: 'domain', category: 'Network', name: 'Domain name', pattern: r`\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b`, flags: 'gi', description: 'Host names such as sub.example.co.uk.', sample: 'Visit example.com, mail.example.co.uk and my-site.dev today.', limitations: 'Does not check that the TLD exists and ignores internationalised (punycode-free) names.' },
  { id: 'ipv4', category: 'Network', name: 'IPv4 address', pattern: r`\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b`, flags: 'g', description: 'Dotted-quad addresses with each octet 0-255.', sample: 'Hosts: 192.168.1.1, 10.0.0.255, 256.1.1.1 (invalid), 8.8.8.8', limitations: 'Accepts leading zeros such as 01.02.03.004; does not know about private or reserved ranges.' },
  { id: 'ipv6', category: 'Network', name: 'IPv6 address (best effort)', pattern: r`(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}|(?:[A-Fa-f0-9]{1,4}:){1,7}:|(?:[A-Fa-f0-9]{1,4}:){1,6}:[A-Fa-f0-9]{1,4}|::(?:[A-Fa-f0-9]{1,4}:){0,5}[A-Fa-f0-9]{1,4}|::`, flags: 'g', description: 'Full and common compressed IPv6 forms.', sample: 'Addrs: 2001:0db8:85a3:0000:0000:8a2e:0370:7334, fe80::1 and ::1.', limitations: 'Best effort only: some valid compressed forms (e.g. 1::2:3) and IPv4-mapped addresses are not covered, and not every match is strictly valid. Use a parser (URL / net.isIPv6) for real validation.' },
  { id: 'mac', category: 'Network', name: 'MAC address', pattern: r`\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\b`, flags: 'g', description: 'Six hex pairs separated by ":" or "-".', sample: 'NIC 00:1A:2B:3C:4D:5E and 00-1a-2b-3c-4d-5f.', limitations: 'Does not accept the Cisco dotted form (001a.2b3c.4d5e) and allows mixed separators.' },
  { id: 'port', category: 'Network', name: 'TCP/UDP port (0-65535)', pattern: r`\b(?:6553[0-5]|655[0-2]\d|65[0-4]\d{2}|6[0-4]\d{3}|[1-5]\d{4}|[1-9]\d{0,3}|0)\b`, flags: 'g', description: 'Numbers from 0 to 65535.', sample: 'Ports 80, 443, 8080 and 65535 are fine; 65536 and 99999 are not.', limitations: 'Matches any standalone number in range; it cannot tell a port from other numbers in text.' },
  { id: 'host-port', category: 'Network', name: 'host:port', pattern: r`\b[\w.-]+:\d{1,5}\b`, flags: 'g', description: 'A host name or IPv4 address followed by a port.', sample: 'Connect to localhost:3000 or db.internal:5432 or 10.0.0.5:22.', limitations: 'Does not range-check the port and does not handle IPv6 [::1]:80 notation.' },

  // ---- Date & time ----
  { id: 'iso-date', category: 'Date & time', name: 'ISO date (YYYY-MM-DD)', pattern: r`(?<year>\d{4})-(?<month>0[1-9]|1[0-2])-(?<day>0[1-9]|[12]\d|3[01])`, flags: 'g', description: 'Calendar dates with named groups year, month and day.', sample: 'Released 2024-03-15, patched 2024-12-01, bad date 2024-13-45.', limitations: 'Does not know month lengths (2024-02-31 matches) or leap years.' },
  { id: 'iso-datetime', category: 'Date & time', name: 'ISO 8601 date-time', pattern: r`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?`, flags: 'g', description: 'Timestamps like 2024-03-15T09:30:00Z or with an offset.', sample: 'Logged at 2024-03-15T09:30:00Z and 2024-03-15T11:30:15.250+02:00.', limitations: 'Shape only: month, day and hour ranges are not checked.' },
  { id: 'us-date', category: 'Date & time', name: 'US date (MM/DD/YYYY)', pattern: r`\b(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])\/\d{4}\b`, flags: 'g', description: 'Month first, slash separated.', sample: 'Due 03/15/2024 or 12/1/2025, not 13/45/2024.', limitations: 'No per-month day check; ambiguous with EU dates (04/05/2024).' },
  { id: 'eu-date', category: 'Date & time', name: 'EU date (DD.MM.YYYY)', pattern: r`\b(?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-]\d{4}\b`, flags: 'g', description: 'Day first, separated by ".", "/" or "-".', sample: 'Geburtstag 15.03.2024 oder 1/12/2025, not 32.13.2024.', limitations: 'No per-month day check; separators may be mixed.' },
  { id: 'time-24h', category: 'Date & time', name: 'Time (24h HH:MM)', pattern: r`\b(?:[01]\d|2[0-3]):[0-5]\d\b`, flags: 'g', description: 'Hours 00-23 and minutes 00-59.', sample: 'Meetings at 09:30, 14:45 and 24:00 (invalid), 23:59.', limitations: 'No seconds; leap-second 23:59:60 is not handled.' },
  { id: 'time-12h', category: 'Date & time', name: 'Time (12h with AM/PM)', pattern: r`\b(?:0?[1-9]|1[0-2]):[0-5]\d\s?[AaPp][Mm]\b`, flags: 'g', description: 'Times like 9:30 AM or 12:05pm.', sample: 'Open 9:30 AM to 5:45pm, closed at 13:00 PM (invalid).', limitations: 'Locale variants such as "a.m." are not matched.' },

  // ---- Numbers ----
  { id: 'phone-e164', category: 'Numbers', name: 'Phone number (E.164)', pattern: r`\+[1-9]\d{1,14}\b`, flags: 'g', description: 'International format: "+" then up to 15 digits.', sample: 'Call +14155552671 or +442071838750, not 0044 20.', limitations: 'Shape only: does not verify country codes or number lengths per country. Spaces and dashes are not accepted.' },
  { id: 'phone-us', category: 'Numbers', name: 'Phone number (US)', pattern: r`\(?\b\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b`, flags: 'g', description: 'US/Canada numbers with optional brackets and separators.', sample: 'Call (555) 123-4567 or 555.987.6543 or 5551234567.', limitations: 'Does not check valid area codes or an optional +1 prefix.' },
  { id: 'integer', category: 'Numbers', name: 'Integer', pattern: r`[-+]?\b\d+\b`, flags: 'g', description: 'Whole numbers with an optional sign.', sample: 'Values: 42, -7, +15 and 3.14 (3 and 14 match separately).', limitations: 'Does not understand thousands separators; the sign must touch the digits.' },
  { id: 'decimal', category: 'Numbers', name: 'Decimal number', pattern: r`[-+]?(?:\d+\.\d+|\.\d+|\d+)(?:[eE][-+]?\d+)?`, flags: 'g', description: 'Integers, decimals and scientific notation.', sample: 'Constants: 3.14159, -0.5, .75, 6.02e23 and 42.', limitations: 'Uses "." as decimal separator only; locale formats such as 1.234,56 are not handled.' },
  { id: 'currency', category: 'Numbers', name: 'Currency amount ($1,234.56)', pattern: r`[$€£]\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|[$€£]\s?\d+(?:\.\d{2})?`, flags: 'g', description: 'Amounts with a $, € or £ sign and optional thousands separators.', sample: 'Costs $9.99, €1,250.00, £300 and $12,345,678.90.', limitations: 'Prefix symbols only (no "EUR 5" or "5 €") and no negative amounts or other currencies.' },
  { id: 'percent', category: 'Numbers', name: 'Percentage', pattern: r`\b\d{1,3}(?:\.\d+)?\s?%`, flags: 'g', description: 'Numbers followed by a percent sign.', sample: 'Up 12%, down 3.5 %, and 100% done.', limitations: 'Does not cap values at 100.' },

  // ---- Web ----
  { id: 'hex-color', category: 'Web', name: 'Hex colour', pattern: r`#(?:[0-9a-fA-F]{3}){1,2}\b`, flags: 'g', description: '#rgb or #rrggbb colours.', sample: 'Colors: #fff, #1A2B3C, #12345 (too short), #abcdef.', limitations: 'No #rgba / #rrggbbaa (8- and 4-digit) forms.' },
  { id: 'slug', category: 'Web', name: 'URL slug', pattern: r`^[a-z0-9]+(?:-[a-z0-9]+)*$`, flags: 'gm', description: 'Lower-case words joined by single hyphens.', sample: 'my-first-post\nBad_Slug\nhello--world\nv2', limitations: 'ASCII only; accented letters and non-Latin scripts are rejected.' },
  { id: 'html-tag', category: 'Web', name: 'HTML tag', pattern: r`<\/?([a-z][a-z0-9]*)\b[^>]*>`, flags: 'gi', description: 'Opening, closing and self-closing tags with the tag name captured.', sample: '<div class="a"><p>Hello <b>world</b></p><br/></div>', limitations: 'Regex cannot parse HTML: attribute values containing ">" , comments and nested structure break it. Use a real parser for anything important.' },
  { id: 'md-link', category: 'Web', name: 'Markdown link', pattern: r`\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)`, flags: 'g', description: '[text](url "title") with captured text, url and optional title.', sample: 'See [MDN](https://developer.mozilla.org) and [a "quote"](http://x.org "Title").', limitations: 'URLs containing parentheses and reference-style links are not supported.' },
  { id: 'file-ext', category: 'Web', name: 'File extension', pattern: r`\.([A-Za-z0-9]+)$`, flags: 'gm', description: 'The last extension of each file name (captured without the dot).', sample: 'report.final.pdf\narchive.tar.gz\nREADME', limitations: 'Treats "archive.tar.gz" as ".gz"; dot-files like .gitignore match as an extension.' },
  { id: 'query-param', category: 'Web', name: 'Query string parameter', pattern: r`[?&]([^=&#]+)=([^&#]*)`, flags: 'g', description: 'Key and value pairs of a URL query string.', sample: 'https://x.org/search?q=regex&page=2&sort=desc#top', limitations: 'Values are not percent-decoded; use URLSearchParams for real parsing.' },

  // ---- Developer ----
  { id: 'uuid', category: 'Developer', name: 'UUID', pattern: r`\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b`, flags: 'gi', description: 'UUID versions 1-5 in the 8-4-4-4-12 form.', sample: 'id=123e4567-e89b-12d3-a456-426614174000 and 550e8400-e29b-41d4-a716-446655440000', limitations: 'Does not accept version 6-8 UUIDs or the nil UUID.' },
  { id: 'semver', category: 'Developer', name: 'Semantic version', pattern: r`\b(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?\b`, flags: 'g', description: 'major.minor.patch with optional pre-release and build metadata.', sample: 'Releases 1.0.0, 2.3.1-beta.2, 3.0.0+build.5 and 01.2.3 (invalid).', limitations: 'Simplified from the official semver.org expression; the invalid "01.2.3" still matches partially ("1.2.3").' },
  { id: 'git-hash', category: 'Developer', name: 'Git commit hash', pattern: r`\b[0-9a-f]{7,40}\b`, flags: 'gi', description: 'Abbreviated (7+) or full (40) hexadecimal commit ids.', sample: 'Fixed in 513b8e4, reverted in 5f188275d0c2f5a0e5e2d7f1c9b0a1b2c3d4e5f6.', limitations: 'Any 7-40 character hex word matches (including plain numbers like 1234567 and words like "deadbeef").' },
  { id: 'jwt', category: 'Developer', name: 'JWT shape', pattern: r`\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]*`, flags: 'g', description: 'Three base64url parts where the first two start with {" (eyJ).', sample: 'Authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl', limitations: 'Only checks the shape. Whether the token is valid or signed correctly is NOT verified; never paste real tokens into untrusted tools.' },
  { id: 'log-level', category: 'Developer', name: 'Log level', pattern: r`\b(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\b`, flags: 'g', description: 'Common severity words in log lines.', sample: '2024-03-15 INFO started\n2024-03-15 WARN slow query\n2024-03-15 ERROR failed', limitations: 'Upper-case only and matches the words anywhere in the line, including inside messages.' },
  { id: 'csv-field', category: 'Developer', name: 'CSV field', pattern: r`("(?:[^"]|"")*"|[^,\r\n]*)(,|\r?\n|$)`, flags: 'g', description: 'One field (plain or double-quoted) plus its delimiter.', sample: 'name,"Smith, John",42\n"say ""hi""",x,', limitations: 'Matches empty fields (including a final empty match); multi-line quoted fields need a real CSV parser for robustness.' },
  { id: 'quoted', category: 'Developer', name: 'Quoted string (with escapes)', pattern: r`"((?:[^"\\]|\\.)*)"`, flags: 'g', description: 'Double-quoted strings honouring backslash escapes.', sample: String.raw`say "hello" and "escaped \"quote\"" ok`, limitations: 'Single-quoted and multi-line strings are not handled.' },
  { id: 'env-var', category: 'Developer', name: '.env assignment', pattern: r`^([A-Z_][A-Z0-9_]*)=(.*)$`, flags: 'gm', description: 'KEY=value lines with the key and value captured.', sample: 'NODE_ENV=production\n# comment\nPORT=8080', limitations: 'Quotes and inline comments are not interpreted.' },
  { id: 'camel-boundary', category: 'Developer', name: 'camelCase word boundary', pattern: r`(?<=[a-z0-9])(?=[A-Z])`, flags: 'g', description: 'Zero-length positions between a lower-case letter and an upper-case one (use with Split).', sample: 'myVariableNameHTTP', limitations: 'Uses lookbehind (needs Safari 16.4+). Acronyms are not split ("HTTPServer").' },

  // ---- Text ----
  { id: 'dup-word', category: 'Text', name: 'Repeated word', pattern: r`\b(\w+)\s+\1\b`, flags: 'gi', description: 'Finds a word written twice in a row using a backreference.', sample: 'This is is a test of the the backreference.', limitations: 'ASCII word characters only; "that that" can be correct English.' },
  { id: 'multi-space', category: 'Text', name: 'Multiple spaces', pattern: r` {2,}`, flags: 'g', description: 'Runs of two or more spaces (replace with one space).', sample: 'too    many   spaces here', limitations: 'Spaces only; tabs and non-breaking spaces are not included.' },
  { id: 'hashtag', category: 'Text', name: 'Hashtag / mention', pattern: r`(?<![\w&])[#@][\p{L}\p{N}_]+`, flags: 'gu', description: 'Social-media style #tags and @mentions, including non-Latin letters.', sample: 'Hello @ada and #regex #ünïcode, mail me@x.org.', limitations: 'Needs the u flag and lookbehind; platform rules for what counts as a tag differ.' },
  { id: 'sentence', category: 'Text', name: 'Sentence', pattern: r`[^.!?]+[.!?]+`, flags: 'g', description: 'Splits text at ".", "!" or "?".', sample: 'Hi there. How are you? Fine!', limitations: 'Abbreviations ("Dr.") and decimals ("3.5") are treated as sentence ends.' },
  { id: 'ascii-only', category: 'Text', name: 'Non-ASCII characters', pattern: r`[^\x00-\x7F]+`, flags: 'g', description: 'Runs of characters outside the ASCII range.', sample: 'café naïve plain', limitations: 'Reports UTF-16 code units; astral characters (emoji) are two units unless the u flag is on.' },
  { id: 'unicode-letters', category: 'Text', name: 'Unicode words', pattern: r`[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*`, flags: 'gu', description: 'Words in any script, including apostrophes and hyphens inside them.', sample: "naïve café, don't, Москва and 東京", limitations: 'Needs the u flag; CJK text has no spaces so one match can be a whole phrase.' },
];

// ---------------- Cheat sheet ----------------
/** Sections of {title, items:[{token, desc, insert?}]}; `insert` (default: token) is what a click puts into the pattern. */
export const CHEATSHEET = [
  { title: 'Anchors', items: [
    { token: '^', desc: 'Start of string (start of line with the m flag)' },
    { token: '$', desc: 'End of string (end of line with the m flag)' },
    { token: '\\b', desc: 'Word boundary (ASCII word characters only)' },
    { token: '\\B', desc: 'Not a word boundary' },
  ] },
  { title: 'Character classes', items: [
    { token: '.', desc: 'Any character except a line break (any character with the s flag)' },
    { token: '\\d', desc: 'A digit 0-9 (ASCII only)' },
    { token: '\\D', desc: 'Not a digit' },
    { token: '\\w', desc: 'Word character [A-Za-z0-9_]' },
    { token: '\\W', desc: 'Not a word character' },
    { token: '\\s', desc: 'Whitespace (space, tab, line breaks, NBSP and more)' },
    { token: '\\S', desc: 'Not whitespace' },
    { token: '[abc]', desc: 'Any one of a, b or c' },
    { token: '[^abc]', desc: 'Any character except a, b, c' },
    { token: '[a-z]', desc: 'Any character in the range a to z' },
    { token: '\\n', desc: 'Line feed' },
    { token: '\\t', desc: 'Tab' },
    { token: '\\r', desc: 'Carriage return' },
    { token: '\\xHH', desc: 'Character with hex code HH (e.g. \\x41)', insert: '\\x41' },
    { token: '\\uHHHH', desc: 'UTF-16 code unit (e.g. \\u00e9)', insert: '\\u0041' },
    { token: '\\u{H+}', desc: 'Code point (needs the u or v flag)', insert: '\\u{1F600}' },
  ] },
  { title: 'Quantifiers', items: [
    { token: '*', desc: '0 or more (greedy)' },
    { token: '+', desc: '1 or more (greedy)' },
    { token: '?', desc: '0 or 1 (optional)' },
    { token: '{n}', desc: 'Exactly n times', insert: '{2}' },
    { token: '{n,}', desc: 'n or more times', insert: '{2,}' },
    { token: '{n,m}', desc: 'Between n and m times', insert: '{2,5}' },
    { token: '*?', desc: '0 or more, lazy (as few as possible)' },
    { token: '+?', desc: '1 or more, lazy' },
    { token: '??', desc: 'Optional, lazy' },
    { token: '{n,m}?', desc: 'Between n and m, lazy', insert: '{2,5}?' },
  ] },
  { title: 'Groups and references', items: [
    { token: '(...)', desc: 'Capturing group (numbered from 1)', insert: '()' },
    { token: '(?:...)', desc: 'Non-capturing group', insert: '(?:)' },
    { token: '(?<name>...)', desc: 'Named capturing group', insert: '(?<name>)' },
    { token: 'a|b', desc: 'Alternation: a or b', insert: '|' },
    { token: '\\1', desc: 'Backreference to group 1' },
    { token: '\\k<name>', desc: 'Backreference to a named group' },
  ] },
  { title: 'Lookaround', items: [
    { token: '(?=...)', desc: 'Positive lookahead: what follows must match', insert: '(?=)' },
    { token: '(?!...)', desc: 'Negative lookahead: what follows must not match', insert: '(?!)' },
    { token: '(?<=...)', desc: 'Positive lookbehind: what precedes must match (Safari 16.4+)', insert: '(?<=)' },
    { token: '(?<!...)', desc: 'Negative lookbehind: what precedes must not match (Safari 16.4+)', insert: '(?<!)' },
  ] },
  { title: 'Flags', items: [
    { token: 'g', desc: 'Global: find all matches', insert: '' },
    { token: 'i', desc: 'Ignore case', insert: '' },
    { token: 'm', desc: 'Multiline: ^ and $ match at each line', insert: '' },
    { token: 's', desc: 'dotAll: . also matches line breaks', insert: '' },
    { token: 'u', desc: 'Unicode: code points, \\p{...} and \\u{...}', insert: '' },
    { token: 'y', desc: 'Sticky: match only at lastIndex', insert: '' },
    { token: 'd', desc: 'Indices: record start/end of every group', insert: '' },
    { token: 'v', desc: 'Unicode sets: set operations in classes (not combinable with u)', insert: '' },
  ] },
  { title: 'Unicode property escapes (u flag)', items: [
    { token: '\\p{L}', desc: 'Any letter' },
    { token: '\\p{Lu}', desc: 'Upper-case letter' },
    { token: '\\p{Ll}', desc: 'Lower-case letter' },
    { token: '\\p{N}', desc: 'Any number' },
    { token: '\\p{Nd}', desc: 'Decimal digit in any script' },
    { token: '\\p{P}', desc: 'Punctuation' },
    { token: '\\p{Emoji}', desc: 'Emoji characters' },
    { token: '\\p{Script=Greek}', desc: 'Characters of a script (e.g. Greek, Cyrillic, Han)' },
    { token: '\\P{L}', desc: 'Anything that is not a letter' },
  ] },
  { title: 'Replacement tokens (Replace tab)', replacement: true, items: [
    { token: '$1', desc: 'Text captured by group 1' },
    { token: '$<name>', desc: 'Text captured by a named group' },
    { token: '$&', desc: 'The whole match' },
    { token: '$`', desc: 'Text before the match' },
    { token: "$'", desc: 'Text after the match' },
    { token: '$$', desc: 'A literal dollar sign' },
  ] },
];

/** Case-insensitive filter over library entries by text query and category ('' / 'All' = every category). */
export function filterLibrary(entries, query = '', category = '') {
  const q = String(query).trim().toLowerCase();
  return entries.filter(e => (!category || category === 'All' || e.category === category)
    && (!q || `${e.name} ${e.category} ${e.description} ${e.pattern}`.toLowerCase().includes(q)));
}

/** Filter the cheat sheet; sections without matching items are dropped. */
export function filterCheatsheet(sections, query = '') {
  const q = String(query).trim().toLowerCase();
  if (!q) return sections;
  return sections.map(s => ({ ...s, items: s.items.filter(i => `${i.token} ${i.desc} ${s.title}`.toLowerCase().includes(q)) })).filter(s => s.items.length);
}

export const libraryCategories = entries => [...new Set(entries.map(e => e.category))];

// ---------------- Saved patterns ----------------
export const SAVED_LIMIT = 200;
const VALID_FLAGS = /^[dgimsuvy]*$/;

/** Normalise one saved-pattern candidate; returns a clean object or null when it is unusable. */
export function sanitizeSaved(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const pattern = typeof x.pattern === 'string' ? x.pattern : null;
  if (pattern === null || pattern.length > 20000) return null;
  const flags = typeof x.flags === 'string' && VALID_FLAGS.test(x.flags) ? [...new Set(x.flags)].join('') : null;
  if (flags === null) return null;
  const name = typeof x.name === 'string' ? x.name.trim().slice(0, 80) : '';
  if (!name) return null;
  return {
    id: typeof x.id === 'string' && x.id && x.id.length <= 64 ? x.id : newId(),
    name, pattern, flags,
    notes: typeof x.notes === 'string' ? x.notes.slice(0, 2000) : '',
    sample: typeof x.sample === 'string' ? x.sample.slice(0, 20000) : '',
    created: Number.isFinite(x.created) ? x.created : 0,
  };
}

let counter = 0;
function newId() { return `s${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

/** Validate a stored/imported list: drops unusable items and duplicate ids, caps the length. Returns {items, dropped}. */
export function validateSavedList(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const items = [], ids = new Set();
  let dropped = 0;
  for (const x of list) {
    const s = sanitizeSaved(x);
    if (!s) { dropped++; continue; }
    if (ids.has(s.id)) s.id = newId();
    ids.add(s.id);
    if (items.length >= SAVED_LIMIT) { dropped++; continue; }
    items.push(s);
  }
  return { items, dropped };
}

/** Parse an exported JSON document ({format, version, patterns:[...]} or a bare array). Returns {ok, items?, dropped?, error?}. */
export function parseSavedExport(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, error: 'The file is not valid JSON.' }; }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.patterns) ? data.patterns : null;
  if (!list) return { ok: false, error: 'No "patterns" array found in the file.' };
  const { items, dropped } = validateSavedList(list);
  if (!items.length) return { ok: false, error: 'The file contains no valid patterns.' };
  return { ok: true, items, dropped };
}

export function serializeSaved(items) {
  return JSON.stringify({ format: 'developer-toolbox-regex-patterns', version: 1, patterns: items.map(({ name, pattern, flags, notes, sample, created }) => ({ name, pattern, flags, notes, sample, created })) }, null, 2);
}

/** Create a new saved entry (or null when invalid). */
export function makeSaved({ name, pattern, flags, notes = '', sample = '' }) {
  return sanitizeSaved({ name, pattern, flags, notes, sample, created: Date.now() });
}

/** Merge imported items into the list, giving name clashes a " (2)" suffix. Returns the new list. */
export function mergeSaved(existing, incoming) {
  const out = [...existing];
  const names = new Set(out.map(s => s.name.toLowerCase()));
  for (const s of incoming) {
    if (out.length >= SAVED_LIMIT) break;
    let name = s.name, n = 2;
    while (names.has(name.toLowerCase())) name = `${s.name} (${n++})`;
    names.add(name.toLowerCase());
    out.push({ ...s, name, id: newId() });
  }
  return out;
}
