
export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    const contentType = response.headers.get("Content-Type") || "";

    // Only modify HTML responses.
    if (!contentType.includes("text/html")) {
      return response;
    }

    // Generate a new random nonce for each response.
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);

    const nonce = btoa(
      String.fromCharCode(...bytes)
    );

    const csp = [
      "default-src 'self'",
      `script-src 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' 'unsafe-eval' https: http:`,
      "connect-src 'self' https:",
      "img-src 'self' blob: data: https:",
      "style-src 'self' 'unsafe-inline' https:",
      "font-src 'self' https: data:",
      "frame-src https:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'none'"
    ].join("; ");

    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", csp);

    const securedResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });

    return new HTMLRewriter()
      .on("script", {
        element(element) {
          element.setAttribute("nonce", nonce);
        }
      })
      .transform(securedResponse);
  }
};
