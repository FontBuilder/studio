/**
 * Authentication widget: passwords, guest sessions and WebAuthn passkeys.
 *
 * Renders into the header, keeps the bearer token in api-manager, and pops the
 * sign-in dialog automatically when the API answers 401.
 */

import * as api from "./api.js";
import { STATIC_MODE } from "./runtime.js";

let config = {
  auth_enabled: false,
  registration_enabled: false,
  guest_login_enabled: false,
  require_auth: false,
  passkey_support: false,
};

let currentUser = null;
let dialog = null;
let signedInHandler = null;

/**
 * Register a callback invoked after a successful sign-in.
 *
 * Signing in unlocks the API, so the app uses this to reload everything that
 * was gated by auth (capabilities, project list, ...).
 */
export function onSignedIn(fn) {
  signedInHandler = fn;
}

// ---------------------------------------------------------------------------
// base64url <-> ArrayBuffer (WebAuthn transports binary, JSON does not)
// ---------------------------------------------------------------------------
function b64urlToBuffer(value) {
  const padded = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToB64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCreationOptions(options) {
  return {
    ...options,
    challenge: b64urlToBuffer(options.challenge),
    user: { ...options.user, id: b64urlToBuffer(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((c) => ({
      ...c,
      id: b64urlToBuffer(c.id),
    })),
  };
}

function decodeRequestOptions(options) {
  return {
    ...options,
    challenge: b64urlToBuffer(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((c) => ({
      ...c,
      id: b64urlToBuffer(c.id),
    })),
  };
}

function encodeAttestation(credential) {
  const response = credential.response;
  return {
    id: credential.id,
    rawId: bufferToB64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToB64url(response.clientDataJSON),
      attestationObject: bufferToB64url(response.attestationObject),
      transports: response.getTransports ? response.getTransports() : [],
    },
  };
}

function encodeAssertion(credential) {
  const response = credential.response;
  return {
    id: credential.id,
    rawId: bufferToB64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToB64url(response.clientDataJSON),
      authenticatorData: bufferToB64url(response.authenticatorData),
      signature: bufferToB64url(response.signature),
      userHandle: response.userHandle ? bufferToB64url(response.userHandle) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------
async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

function adopt(payload) {
  api.setAuthToken(payload.token);
  currentUser = payload.user || null;
  renderHeader();
  if (signedInHandler) {
    // Fire and forget - the handler belongs to the app, not the dialog.
    Promise.resolve(signedInHandler(currentUser)).catch(() => {});
  }
  return currentUser;
}

async function signIn(username, password) {
  return adopt(await post("/auth/login", { username, password }));
}

async function register(username, password, email) {
  return adopt(await post("/auth/register", { username, password, email }));
}

async function guest() {
  return adopt(await post("/auth/guest", {}));
}

async function signOut() {
  try {
    await post("/auth/logout", {});
  } catch {
    /* revoking is best-effort - drop the local session regardless */
  }
  api.setAuthToken(null);
  currentUser = null;
  renderHeader();
}

async function registerPasskey(username, email) {
  if (!window.PublicKeyCredential) throw new Error("This browser does not support passkeys");
  const start = await post("/auth/passkey/register/options", { username, email });
  const credential = await navigator.credentials.create({
    publicKey: decodeCreationOptions(start.options),
  });
  return adopt(
    await post("/auth/passkey/register/verify", {
      cid: start.cid,
      credential: encodeAttestation(credential),
    })
  );
}

async function signInWithPasskey() {
  if (!window.PublicKeyCredential) throw new Error("This browser does not support passkeys");
  const start = await post("/auth/passkey/login/options", {});
  const credential = await navigator.credentials.get({
    publicKey: decodeRequestOptions(start.options),
  });
  return adopt(
    await post("/auth/passkey/login/verify", {
      cid: start.cid,
      credential: encodeAssertion(credential),
    })
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------
function closeDialog() {
  if (dialog) {
    dialog.remove();
    dialog = null;
  }
}

function openDialog(mode = "login", message = "") {
  closeDialog();

  dialog = document.createElement("div");
  dialog.className = "modal-backdrop";
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog();
  });

  const panel = document.createElement("div");
  panel.className = "modal panel";

  const heading = document.createElement("h2");
  heading.textContent = mode === "register" ? "Create an account" : "Sign in";

  const status = document.createElement("p");
  status.className = "hint";
  status.textContent = message;
  status.hidden = !message;

  const form = document.createElement("form");
  const username = field("Username", "text", "username", true);
  const password = field("Password", "password", "current-password", true);
  const email = field("Email (optional)", "email", "email", false);
  email.wrapper.hidden = mode !== "register";

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "btn-primary full";
  submit.textContent = mode === "register" ? "Create account" : "Sign in";

  form.append(username.wrapper, password.wrapper, email.wrapper, submit);

  const actions = document.createElement("div");
  actions.className = "modal-actions";

  if (mode === "register" && config.passkey_support) {
    const passkeyBtn = document.createElement("button");
    passkeyBtn.type = "button";
    passkeyBtn.className = "btn-secondary";
    passkeyBtn.textContent = "Register with a passkey";
    passkeyBtn.addEventListener("click", async () => {
      try {
        await registerPasskey(username.input.value.trim(), email.input.value.trim());
        closeDialog();
      } catch (error) {
        status.hidden = false;
        status.textContent = error.message;
      }
    });
    actions.appendChild(passkeyBtn);
  }

  if (mode === "login" && config.passkey_support) {
    const passkeyBtn = document.createElement("button");
    passkeyBtn.type = "button";
    passkeyBtn.className = "btn-secondary";
    passkeyBtn.textContent = "Use a passkey";
    passkeyBtn.addEventListener("click", async () => {
      try {
        await signInWithPasskey();
        closeDialog();
      } catch (error) {
        status.hidden = false;
        status.textContent = error.message;
      }
    });
    actions.appendChild(passkeyBtn);
  }

  if (config.guest_login_enabled) {
    const guestBtn = document.createElement("button");
    guestBtn.type = "button";
    guestBtn.className = "btn-ghost";
    guestBtn.textContent = "Continue as guest";
    guestBtn.addEventListener("click", async () => {
      try {
        await guest();
        closeDialog();
      } catch (error) {
        status.hidden = false;
        status.textContent = error.message;
      }
    });
    actions.appendChild(guestBtn);
  }

  if (config.registration_enabled) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "btn-ghost";
    toggle.textContent = mode === "register" ? "I already have an account" : "Create an account";
    toggle.addEventListener("click", () => openDialog(mode === "register" ? "login" : "register"));
    actions.appendChild(toggle);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      if (mode === "register") {
        await register(username.input.value.trim(), password.input.value, email.input.value.trim());
      } else {
        await signIn(username.input.value.trim(), password.input.value);
      }
      closeDialog();
    } catch (error) {
      status.hidden = false;
      status.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });

  panel.append(heading, status, form, actions);
  dialog.appendChild(panel);
  document.body.appendChild(dialog);
  username.input.focus();
}

function field(labelText, type, autocomplete, required) {
  const wrapper = document.createElement("label");
  wrapper.textContent = labelText;
  const input = document.createElement("input");
  input.type = type;
  input.autocomplete = autocomplete;
  input.required = required;
  wrapper.appendChild(input);
  return { wrapper, input };
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
function renderHeader() {
  const host = document.getElementById("authHeader");
  if (!host) return;
  host.textContent = "";

  if (!config.auth_enabled) {
    const note = document.createElement("span");
    note.className = "hint";
    note.textContent = "single user";
    note.title = "Authentication is disabled (ALLOW_AUTH=false)";
    host.appendChild(note);
    return;
  }

  if (currentUser) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = currentUser.username
      + (currentUser.is_guest ? " (guest)" : currentUser.role === "admin" ? " (admin)" : "");
    const out = document.createElement("button");
    out.type = "button";
    out.className = "btn-ghost";
    out.textContent = "Sign out";
    out.addEventListener("click", signOut);
    host.append(badge, out);
    return;
  }

  const signInBtn = document.createElement("button");
  signInBtn.type = "button";
  signInBtn.className = "btn-secondary";
  signInBtn.textContent = "Sign in";
  signInBtn.addEventListener("click", () => openDialog("login"));
  host.appendChild(signInBtn);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
/**
 * Load the auth configuration, restore any saved session and render the widget.
 * @returns {Promise<object|null>} the current user, or null
 */
export async function initAuth() {
  // A static site has no accounts, so there is nothing to configure and no
  // session to restore - and no reason to fire a request at /auth/config.
  if (STATIC_MODE) {
    renderHeader();
    return null;
  }

  try {
    const response = await fetch("/auth/config");
    if (response.ok) config = await response.json();
  } catch {
    /* auth config is best-effort; assume disabled */
  }

  // The API client tells us when the session is missing or has expired.
  api.onUnauthorized(() => {
    currentUser = null;
    api.setAuthToken(null);
    renderHeader();
    if (config.auth_enabled && !dialog) {
      openDialog("login", "Please sign in to continue.");
    }
  });

  if (config.auth_enabled && api.getAuthToken()) {
    try {
      const response = await fetch("/auth/me", {
        headers: { Authorization: `Bearer ${api.getAuthToken()}` },
      });
      if (response.ok) {
        const payload = await response.json();
        currentUser = payload.user || null;
      } else {
        api.setAuthToken(null);
      }
    } catch {
      /* keep the token; a later 401 will clear it */
    }
  }

  renderHeader();

  // Gate the UI up front when the whole app requires a session.
  if (config.require_auth && !currentUser) {
    openDialog("login", "This instance requires an account.");
  }

  return currentUser;
}

export function getUser() {
  return currentUser;
}

export function authConfig() {
  return config;
}
