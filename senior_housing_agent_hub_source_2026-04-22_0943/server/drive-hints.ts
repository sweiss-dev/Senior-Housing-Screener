import crypto from "node:crypto";

export type HintLibraryEntry = {
  operatorName: string;
  classificationHints: string;
  updatedAt: string;
};

export type HintLibrary = Record<string, HintLibraryEntry>;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const DEFAULT_FILE_NAME = "rent-roll-classification-hints-library.json";

type DriveConfig = {
  clientEmail: string;
  privateKey: string;
  fileId: string;
  folderId: string;
  fileName: string;
};

export function driveHintsConfigured() {
  const config = driveConfig();
  return Boolean(config.clientEmail && config.privateKey && (config.fileId || config.folderId));
}

export function driveHintsConfigStatus() {
  const config = driveConfig();
  return {
    configured: driveHintsConfigured(),
    hasServiceAccountEmail: Boolean(config.clientEmail),
    hasPrivateKey: Boolean(config.privateKey),
    hasFileId: Boolean(config.fileId),
    hasFolderId: Boolean(config.folderId),
    fileName: config.fileName,
  };
}

export async function readDriveHintLibrary(): Promise<{ library: HintLibrary; fileId?: string }> {
  const config = driveConfig();
  assertConfigured(config);
  const token = await getAccessToken(config);
  const fileId = config.fileId || (await findOrCreateHintsFile(token, config));
  const response = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return { library: {}, fileId };
  if (!response.ok) throw new Error(`Google Drive read failed: ${response.status}`);
  const text = await response.text();
  if (!text.trim()) return { library: {}, fileId };
  const parsed = JSON.parse(text);
  return { library: normalizeLibrary(parsed.mappings ?? parsed), fileId };
}

export async function writeDriveHintLibrary(library: HintLibrary): Promise<{ fileId: string }> {
  const config = driveConfig();
  assertConfigured(config);
  const token = await getAccessToken(config);
  const fileId = config.fileId || (await findOrCreateHintsFile(token, config));
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    mappings: normalizeLibrary(library),
  };
  const response = await fetch(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload, null, 2),
  });
  if (!response.ok) throw new Error(`Google Drive write failed: ${response.status}`);
  return { fileId };
}

export function normalizeLibrary(input: unknown): HintLibrary {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const output: HintLibrary = {};
  for (const [name, rawEntry] of Object.entries(input as Record<string, unknown>)) {
    if (!name.trim()) continue;
    if (typeof rawEntry === "string") {
      if (rawEntry.trim()) {
        output[name.trim()] = {
          operatorName: name.trim(),
          classificationHints: rawEntry.trim(),
          updatedAt: new Date().toISOString(),
        };
      }
      continue;
    }
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as Partial<HintLibraryEntry>;
    const classificationHints = String(entry.classificationHints ?? "").trim();
    if (!classificationHints) continue;
    const operatorName = String(entry.operatorName ?? name).trim() || name.trim();
    output[operatorName] = {
      operatorName,
      classificationHints,
      updatedAt: String(entry.updatedAt ?? new Date().toISOString()),
    };
  }
  return output;
}

function driveConfig(): DriveConfig {
  return {
    clientEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? "",
    privateKey: normalizePrivateKey(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ?? ""),
    fileId: process.env.GOOGLE_DRIVE_HINTS_FILE_ID ?? "",
    folderId: process.env.GOOGLE_DRIVE_HINTS_FOLDER_ID ?? "",
    fileName: process.env.GOOGLE_DRIVE_HINTS_FILE_NAME ?? DEFAULT_FILE_NAME,
  };
}

function assertConfigured(config: DriveConfig) {
  if (!config.clientEmail || !config.privateKey || (!config.fileId && !config.folderId)) {
    throw new Error("Google Drive hints backend is not configured.");
  }
}

function normalizePrivateKey(value: string) {
  let key = value.trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  key = key.replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
  if (key.startsWith("{")) {
    try {
      const parsed = JSON.parse(key);
      if (parsed.private_key) key = String(parsed.private_key).replace(/\\n/g, "\n").trim();
    } catch {
      // Fall through to the raw key handling below.
    }
  }
  if (!key.includes("BEGIN PRIVATE KEY") && key.includes("PRIVATE KEY")) {
    key = key.replace(/.*?(-----BEGIN PRIVATE KEY-----)/s, "$1");
  }
  return key;
}

async function getAccessToken(config: DriveConfig) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(
    JSON.stringify({
      iss: config.clientEmail,
      scope: DRIVE_SCOPE,
      aud: TOKEN_URL,
      exp: now + 3600,
      iat: now,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(config.privateKey, "base64url");
  const assertion = `${unsigned}.${signature}`;
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.access_token) {
    throw new Error(`Google OAuth token request failed: ${response.status}`);
  }
  return String(payload.access_token);
}

async function findOrCreateHintsFile(token: string, config: DriveConfig) {
  if (!config.folderId) throw new Error("GOOGLE_DRIVE_HINTS_FOLDER_ID is required when GOOGLE_DRIVE_HINTS_FILE_ID is not set.");
  const query = [
    `name = '${escapeDriveQuery(config.fileName)}'`,
    `'${escapeDriveQuery(config.folderId)}' in parents`,
    "trashed = false",
  ].join(" and ");
  const listUrl = `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=1`;
  const listResponse = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!listResponse.ok) throw new Error(`Google Drive file lookup failed: ${listResponse.status}`);
  const listPayload = await listResponse.json();
  const existing = listPayload.files?.[0]?.id;
  if (existing) return String(existing);

  const metadata = {
    name: config.fileName,
    mimeType: "application/json",
    parents: [config.folderId],
  };
  const boundary = `hints_${Date.now()}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), mappings: {} }, null, 2),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const createResponse = await fetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const createPayload = await createResponse.json();
  if (!createResponse.ok || !createPayload.id) {
    throw new Error(`Google Drive file create failed: ${createResponse.status}`);
  }
  return String(createPayload.id);
}

function escapeDriveQuery(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function base64Url(value: string) {
  return Buffer.from(value).toString("base64url");
}
