// HTTP status code data set. Pure data + tiny helpers, no DOM access.
// Official codes follow the IANA "HTTP Status Code Registry" (RFC 9110 titles).
// Unofficial codes are vendor/framework specific and flagged `unofficial: true`.

export const CATEGORIES = {
  '1xx': 'Informational',
  '2xx': 'Success',
  '3xx': 'Redirection',
  '4xx': 'Client error',
  '5xx': 'Server error',
  unofficial: 'Unofficial',
};

// [code, title, description, commonUsage, whenYouSeeIt, rfc, hint]
const OFFICIAL = [
  [100, 'Continue', 'The server has received the request headers and the client should proceed to send the body.', 'Used with the "Expect: 100-continue" header so a client can avoid uploading a large body that the server would reject.', 'curl sending a large POST with Expect: 100-continue.', 'RFC 9110 §15.2.1', ''],
  [101, 'Switching Protocols', 'The server agrees to switch to the protocol requested in the Upgrade header.', 'Upgrading a connection to WebSocket (or HTTP/2 over cleartext).', 'Successful WebSocket handshake.', 'RFC 9110 §15.2.2', ''],
  [102, 'Processing', 'The server has accepted the request but has not finished processing it yet (WebDAV).', 'Keeps a client from timing out during long WebDAV operations. Deprecated; rarely sent today.', 'Long-running WebDAV COPY/MOVE on very old servers.', 'RFC 2518 (obsoleted by RFC 4918)', ''],
  [103, 'Early Hints', 'Sends preliminary response headers (typically Link) before the final response.', 'Lets browsers start preloading CSS/JS while the server is still building the page.', 'CDNs and servers sending Link: <...>; rel=preload ahead of a 200.', 'RFC 8297', ''],

  [200, 'OK', 'The request succeeded. The meaning of the body depends on the method used.', 'Default success for GET (resource returned), POST (result returned) and most other requests.', 'Fetching a page or calling a JSON API successfully.', 'RFC 9110 §15.3.1', 'Cacheable by default'],
  [201, 'Created', 'The request succeeded and a new resource was created.', 'Response to POST/PUT that creates something; usually includes a Location header pointing at the new resource.', 'POST /users returns the new user with Location: /users/42.', 'RFC 9110 §15.3.2', ''],
  [202, 'Accepted', 'The request was accepted for processing, but processing is not complete.', 'Asynchronous jobs: queueing an email, export or long-running task; may return a status-monitor URL.', 'POST /reports returns 202 and a job URL to poll.', 'RFC 9110 §15.3.3', ''],
  [203, 'Non-Authoritative Information', 'The request succeeded but the content was modified by a transforming proxy from the origin\'s 200.', 'Rare. Sent by proxies that rewrite responses.', 'A transforming proxy altering the origin response.', 'RFC 9110 §15.3.4', 'Cacheable by default'],
  [204, 'No Content', 'The request succeeded and there is no body to return.', 'Successful DELETE or PUT/PATCH when nothing needs to be returned; CORS preflight (OPTIONS) responses.', 'DELETE /items/5 succeeds.', 'RFC 9110 §15.3.5', 'Cacheable by default'],
  [205, 'Reset Content', 'The request succeeded and the client should reset the document view (e.g. clear a form).', 'Rare. Forms that should be cleared after submission.', 'A form POST telling the browser to clear its inputs.', 'RFC 9110 §15.3.6', ''],
  [206, 'Partial Content', 'The server is delivering only part of the resource because of a Range request.', 'Resumable downloads and video/audio seeking; includes Content-Range.', 'A browser requesting "Range: bytes=0-1023" of a video.', 'RFC 9110 §15.3.7', 'Cacheable by default'],
  [207, 'Multi-Status', 'The body is an XML document with separate status codes for several sub-operations (WebDAV).', 'WebDAV PROPFIND and batch operations.', 'PROPFIND listing properties of many files.', 'RFC 4918 §11.1', ''],
  [208, 'Already Reported', 'Members of a WebDAV binding were already listed in an earlier part of the multi-status response.', 'Avoids repeating the same members in a WebDAV multi-status response.', 'WebDAV Depth: infinity PROPFIND with bindings.', 'RFC 5842 §7.1', ''],
  [226, 'IM Used', 'The server fulfilled a GET using one or more instance manipulations (delta encoding).', 'Very rare. Delta encoding for HTTP.', 'Servers implementing RFC 3229 delta encoding.', 'RFC 3229 §10.4.1', ''],

  [300, 'Multiple Choices', 'The request has more than one possible response; the client or user should choose.', 'Rarely used because there is no standard way to pick the choice automatically.', 'A server offering the same document in several formats.', 'RFC 9110 §15.4.1', 'Cacheable by default'],
  [301, 'Moved Permanently', 'The resource has a new permanent URL given in the Location header.', 'Permanent site moves, HTTP to HTTPS redirects, canonical URL changes (good for SEO). Clients may change POST to GET.', 'http://example.com redirects to https://example.com.', 'RFC 9110 §15.4.2', 'Cacheable by default'],
  [302, 'Found', 'The resource is temporarily at a different URL given in the Location header.', 'Temporary redirects such as post-login redirects. Many clients change POST to GET; use 307 to forbid that.', 'Redirect to /login with a return URL.', 'RFC 9110 §15.4.3', ''],
  [303, 'See Other', 'The response to the request is at another URL and should be retrieved with GET.', 'Post/Redirect/Get pattern: after a form POST, redirect the browser to a result page.', 'POST /orders returns 303 to GET /orders/17.', 'RFC 9110 §15.4.4', ''],
  [304, 'Not Modified', 'The cached copy is still valid; no body is sent.', 'Response to conditional requests (If-None-Match / If-Modified-Since).', 'Browser revalidates a cached image with an ETag.', 'RFC 9110 §15.4.5', ''],
  [305, 'Use Proxy', 'The resource must be accessed through the proxy in the Location header.', 'Deprecated for security reasons; clients should not act on it.', 'Essentially never seen today.', 'RFC 9110 §15.4.6 (deprecated)', ''],
  [306, '(Unused)', 'Reserved. Was used in an earlier draft of the specification ("Switch Proxy").', 'Do not use. The code stays reserved.', 'Never sent.', 'RFC 9110 §15.4.7', ''],
  [307, 'Temporary Redirect', 'Temporary redirect that requires the client to repeat the same method and body.', 'Temporary redirects where a POST must stay a POST; HSTS internal redirects in browsers.', 'API endpoint temporarily moved to another host.', 'RFC 9110 §15.4.8', ''],
  [308, 'Permanent Redirect', 'Permanent redirect that requires the client to repeat the same method and body.', 'Like 301 but guarantees the method is not changed from POST to GET.', 'API permanently moved: POST /v1/x to POST /v2/x.', 'RFC 9110 §15.4.9 (originally RFC 7538)', 'Cacheable by default'],

  [400, 'Bad Request', 'The server cannot process the request because it is malformed or invalid.', 'Invalid JSON, missing parameters, bad syntax or failed validation in many APIs.', 'POST with a malformed JSON body.', 'RFC 9110 §15.5.1', ''],
  [401, 'Unauthorized', 'The request lacks valid authentication credentials (really "unauthenticated").', 'Missing or expired token/password. Response includes a WWW-Authenticate header.', 'Calling an API without a valid Bearer token.', 'RFC 9110 §15.5.2', ''],
  [402, 'Payment Required', 'Reserved for future digital payment schemes.', 'Not standardised; some APIs use it for billing problems or exhausted quota.', 'A SaaS API whose subscription has lapsed.', 'RFC 9110 §15.5.3', ''],
  [403, 'Forbidden', 'The server understood the request but refuses to authorise it.', 'Authenticated but lacking permission, IP blocked, or directory listing disabled.', 'A normal user opening an admin-only endpoint.', 'RFC 9110 §15.5.4', ''],
  [404, 'Not Found', 'The server cannot find the requested resource.', 'Wrong URL, deleted resource. Some servers return 404 instead of 403 to hide existence.', 'GET /users/99999 for a user that does not exist.', 'RFC 9110 §15.5.5', 'Cacheable by default'],
  [405, 'Method Not Allowed', 'The method is known but not supported for this resource.', 'Must include an Allow header listing supported methods.', 'DELETE on a read-only endpoint.', 'RFC 9110 §15.5.6', 'Cacheable by default'],
  [406, 'Not Acceptable', 'The server cannot produce a response matching the Accept* headers.', 'Content negotiation failure (type, language, encoding).', 'Accept: application/xml on a JSON-only API.', 'RFC 9110 §15.5.7', ''],
  [407, 'Proxy Authentication Required', 'Like 401, but authentication must be done with the proxy.', 'Corporate proxies requiring credentials; includes Proxy-Authenticate.', 'Request through an authenticating HTTP proxy.', 'RFC 9110 §15.5.8', ''],
  [408, 'Request Timeout', 'The server timed out waiting for the client to finish sending the request.', 'Slow or stalled uploads and idle connections closed by the server.', 'A client opens a connection and sends nothing.', 'RFC 9110 §15.5.9', 'Retryable'],
  [409, 'Conflict', 'The request conflicts with the current state of the resource.', 'Edit conflicts, duplicate unique values, version mismatches.', 'Creating a user whose email already exists.', 'RFC 9110 §15.5.10', ''],
  [410, 'Gone', 'The resource was intentionally removed and will not come back.', 'Permanently deleted content; stronger than 404 for search engines.', 'An expired promotion page that was deleted on purpose.', 'RFC 9110 §15.5.11', 'Cacheable by default'],
  [411, 'Length Required', 'The server requires a Content-Length header.', 'Servers that refuse chunked or length-less request bodies.', 'POST without Content-Length to a strict server.', 'RFC 9110 §15.5.12', ''],
  [412, 'Precondition Failed', 'A precondition in the request headers (If-Match, If-Unmodified-Since...) evaluated to false.', 'Optimistic concurrency control with ETags.', 'PUT with a stale If-Match ETag.', 'RFC 9110 §15.5.13', ''],
  [413, 'Content Too Large', 'The request body is larger than the server is willing to process. Formerly named "Payload Too Large" (and "Request Entity Too Large").', 'File upload limits (e.g. nginx client_max_body_size).', 'Uploading a 50 MB file to a 10 MB limit.', 'RFC 9110 §15.5.14', ''],
  [414, 'URI Too Long', 'The request URI is longer than the server is willing to interpret.', 'Huge query strings, redirect loops that keep appending parameters.', 'GET with tens of thousands of characters in the query.', 'RFC 9110 §15.5.15', 'Cacheable by default'],
  [415, 'Unsupported Media Type', 'The request body format (Content-Type) is not supported for this resource.', 'Sending form data to a JSON-only endpoint, or vice versa.', 'POST with Content-Type: text/plain to an API expecting JSON.', 'RFC 9110 §15.5.16', ''],
  [416, 'Range Not Satisfiable', 'None of the ranges in the Range header overlap the resource.', 'Download resume offset beyond the end of the file; includes Content-Range: bytes */length.', 'Range: bytes=5000- on a 1000-byte file.', 'RFC 9110 §15.5.17', ''],
  [417, 'Expectation Failed', 'The server cannot meet the requirements of the Expect request header.', 'Rare; some proxies reject Expect: 100-continue.', 'Old proxy rejecting Expect: 100-continue.', 'RFC 9110 §15.5.18', ''],
  [418, "I'm a teapot", 'An April Fools\' joke from the Hyper Text Coffee Pot Control Protocol: the teapot refuses to brew coffee. Now reserved ("(Unused)" in RFC 9110).', 'Easter egg / placeholder; occasionally used to mock bots or block scrapers.', 'BREW request sent to a teapot.', 'RFC 2324 / RFC 7168; reserved in RFC 9110 §15.5.19', ''],
  [421, 'Misdirected Request', 'The request was sent to a server that cannot produce a response for the requested host/scheme.', 'HTTP/2 connection reuse across hostnames with a shared certificate.', 'Browser reuses a connection to the wrong virtual host.', 'RFC 9110 §15.5.20', ''],
  [422, 'Unprocessable Content', 'The request is well-formed but contains semantic errors. Formerly named "Unprocessable Entity".', 'Validation failures in REST APIs (Rails, FastAPI, Laravel...).', 'JSON is valid but "email" is not a valid address.', 'RFC 9110 §15.5.21 (originally RFC 4918 §11.2)', ''],
  [423, 'Locked', 'The resource being accessed is locked (WebDAV).', 'WebDAV lock conflicts.', 'Editing a file another user has locked.', 'RFC 4918 §11.3', ''],
  [424, 'Failed Dependency', 'The request failed because a previous request it depended on failed (WebDAV).', 'Part of a multi-status or batch operation.', 'One failed step in a WebDAV PROPPATCH.', 'RFC 4918 §11.4', ''],
  [425, 'Too Early', 'The server is unwilling to risk processing a request that might be replayed (TLS early data).', 'Protects against replay attacks with TLS 1.3 0-RTT.', 'A request sent as 0-RTT early data to a non-idempotent endpoint.', 'RFC 8470', 'Retryable (after the handshake completes)'],
  [426, 'Upgrade Required', 'The client must switch to a different protocol given in the Upgrade header.', 'Forcing TLS upgrade or a newer protocol version.', 'Server requires TLS/1.3 upgrade.', 'RFC 9110 §15.5.22', ''],
  [428, 'Precondition Required', 'The server requires the request to be conditional.', 'Prevents "lost update" problems by demanding If-Match.', 'PUT without If-Match to an API that needs it.', 'RFC 6585 §3', ''],
  [429, 'Too Many Requests', 'The client has sent too many requests in a given time (rate limiting).', 'API rate limits; may include Retry-After.', 'Exceeding 100 requests per minute.', 'RFC 6585 §4', 'Retryable after the Retry-After delay'],
  [431, 'Request Header Fields Too Large', 'The server refuses the request because the headers (one or all) are too large.', 'Oversized cookies or giant Authorization/Referer headers.', 'Cookie bloat on a domain.', 'RFC 6585 §5', ''],
  [451, 'Unavailable For Legal Reasons', 'The resource cannot be served because of a legal demand (named after Fahrenheit 451).', 'Court orders, government censorship, GDPR/geo-blocking.', 'Content blocked in a particular country.', 'RFC 7725', ''],

  [500, 'Internal Server Error', 'The server encountered an unexpected condition that prevented it from fulfilling the request.', 'Generic catch-all for unhandled exceptions and bugs.', 'A null-pointer in the request handler.', 'RFC 9110 §15.6.1', ''],
  [501, 'Not Implemented', 'The server does not support the functionality required to fulfil the request.', 'Unknown HTTP method or an unbuilt feature.', 'A server receiving a method it does not recognise.', 'RFC 9110 §15.6.2', 'Cacheable by default'],
  [502, 'Bad Gateway', 'A gateway or proxy received an invalid response from the upstream server.', 'Reverse proxies (nginx, load balancers) when the app server is down or crashed.', 'nginx cannot reach or parse the upstream app.', 'RFC 9110 §15.6.3', 'Often retryable'],
  [503, 'Service Unavailable', 'The server is temporarily unable to handle the request (overload or maintenance).', 'Maintenance windows and overload; may include Retry-After.', 'Deployment in progress.', 'RFC 9110 §15.6.4', 'Retryable (honour Retry-After)'],
  [504, 'Gateway Timeout', 'A gateway or proxy did not receive a timely response from the upstream server.', 'Slow backends behind proxies/CDNs.', 'Upstream takes longer than proxy_read_timeout.', 'RFC 9110 §15.6.5', 'Often retryable (only if the request is idempotent)'],
  [505, 'HTTP Version Not Supported', 'The server does not support the HTTP protocol version used in the request.', 'Very rare.', 'A client speaking an unsupported HTTP version.', 'RFC 9110 §15.6.6', ''],
  [506, 'Variant Also Negotiates', 'The server has a configuration error in transparent content negotiation (circular reference).', 'Very rare.', 'Misconfigured transparent content negotiation.', 'RFC 2295 §8.1', ''],
  [507, 'Insufficient Storage', 'The server cannot store the representation needed to complete the request (WebDAV).', 'Disk quota exhausted on WebDAV servers.', 'Uploading to a full WebDAV share.', 'RFC 4918 §11.5', ''],
  [508, 'Loop Detected', 'The server detected an infinite loop while processing the request (WebDAV).', 'Circular bindings in WebDAV.', 'WebDAV Depth: infinity on cyclic bindings.', 'RFC 5842 §7.2', ''],
  [510, 'Not Extended', 'Further extensions to the request are required for the server to fulfil it.', 'Part of the HTTP Extension Framework; effectively historic.', 'Almost never seen.', 'RFC 2774 §7 (historic)', ''],
  [511, 'Network Authentication Required', 'The client must authenticate to gain network access.', 'Captive portals (hotel / airport Wi-Fi) intercepting traffic.', 'Opening any site before accepting Wi-Fi terms.', 'RFC 6585 §6', ''],
];

// Same tuple shape; the "rfc" slot holds the vendor / origin instead.
const UNOFFICIAL = [
  [419, 'Page Expired', 'Laravel: the CSRF token is missing or expired for the session.', 'Laravel (and some frameworks) for failed CSRF verification.', 'Submitting a Laravel form after the session expired.', 'Unofficial (Laravel)', ''],
  [420, 'Enhance Your Calm', 'Twitter API v1 rate limiting; also used by Spring Framework as "Method Failure".', 'Historic Twitter API rate limit response. Use 429 instead.', 'Old Twitter Search API when throttled.', 'Unofficial (Twitter / Spring)', ''],
  [444, 'No Response', 'nginx closes the connection without sending any response.', 'Used in nginx config to drop malicious or unwanted requests; appears only in logs.', 'return 444; in an nginx server block.', 'Unofficial (nginx)', ''],
  [494, 'Request Header Too Large', 'nginx: the request header or cookie is too large.', 'nginx maps it to 400 for the client; seen in logs.', 'Cookie bloat hitting large_client_header_buffers.', 'Unofficial (nginx)', ''],
  [495, 'SSL Certificate Error', 'nginx: an error occurred validating the client certificate.', 'Mutual TLS (client certificate) failures.', 'Invalid client certificate with ssl_verify_client on.', 'Unofficial (nginx)', ''],
  [496, 'SSL Certificate Required', 'nginx: a client certificate was required but not provided.', 'Mutual TLS setups.', 'Client without a certificate hits an mTLS-protected host.', 'Unofficial (nginx)', ''],
  [497, 'HTTP Request Sent to HTTPS Port', 'nginx: a plain HTTP request was sent to an HTTPS port.', 'Mixed-up ports in configuration.', 'curl http://host:443/', 'Unofficial (nginx)', ''],
  [499, 'Client Closed Request', 'nginx: the client closed the connection before the server answered.', 'Appears in nginx access logs when users cancel or time out.', 'Browser tab closed during a slow request.', 'Unofficial (nginx)', ''],
  [509, 'Bandwidth Limit Exceeded', 'The server has exceeded its allotted bandwidth.', 'Apache mod_bw and cPanel shared hosting.', 'A shared-hosting site over its bandwidth cap.', 'Unofficial (Apache / cPanel)', ''],
  [520, 'Web Server Returned an Unknown Error', 'Cloudflare: the origin server returned an empty, unknown or unexpected response.', 'Origin crashes, resets connections or sends oversized headers.', 'Origin app crashes while Cloudflare proxies to it.', 'Unofficial (Cloudflare)', ''],
  [521, 'Web Server Is Down', 'Cloudflare: the origin server refused the connection.', 'Origin offline or firewall blocking Cloudflare IPs.', 'Origin web server stopped.', 'Unofficial (Cloudflare)', ''],
  [522, 'Connection Timed Out', 'Cloudflare: could not complete a TCP connection to the origin in time.', 'Overloaded origin or firewall dropping Cloudflare traffic.', 'Origin does not answer the TCP handshake.', 'Unofficial (Cloudflare)', ''],
  [523, 'Origin Is Unreachable', 'Cloudflare: the origin cannot be reached (DNS or routing problem).', 'Wrong origin IP or network routing failure.', 'DNS record points at an unroutable address.', 'Unofficial (Cloudflare)', ''],
  [524, 'A Timeout Occurred', 'Cloudflare: connection was made but the origin did not reply in time (about 100 seconds by default).', 'Long-running requests behind Cloudflare.', 'A slow report export through the proxy.', 'Unofficial (Cloudflare)', ''],
  [525, 'SSL Handshake Failed', 'Cloudflare: TLS handshake with the origin failed.', 'Origin lacks SSL or has incompatible cipher/protocol settings.', 'Full SSL mode with an origin that does not speak TLS.', 'Unofficial (Cloudflare)', ''],
  [526, 'Invalid SSL Certificate', 'Cloudflare: could not validate the origin\'s SSL certificate.', 'Expired, self-signed or mismatched origin certificate in Full (Strict) mode.', 'Origin uses an expired certificate.', 'Unofficial (Cloudflare)', ''],
  [527, 'Railgun Error', 'Cloudflare: the connection to Railgun (origin accelerator) was interrupted.', 'Legacy; Railgun has been discontinued.', 'Old Railgun deployments.', 'Unofficial (Cloudflare)', ''],
  [530, 'Origin DNS Error (Cloudflare 1xxx)', 'Cloudflare: returned together with a 1xxx error code, often a DNS resolution failure for the origin.', 'Check the accompanying 1xxx error (e.g. 1016 Origin DNS error).', 'Origin hostname cannot be resolved.', 'Unofficial (Cloudflare)', ''],
];

const categoryOf = code => `${Math.floor(code / 100)}xx`;

function build(rows, unofficial) {
  return rows.map(([code, title, description, commonUsage, when, rfc, hint]) => {
    const line = `HTTP/1.1 ${code} ${title}`;
    const entry = {
      code, title,
      category: unofficial ? 'unofficial' : categoryOf(code),
      statusClass: categoryOf(code), // numeric class, used for badge colours
      unofficial,
      description, commonUsage, rfc,
      line,
      example: `${line}\n${when}`,
    };
    if (hint) entry.hint = hint;
    return entry;
  });
}

/** All codes, sorted ascending by code (unofficial entries interleave by number). */
export const STATUS_CODES = [...build(OFFICIAL, false), ...build(UNOFFICIAL, true)].sort((a, b) => a.code - b.code);

/**
 * Counts per filter chip: { all, '1xx', ..., unofficial }.
 * A class chip (and the "4xx" search) covers every code of that status class, official or not; the "unofficial"
 * chip lists all unofficial codes, so it overlaps the class chips on purpose.
 */
export function countByCategory(list = STATUS_CODES) {
  const counts = { all: list.length, '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, unofficial: 0 };
  for (const s of list) { counts[s.statusClass]++; if (s.unofficial) counts.unofficial++; }
  return counts;
}

/**
 * Search + filter.
 *  - "4xx" / "4XX" -> every code of that class
 *  - 1-3 digits ("40", "404") -> codes starting with those digits
 *  - otherwise every whitespace-separated word must appear in code/title/description/usage
 * `category` is 'all' | '1xx'..'5xx' | 'unofficial'.
 */
export function searchStatus(query, category = 'all', list = STATUS_CODES) {
  const q = String(query ?? '').trim().toLowerCase();
  let out = list;
  if (category === 'unofficial') out = out.filter(s => s.unofficial);
  else if (category !== 'all') out = out.filter(s => s.statusClass === category);
  if (!q) return out;

  if (/^[1-5]xx$/.test(q)) return out.filter(s => s.statusClass === q);
  if (/^\d{1,3}$/.test(q)) return out.filter(s => String(s.code).startsWith(q));

  const words = q.split(/\s+/);
  return out.filter(s => {
    const hay = `${s.code} ${s.title} ${s.description} ${s.commonUsage} ${s.rfc}`.toLowerCase();
    return words.every(w => hay.includes(w));
  });
}
