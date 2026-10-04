import http from "http";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import open from "open";

const CLIENT_ID = process.env.TICKTICK_CLIENT_ID;
const CLIENT_SECRET = process.env.TICKTICK_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:8080/callback";
const TOKEN_FILE = ".ticktick-token.json";
const SCOPE = "tasks:read";

// ---- Token persistence ----

async function saveToken(token) {
  await fs.writeFile(TOKEN_FILE, JSON.stringify(token, null, 2));
}

async function loadToken() {
  try {
    const raw = await fs.readFile(TOKEN_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isExpired(token) {
  // expires_at is a timestamp we store ourselves (see exchangeCode)
  return Date.now() >= token.expires_at - 60_000; // 1 min buffer
}

// ---- OAuth flow ----

function buildAuthUrl() {
  const state = Math.random().toString(36).slice(2);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
  });
  return { url: `https://ticktick.com/oauth/authorize?${params}`, state };
}

async function exchangeCode(code) {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

  const response = await fetch("https://ticktick.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  const token = await response.json();
  token.expires_at = Date.now() + token.expires_in * 1000;
  return token;
}

async function refreshToken(token) {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

  const response = await fetch("https://ticktick.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Token refresh failed: ${err}`);
  }

  const newToken = await response.json();
  newToken.expires_at = Date.now() + newToken.expires_in * 1000;
  // Some providers don't return a new refresh token, so keep the old one
  newToken.refresh_token = newToken.refresh_token ?? token.refresh_token;
  return newToken;
}

// Opens a local server, waits for the OAuth callback, returns the code
function waitForCallback(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:8080`);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (url.pathname !== "/callback" || !code) {
        res.writeHead(400);
        res.end("Missing code");
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400);
        res.end("State mismatch — possible CSRF attack");
        reject(new Error("State mismatch"));
        server.close();
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h2>✅ Authorised! You can close this tab and return to your terminal.</h2>");
      server.close();
      resolve(code);
    });

    server.listen(8080, () => {
      console.log("Waiting for OAuth callback on http://localhost:8080/callback ...");
    });

    server.on("error", reject);
  });
}

// Full interactive login (only needed when no token exists or refresh fails)
async function login() {
  console.log("\n🔐 No valid token found. Starting TickTick login...");
  const { url, state } = buildAuthUrl();

  console.log("\nOpening browser. If it doesn't open, visit this URL manually:\n");
  console.log(url + "\n");

  try {
    await open(url);
  } catch {
    // 'open' package may not be installed — user can visit manually
  }

  const code = await waitForCallback(state);
  const token = await exchangeCode(code);
  await saveToken(token);
  console.log("✅ Login successful. Token saved to", TOKEN_FILE);
  return token;
}

// ---- Main export ----

/**
 * Returns a valid access token, refreshing or re-authenticating as needed.
 * Call this before every API request.
 */
export async function getAccessToken() {
  let token = await loadToken();

  if (!token) {
    token = await login();
    return token.access_token;
  }

  if (isExpired(token)) {
    console.log("🔄 Access token expired, refreshing...");
    try {
      token = await refreshToken(token);
      await saveToken(token);
      console.log("✅ Token refreshed.");
    } catch (err) {
      console.warn("⚠️  Refresh failed, re-authenticating...", err.message);
      token = await login();
    }
  }

  return token.access_token;
}

/**
 * Convenience wrapper: makes an authenticated request to the TickTick API.
 * @param {string} path  - e.g. "/open/v1/project"
 * @param {RequestInit} options - standard fetch options
 */
export async function ticktickFetch(path, options = {}) {
  const accessToken = await getAccessToken();
  const response = await fetch(`https://api.ticktick.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`TickTick API error ${response.status}: ${await response.text()}`);
  }

  return response.json();
}