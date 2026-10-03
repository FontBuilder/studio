/**
 * Build-time switches.
 *
 * The static (GitHub Pages) build inserts `<meta name="fbs-mode" content="static">`
 * into the page head. Everything server-shaped - the API client, auth, projects,
 * export, cleanup operations - keys off this one flag, so there is a single place
 * to look when asking "is this build talking to a server?".
 *
 * A meta tag rather than an inline script on purpose: the build runs under
 * `script-src 'self'`, which blocks inline scripts. Modules are deferred, so the
 * head is parsed by the time this runs.
 */

/* global document */

function detectStatic() {
  if (typeof document === "undefined") return false;
  const meta = document.querySelector('meta[name="fbs-mode"]');
  return Boolean(meta && meta.content === "static");
}

export const STATIC_MODE = detectStatic();

/** Human-readable summary of what a static build cannot do, for the UI. */
export const STATIC_NOTES = STATIC_MODE
  ? {
      exportDisabled:
        "Browser build: reading and editing work, but writing a font file needs the server build.",
      operationsDisabled: "Cleanup operations run inside FontForge, so they need the server build.",
      projectsDisabled: "Projects are stored by the server; this build keeps everything in the page.",
      exportHint:
        "Browser build: export downloads an installable .ttf, or a .json project file you can import back later.",
      dataLoss:
        "Refreshing, closing the tab or navigating away erases your font. Export it as a .json project file to keep a copy. If you want more Export Options, you should host the server to utilize it's features.",
    }
  : {
      exportDisabled: "",
      operationsDisabled: "",
      projectsDisabled: "",
      exportHint: "",
      dataLoss: "",
    };
