/**
 * The API the rest of the app talks to.
 *
 * Normal build: the HTTP client, unchanged. Static build: an in-page
 * implementation with no server. The choice is made here and nowhere else, so
 * no caller has to know which build it is running in.
 *
 * Both implementations are imported statically rather than chosen with a dynamic
 * `import()` + top-level await: importing the HTTP client only *defines*
 * functions, so there is no cost to loading it, and this keeps the module graph
 * free of top-level await.
 */

import * as httpApi from "./api-manager.js";
import * as staticApi from "./api-static.js";
import { STATIC_MODE } from "./runtime.js";

const impl = STATIC_MODE ? staticApi : httpApi;

export const onUnauthorized = (...args) => impl.onUnauthorized(...args);
export const setAuthToken = (...args) => impl.setAuthToken(...args);
export const getAuthToken = (...args) => impl.getAuthToken(...args);

export const getFormats = (...args) => impl.getFormats(...args);
export const newFont = (...args) => impl.newFont(...args);
export const parseFont = (...args) => impl.parseFont(...args);
export const buildFont = (...args) => impl.buildFont(...args);
export const runOperation = (...args) => impl.runOperation(...args);

export const listProjects = (...args) => impl.listProjects(...args);
export const createProject = (...args) => impl.createProject(...args);
export const getProject = (...args) => impl.getProject(...args);
export const updateProject = (...args) => impl.updateProject(...args);
export const deleteProject = (...args) => impl.deleteProject(...args);

export const getUnicodeBlocks = (...args) => impl.getUnicodeBlocks(...args);
export const getUnicodeChars = (...args) => impl.getUnicodeChars(...args);
export const searchUnicode = (...args) => impl.searchUnicode(...args);
export const lookupUnicode = (...args) => impl.lookupUnicode(...args);
