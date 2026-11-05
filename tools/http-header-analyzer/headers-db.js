// Built-in knowledge base of HTTP header fields (short MDN-style descriptions written for this tool).
// Row: name | kind (req, res, both) | category | description | optional status note (deprecated / non-standard / experimental ...)
const ROWS = `
Accept|req|Content negotiation|Media types the client can handle, optionally weighted with q-values.
Accept-Charset|req|Content negotiation|Character sets the client accepts.|Deprecated: browsers no longer send it; UTF-8 is assumed.
Accept-Encoding|req|Content negotiation|Content codings (gzip, br, zstd...) the client can decode.
Accept-Language|req|Content negotiation|Preferred natural languages for the response, with q-values.
Accept-Patch|res|Content negotiation|Patch document formats the server accepts in PATCH requests.
Accept-Post|res|Content negotiation|Media types the server accepts in POST requests.
Accept-Ranges|res|Range|Whether the server supports range requests (bytes) or not (none).
Access-Control-Allow-Credentials|res|CORS|Set to true to allow credentialed cross-origin requests (cookies, HTTP auth).
Access-Control-Allow-Headers|res|CORS|Request headers allowed in the actual cross-origin request (preflight response).
Access-Control-Allow-Methods|res|CORS|HTTP methods allowed for cross-origin requests (preflight response).
Access-Control-Allow-Origin|res|CORS|Which origin may read the response: one origin, null, or * for any.
Access-Control-Allow-Private-Network|res|CORS|Opt-in for requests from public sites to private network addresses.|Experimental
Access-Control-Expose-Headers|res|CORS|Response headers that scripts on other origins may read.
Access-Control-Max-Age|res|CORS|How many seconds a preflight response may be cached.
Access-Control-Request-Headers|req|CORS|Preflight: the headers the actual request will send.
Access-Control-Request-Method|req|CORS|Preflight: the method the actual request will use.
Access-Control-Request-Private-Network|req|CORS|Preflight: the request targets a private network.|Experimental
Accept-CH|res|Client Hints|Asks the browser to send the listed Client Hint request headers.
Age|res|Caching|Seconds the response has been stored in a shared cache.
Allow|res|Controls|Methods supported by the resource (required with 405).
Alt-Svc|res|Connection|Advertises alternative services (for example HTTP/3) for the origin.
Alt-Used|req|Connection|The alternative service actually used for this request.
Authentication-Info|res|Authentication|Information after successful authentication (for example Digest nextnonce).
Authorization|req|Authentication|Credentials for authenticating the client with the server.
Baggage|req|Tracing|W3C Baggage: key-value context propagated with a request.
Cache-Control|both|Caching|Directives controlling caching in browsers and shared caches.
Cache-Status|res|Caching|Reports how caches handled the request (hit, miss, ...).
CDN-Cache-Control|res|Caching|Cache directives aimed at CDNs only.
CF-Cache-Status|res|Proxy|Cloudflare: whether the response was served from cache.|Vendor-specific
CF-Connecting-IP|req|Proxy|Cloudflare: the original client IP address.|Vendor-specific
CF-Ray|res|Proxy|Cloudflare request identifier for debugging.|Vendor-specific
Cdn-Loop|req|Proxy|Prevents request loops between CDNs.
Clear-Site-Data|res|Security|Asks the browser to clear cookies, storage or cache for the site.
Connection|both|Connection|Controls whether the connection stays open and lists hop-by-hop headers.
Content-Digest|both|Content|Digest of the message content (RFC 9530).
Content-Disposition|res|Content|Whether content is shown inline or downloaded (attachment), with a filename.
Content-DPR|res|Client Hints|Image device pixel ratio chosen by the server.|Deprecated
Content-Encoding|both|Content|Compression or other coding applied to the body.
Content-Language|both|Content|Natural language of the intended audience.
Content-Length|both|Content|Size of the body in bytes.
Content-Location|res|Content|URL of the returned representation (may differ from the request URL).
Content-MD5|both|Content|Base64 MD5 digest of the body.|Obsolete: removed in RFC 7231.
Content-Range|res|Range|Which part of the full resource a partial response contains.
Content-Security-Policy|res|Security|Declares trusted content sources to mitigate XSS and data injection.
Content-Security-Policy-Report-Only|res|Security|Like CSP but only reports violations without blocking.
Content-Type|both|Content|Media type (and charset/boundary) of the body.
Cookie|req|Cookies|Cookies previously set by the server, sent back to it.
Critical-CH|res|Client Hints|Client Hints that are critical: the browser retries the request if they were missing.|Experimental
Cross-Origin-Embedder-Policy|res|Security|Controls loading of cross-origin resources (require-corp, credentialless); needed for cross-origin isolation.
Cross-Origin-Embedder-Policy-Report-Only|res|Security|COEP in report-only mode.
Cross-Origin-Opener-Policy|res|Security|Isolates the browsing context group from cross-origin popups and openers.
Cross-Origin-Opener-Policy-Report-Only|res|Security|COOP in report-only mode.
Cross-Origin-Resource-Policy|res|Security|Which sites may load this resource (same-origin, same-site, cross-origin).
Date|both|General|Date and time at which the message was generated.
Deprecation|res|Controls|Marks the resource as deprecated (date or true).
Device-Memory|req|Client Hints|Approximate device RAM in GiB.|Experimental
Digest|both|Content|Digest of the representation (RFC 3230).|Obsolete: replaced by Content-Digest / Repr-Digest.
DNT|req|Security|Do Not Track preference.|Deprecated: removed from browsers; superseded by Sec-GPC.
Document-Policy|res|Security|Configures document features (for example js-profiling).|Experimental
Downlink|req|Client Hints|Approximate downstream bandwidth in Mbps.|Experimental
DPR|req|Client Hints|Client device pixel ratio.|Deprecated
Early-Data|req|Connection|The request was sent in TLS 1.3 early data (0-RTT) and may be replayed.
ECT|req|Client Hints|Effective connection type (4g, 3g, ...).|Experimental
ETag|res|Caching|Opaque validator identifying a specific version of the resource.
Expect|req|Controls|Expectations the server must meet, usually 100-continue.
Expect-CT|res|Security|Certificate Transparency enforcement.|Deprecated: no longer needed; browsers enforce CT.
Expires|res|Caching|Date after which the response is stale (ignored when Cache-Control max-age/s-maxage is present).
Feature-Policy|res|Security|Controls browser features per document.|Deprecated: replaced by Permissions-Policy.
Forwarded|both|Proxy|Standardised information about the client as seen by proxies (for, host, proto, by).
From|req|General|Email address of the person or robot controlling the client.
Host|req|General|Host and optional port of the server being requested; required in HTTP/1.1.
Idempotency-Key|req|Controls|Client-chosen key that makes POST/PATCH retries safe.
If-Match|req|Conditional|Only perform the request if the resource ETag matches.
If-Modified-Since|req|Conditional|Return the resource only if modified after this date (otherwise 304).
If-None-Match|req|Conditional|Return the resource only if its ETag does not match (otherwise 304).
If-Range|req|Conditional|Make a range request conditional on a matching validator.
If-Unmodified-Since|req|Conditional|Only perform the request if the resource was not modified after this date.
Keep-Alive|both|Connection|Parameters (timeout, max) for a persistent connection.
Last-Event-ID|req|General|Last event ID received by an EventSource, used to resume a stream.
Last-Modified|res|Caching|When the resource was last modified; used for conditional requests.
Link|res|General|Typed links to related resources (preload, canonical, next, ...).
Location|res|Redirect|URL to redirect to, or the URL of a newly created resource.
Max-Forwards|req|Proxy|Limits the number of proxies a TRACE/OPTIONS request may pass through.
NEL|res|Security|Network Error Logging policy.|Experimental
Origin|req|CORS|Origin (scheme, host, port) that initiated the request.
Origin-Agent-Cluster|res|Security|Requests origin-keyed agent clustering for the document.
Pragma|both|Caching|Legacy HTTP/1.0 cache control (no-cache).|Deprecated: use Cache-Control.
Prefer|req|Controls|Client preferences such as return=minimal or respond-async.
Preference-Applied|res|Controls|Which Prefer preferences the server applied.
Priority|both|Controls|Urgency and incremental delivery hints for a response (RFC 9218).
Proxy-Authenticate|res|Authentication|Authentication method a proxy requires (with 407).
Proxy-Authorization|req|Authentication|Credentials for authenticating with a proxy.
Proxy-Connection|req|Proxy|Non-standard predecessor of Connection used by some proxies.|Non-standard
Public-Key-Pins|res|Security|HTTP Public Key Pinning.|Removed: browsers dropped HPKP; it can brick a site.
Purpose|req|Fetch Metadata|Indicates a prefetch or prerender request.|Non-standard
Range|req|Range|Requests only part of a resource (bytes=0-99).
Referer|req|General|URL of the page that linked to the request (the header name is historically misspelled).
Referrer-Policy|res|Security|How much referrer information is sent with requests from this page.
Refresh|res|Redirect|Reloads or redirects after N seconds.|Non-standard
Repr-Digest|both|Content|Digest of the selected representation (RFC 9530).
Report-To|res|Security|Reporting endpoints for CSP, NEL and other reports.|Deprecated: replaced by Reporting-Endpoints.
Reporting-Endpoints|res|Security|Named endpoints to which reports are sent.
Retry-After|res|Controls|How long to wait before retrying (seconds or HTTP date); used with 429, 503 and 3xx.
RTT|req|Client Hints|Approximate round-trip time in milliseconds.|Experimental
Save-Data|req|Client Hints|The client prefers reduced data usage.
Sec-CH-DPR|req|Client Hints|Client device pixel ratio.|Experimental
Sec-CH-Prefers-Color-Scheme|req|Client Hints|User's light/dark preference.|Experimental
Sec-CH-Prefers-Reduced-Motion|req|Client Hints|User's reduced-motion preference.|Experimental
Sec-CH-UA|req|Client Hints|Browser brand and significant version list (low-entropy).
Sec-CH-UA-Arch|req|Client Hints|CPU architecture (high-entropy).|Experimental
Sec-CH-UA-Bitness|req|Client Hints|CPU bitness (high-entropy).|Experimental
Sec-CH-UA-Full-Version|req|Client Hints|Full browser version.|Deprecated: use Sec-CH-UA-Full-Version-List.
Sec-CH-UA-Full-Version-List|req|Client Hints|Full browser brand and version list (high-entropy).|Experimental
Sec-CH-UA-Mobile|req|Client Hints|Whether the browser runs on a mobile device.
Sec-CH-UA-Model|req|Client Hints|Device model (high-entropy).|Experimental
Sec-CH-UA-Platform|req|Client Hints|Operating system name.
Sec-CH-UA-Platform-Version|req|Client Hints|Operating system version (high-entropy).|Experimental
Sec-CH-Viewport-Width|req|Client Hints|Layout viewport width in CSS pixels.|Experimental
Sec-CH-Width|req|Client Hints|Resource width in physical pixels.|Experimental
Sec-Fetch-Dest|req|Fetch Metadata|The destination of the request (document, script, image, ...).
Sec-Fetch-Mode|req|Fetch Metadata|The request mode (cors, navigate, no-cors, same-origin, websocket).
Sec-Fetch-Site|req|Fetch Metadata|Relationship between request initiator and target (same-origin, same-site, cross-site, none).
Sec-Fetch-User|req|Fetch Metadata|Present (?1) when a navigation was triggered by user activation.
Sec-GPC|req|Security|Global Privacy Control: user opts out of sale/sharing of personal data.
Sec-Purpose|req|Fetch Metadata|Indicates prefetch or prerender purpose of the request.
Sec-WebSocket-Accept|res|WebSocket|Server proof of the WebSocket handshake (derived from the client key).
Sec-WebSocket-Extensions|both|WebSocket|WebSocket extensions negotiated (for example permessage-deflate).
Sec-WebSocket-Key|req|WebSocket|Random base64 nonce for the WebSocket handshake.
Sec-WebSocket-Protocol|both|WebSocket|WebSocket subprotocols requested or selected.
Sec-WebSocket-Version|both|WebSocket|WebSocket protocol version (13).
Server|res|General|Software used by the origin server.
Server-Timing|res|General|Server-side performance metrics shown in browser dev tools.
Service-Worker-Allowed|res|Controls|Widens the maximum scope of a service worker.
Set-Cookie|res|Cookies|Sends a cookie from the server to the client.
Set-Cookie2|res|Cookies|Obsolete RFC 2965 cookie header.|Obsolete: removed; browsers ignore it.
SourceMap|res|General|Location of the source map for a script or stylesheet.
Strict-Transport-Security|res|Security|Tells browsers to use HTTPS only for this host for max-age seconds.
Sunset|res|Controls|Date after which the resource is expected to stop working.
Surrogate-Control|res|Caching|Cache directives for reverse proxies (Varnish, Fastly).|Non-standard
TE|req|Connection|Transfer codings the client accepts (only trailers is common).
Timing-Allow-Origin|res|Security|Origins allowed to read Resource Timing details.
Tk|res|Security|Tracking status of the response.|Obsolete: part of the abandoned DNT spec.
Traceparent|req|Tracing|W3C Trace Context: identifies the trace and parent span.
Tracestate|req|Tracing|W3C Trace Context: vendor-specific tracing data.
Trailer|both|Connection|Names of headers sent after the body (trailers).
Transfer-Encoding|both|Connection|Encoding used to transfer the body (chunked).
Upgrade|both|Connection|Asks to switch protocol (websocket, h2c).
Upgrade-Insecure-Requests|req|Security|Client prefers an HTTPS upgrade of insecure resources.
User-Agent|req|General|Identifies the client software.
Vary|res|Caching|Request headers that affect which cached response may be reused.
Via|both|Proxy|Intermediate proxies and gateways the message passed through.
Viewport-Width|req|Client Hints|Layout viewport width.|Deprecated
Want-Content-Digest|req|Content|Requests a Content-Digest response header.
Want-Repr-Digest|req|Content|Requests a Repr-Digest response header.
Warning|both|General|Additional information about message status.|Deprecated: removed from the HTTP specification.
Width|req|Client Hints|Desired resource width in physical pixels.|Deprecated
WWW-Authenticate|res|Authentication|Authentication method(s) required to access the resource (with 401).
X-AspNet-Version|res|Information leak|ASP.NET framework version.|Non-standard: reveals the framework version.
X-AspNetMvc-Version|res|Information leak|ASP.NET MVC version.|Non-standard: reveals the framework version.
X-Cache|res|Proxy|Whether a proxy or CDN served the response from cache (HIT/MISS).|Non-standard
X-Cache-Hits|res|Proxy|Number of cache hits for the object (Varnish/Fastly).|Non-standard
X-Content-Type-Options|res|Security|nosniff stops browsers from MIME-sniffing the content type.
X-Correlation-ID|both|Tracing|Identifier used to correlate a request across services.|Non-standard
X-DNS-Prefetch-Control|res|Security|Enables or disables browser DNS prefetching.|Non-standard
X-Download-Options|res|Security|Internet Explorer: noopen hides the Open button for downloads.|Obsolete
X-Forwarded-For|req|Proxy|Client IP address chain added by proxies.|Non-standard: prefer Forwarded.
X-Forwarded-Host|req|Proxy|Original Host requested by the client.|Non-standard
X-Forwarded-Port|req|Proxy|Original port requested by the client.|Non-standard
X-Forwarded-Proto|req|Proxy|Original protocol (http or https) used by the client.|Non-standard
X-Frame-Options|res|Security|Controls whether the page may be embedded in frames (DENY, SAMEORIGIN).
X-Generator|res|Information leak|Software that generated the page (CMS name/version).|Non-standard: reveals software.
X-HTTP-Method-Override|req|Controls|Overrides the HTTP method of the request.|Non-standard
X-Permitted-Cross-Domain-Policies|res|Security|Adobe Flash/PDF cross-domain policy permissions.|Obsolete
X-Powered-By|res|Information leak|Technology powering the application (PHP, Express, ...).|Non-standard: reveals technology.
X-Real-IP|req|Proxy|Client IP address as seen by the first proxy.|Non-standard
X-Request-ID|both|Tracing|Unique identifier of the request for logs and debugging.|Non-standard
X-Requested-With|req|General|XMLHttpRequest marker sent by some libraries.|Non-standard
X-Robots-Tag|res|Controls|Indexing directives for search engines (noindex, nofollow, ...).
X-Runtime|res|Information leak|Request processing time (Rails).|Non-standard
X-Served-By|res|Proxy|Cache or server node that served the response.|Non-standard
X-UA-Compatible|res|Controls|Internet Explorer compatibility mode.|Obsolete
X-XSS-Protection|res|Security|Legacy browser XSS filter control.|Deprecated: removed from browsers; use 0 or omit and rely on CSP.
`.trim().split('\n');

export const HEADER_DB = Object.fromEntries(ROWS.map(line => {
  const [name, kind, category, description, note] = line.split('|');
  return [name.toLowerCase(), { name, kind, category, description, note: note || '' }];
}));
export const HEADER_COUNT = Object.keys(HEADER_DB).length;
export const lookupHeader = name => HEADER_DB[String(name).toLowerCase()] || null;
