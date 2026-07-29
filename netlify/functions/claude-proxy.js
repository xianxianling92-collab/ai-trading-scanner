// Netlify Function: proxy aman ke Anthropic API.
// API key disimpan sebagai environment variable di Netlify (ANTHROPIC_API_KEY),
// TIDAK PERNAH dikirim ke browser.

export async function handler(event) {
  // Health check sederhana untuk fitur diagnostik di UI
  if (event.httpMethod === "GET") {
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY belum diatur di environment variables Netlify" }),
    };
  }

  try {
    const { prompt, maxTokens = 500, webSearch = false } = JSON.parse(event.body || "{}");
    if (!prompt) {
      return { statusCode: 400, body: JSON.stringify({ error: "prompt wajib diisi" }) };
    }

    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    };
    if (webSearch) {
      body.tools = [{ type: "web_search_20250305", name: "web_search" }];
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: data?.error?.message || "Anthropic API error" }) };
    }

    return { statusCode: 200, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || "Internal error" }) };
  }
}
