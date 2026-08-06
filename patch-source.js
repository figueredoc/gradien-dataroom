const fs = require("fs");

const middlewarePath = "middleware.ts";
let middleware = fs.readFileSync(middlewarePath, "utf8");
middleware = middleware.replace(
`function isCustomDomain(host: string) {
  return (
    (process.env.NODE_ENV === "development" &&
      (host?.includes(".local") || host?.includes("papermark.dev"))) ||
    (process.env.NODE_ENV !== "development" &&
      !(
        host?.includes("localhost") ||
        host?.includes("papermark.io") ||
        host?.includes("papermark.com") ||
        host?.endsWith(".vercel.app") || host?.endsWith(".railway.app")
      ))
  );
}`,
`function isCustomDomain(host: string) {
  const normalizedHost = host?.split(":")[0];
  const appHost = process.env.NEXT_PUBLIC_APP_BASE_HOST?.split(":")[0];
  const webhookHost = process.env.NEXT_PUBLIC_WEBHOOK_BASE_HOST?.split(":")[0];

  return (
    (process.env.NODE_ENV === "development" &&
      (normalizedHost?.includes(".local") ||
        normalizedHost?.includes("papermark.dev"))) ||
    (process.env.NODE_ENV !== "development" &&
      !(
        normalizedHost?.includes("localhost") ||
        normalizedHost?.includes("papermark.io") ||
        normalizedHost?.includes("papermark.com") ||
        normalizedHost?.endsWith(".vercel.app") ||
        normalizedHost?.endsWith(".railway.app") ||
        normalizedHost === appHost ||
        normalizedHost === webhookHost ||
        normalizedHost === "gradien-dataroom.up.railway.app" ||
        normalizedHost === "dataroom.gradien.ai"
      ))
  );
}`
);
middleware = middleware.replace(
`  // Handle incoming webhooks
  if (isWebhookPath(host)) {
    return IncomingWebhookMiddleware(req);
  }`,
`  // Handle incoming webhooks only on the webhook service path.
  if (isWebhookPath(host) && path.startsWith("/services/")) {
    return IncomingWebhookMiddleware(req);
  }`
);
middleware = middleware.replace(
`  // For custom domains, we need to handle them differently
  if (isCustomDomain(host || "")) {
    return DomainMiddleware(req);
  }

  // Handle standard papermark.io paths`,
`  const isAppPath =
    path === "/login" ||
    path === "/register" ||
    path === "/dashboard" ||
    path === "/branding" ||
    path === "/welcome" ||
    path === "/account" ||
    path === "/unsubscribe" ||
    path.startsWith("/auth/") ||
    path.startsWith("/verify") ||
    path.startsWith("/settings") ||
    path.startsWith("/documents") ||
    path.startsWith("/datarooms") ||
    path.startsWith("/links") ||
    path.startsWith("/people") ||
    path.startsWith("/teams") ||
    path.startsWith("/conversations");

  // For custom viewer domains, route only public viewer paths through domain middleware.
  if (isCustomDomain(host || "") && !isAppPath) {
    return DomainMiddleware(req);
  }

  if (isCustomDomain(host || "") && isAppPath) {
    const canonicalAppUrl =
      process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_BASE_URL;
    const canonicalHost = canonicalAppUrl
      ? new URL(canonicalAppUrl).host
      : null;

    if (canonicalAppUrl && host !== canonicalHost) {
      const url = req.nextUrl.clone();
      url.protocol = new URL(canonicalAppUrl).protocol;
      url.host = canonicalHost!;
      return NextResponse.redirect(url);
    }
  }

  // Handle standard app paths`
);
fs.writeFileSync(middlewarePath, middleware);

fs.writeFileSync("pages/api/file/image-upload-server.ts", `
import type { NextApiRequest, NextApiResponse } from "next";

import { put } from "@vercel/blob";
import { getServerSession } from "next-auth/next";

import { authOptions } from "../auth/[...nextauth]";

export const config = {
  api: {
    bodyParser: false,
  },
};

async function readBody(req: NextApiRequest) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const filename =
    typeof req.query.filename === "string" && req.query.filename
      ? req.query.filename
      : "logo.png";

  try {
    const body = await readBody(req);
    const blob = await put(filename, body, {
      access: "public",
      addRandomSuffix: true,
      token:
        process.env.NEXT_PRIVATE_BRANDING_BLOB_READ_WRITE_TOKEN ||
        process.env.BLOB_READ_WRITE_TOKEN,
    });

    return res.status(200).json({ url: blob.url });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Upload failed" });
  }
}
`);

fs.writeFileSync("pages/api/brand-image.ts", `
import type { NextApiRequest, NextApiResponse } from "next";

const isAllowedBrandImageHost = (host: string) =>
  host.endsWith(".blob.vercel-storage.com");

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawUrl = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  if (!rawUrl) {
    return res.status(400).json({ error: "Missing image URL" });
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return res.status(400).json({ error: "Invalid image URL" });
  }

  if (url.protocol !== "https:" || !isAllowedBrandImageHost(url.hostname)) {
    return res.status(400).json({ error: "Unsupported image URL" });
  }

  const token =
    process.env.NEXT_PRIVATE_BRANDING_BLOB_READ_WRITE_TOKEN ||
    process.env.BLOB_READ_WRITE_TOKEN;

  let response = await fetch(url.toString());
  if (!response.ok && token && [401, 403].includes(response.status)) {
    response = await fetch(url.toString(), {
      headers: { Authorization: \`Bearer \${token}\` },
    });
  }

  if (!response.ok) {
    return res.status(response.status).json({ error: "Image not found" });
  }

  const contentType = response.headers.get("content-type") || "image/png";
  const body = Buffer.from(await response.arrayBuffer());

  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400");
  return res.status(200).send(body);
}
`);

const utilsPath = "lib/utils.ts";
let utils = fs.readFileSync(utilsPath, "utf8");
utils = utils.replace(
`export const uploadImage = async (
  file: File,
  uploadType: "profile" | "assets" = "assets",
) => {
  const newBlob = await upload(file.name, file, {
    access: "public",
    handleUploadUrl: \`/api/file/image-upload?type=\${uploadType}\`,
  });

  return newBlob.url;
};`,
`export const uploadImage = async (
  file: File,
  uploadType: "profile" | "assets" = "assets",
) => {
  const response = await fetch(
    \`/api/file/image-upload-server?type=\${uploadType}&filename=\${encodeURIComponent(file.name)}\`,
    {
      method: "POST",
      headers: {
        "content-type": file.type,
      },
      body: file,
    },
  );

  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error || "Failed to upload image");
  }

  const blob = await response.json();
  return blob.url;
};`
);

const putFilePath = "lib/files/put-file.ts";
let putFile = fs.readFileSync(putFilePath, "utf8");
putFile = putFile.replaceAll(
  "${process.env.NEXT_PUBLIC_BASE_URL}/api/file/s3/",
  "/api/file/s3/",
);

for (const filePath of [
  "lib/files/tus-upload.ts",
  "lib/files/viewer-tus-upload.ts",
]) {
  if (!fs.existsSync(filePath)) continue;
  let file = fs.readFileSync(filePath, "utf8");
  file = file
    .replaceAll("${process.env.NEXT_PUBLIC_BASE_URL}/api/file/s3/", "/api/file/s3/")
    .replaceAll("${process.env.NEXT_PUBLIC_BASE_URL}/api/file/tus-viewer", "/api/file/tus-viewer")
    .replaceAll("${process.env.NEXT_PUBLIC_BASE_URL}/api/file/tus", "/api/file/tus");
  fs.writeFileSync(filePath, file);
}

const getFilePath = "lib/files/get-file.ts";
let getFile = fs.readFileSync(getFilePath, "utf8");
getFile = getFile.replace(
  "`${process.env.NEXT_PUBLIC_BASE_URL}/api/file/s3/get-presigned-get-url`,",
  "`${process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_BASE_URL}/api/file/s3/get-presigned-get-url`,",
);
fs.writeFileSync(getFilePath, getFile);

const triggerStatusPath = "lib/utils/generate-trigger-status.ts";
fs.writeFileSync(triggerStatusPath, `import { z } from "zod";

const ZDocumentProgressStatus = z.object({
  progress: z.number(),
  text: z.string(),
});

type TDocumentProgressStatus = z.infer<typeof ZDocumentProgressStatus>;

const ZDocumentProgressMetadata = z.object({
  status: ZDocumentProgressStatus,
});

export function updateStatus(_status: TDocumentProgressStatus) {}

export function parseStatus(data: unknown): TDocumentProgressStatus {
  return ZDocumentProgressMetadata.parse(data).status;
}
`);

const pdfRoutePath = "lib/trigger/pdf-to-image-route.ts";
let pdfRoute = fs.readFileSync(pdfRoutePath, "utf8");
pdfRoute = pdfRoute.replace(
`import { logger, task } from "@trigger.dev/sdk/v3";

import { getFile } from "@/lib/files/get-file";`,
`import * as mupdf from "mupdf";

const logger = { info: console.log, warn: console.warn, error: console.error };

import { getFile } from "@/lib/files/get-file";
import { putFileServer } from "@/lib/files/put-file-server";`,
);
pdfRoute = pdfRoute.replace(
`type ConvertPdfToImagePayload = {
  documentId: string;
  documentVersionId: string;
  teamId: string;
  versionNumber?: number;
};`,
`type ConvertPdfToImagePayload = {
  documentId: string;
  documentVersionId: string;
  teamId: string;
  versionNumber?: number;
};

async function getPdfData(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Failed to fetch PDF");
  }
  return response.arrayBuffer();
}

function getPdfPages(pdfData: ArrayBuffer) {
  const doc = new mupdf.PDFDocument(pdfData);
  return doc.countPages();
}

async function convertPdfPage({
  documentVersionId,
  pageNumber,
  url,
  teamId,
}: {
  documentVersionId: string;
  pageNumber: number;
  url: string;
  teamId: string;
}) {
  const pdfData = await getPdfData(url);
  const doc = new mupdf.PDFDocument(pdfData);
  const page = doc.loadPage(pageNumber - 1);
  const bounds = page.getBounds();
  const [ulx, uly, lrx, lry] = bounds;
  const widthInPoints = Math.abs(lrx - ulx);
  const heightInPoints = Math.abs(lry - uly);

  if (pageNumber === 1) {
    await prisma.documentVersion.update({
      where: { id: documentVersionId },
      data: { isVertical: heightInPoints > widthInPoints },
    });
  }

  const scaleFactor = widthInPoints >= 1600 ? 2 : 3;
  const docToScreen = mupdf.Matrix.scale(scaleFactor, scaleFactor);
  const links = page.getLinks();
  const embeddedLinks = links.map((link) => {
    return { href: link.getURI(), coords: link.getBounds().join(",") };
  });
  const metadata = {
    originalWidth: widthInPoints,
    originalHeight: heightInPoints,
    width: widthInPoints * scaleFactor,
    height: heightInPoints * scaleFactor,
    scaleFactor,
  };

  const scaledPixmap = page.toPixmap(
    docToScreen,
    mupdf.ColorSpace.DeviceRGB,
    false,
    true,
  );
  const pngBuffer = scaledPixmap.asPNG();
  const jpegBuffer = scaledPixmap.asJPEG(80, false);
  const chosenFormat = pngBuffer.byteLength < jpegBuffer.byteLength ? "png" : "jpeg";
  const chosenBuffer = chosenFormat === "png" ? pngBuffer : jpegBuffer;
  const match = url.match(/(doc_[^/]+)\\//);
  const docId = match ? match[1] : undefined;

  const { type, data } = await putFileServer({
    file: {
      name: "page-" + pageNumber + "." + chosenFormat,
      type: "image/" + chosenFormat,
      buffer: Buffer.from(chosenBuffer),
    },
    teamId,
    docId,
  });

  scaledPixmap.destroy();
  page.destroy();

  if (!data || !type) {
    throw new Error("Failed to upload document page " + pageNumber);
  }

  const existingPage = await prisma.documentPage.findUnique({
    where: {
      pageNumber_versionId: {
        pageNumber,
        versionId: documentVersionId,
      },
    },
  });

  if (existingPage) {
    return existingPage.id;
  }

  const documentPage = await prisma.documentPage.create({
    data: {
      versionId: documentVersionId,
      pageNumber,
      file: data,
      storageType: type,
      pageLinks: embeddedLinks,
      metadata,
    },
  });

  return documentPage.id;
}`,
);
pdfRoute = pdfRoute.replace(
  `export const convertPdfToImageRoute = task({
  id: "convert-pdf-to-image-route",
  run: async (payload: ConvertPdfToImagePayload) => {`,
  `export const convertPdfToImage = async (payload: ConvertPdfToImagePayload) => {`,
);
pdfRoute = pdfRoute.replace(
  /\n  },\n}\);\s*$/,
  `\n};\n\nexport const convertPdfToImageRoute = {\n  trigger: async (payload: ConvertPdfToImagePayload) => convertPdfToImage(payload),\n};\n`,
);
fs.writeFileSync(pdfRoutePath, pdfRoute);

pdfRoute = fs.readFileSync(pdfRoutePath, "utf8");
pdfRoute = pdfRoute.replace(
`      // 3. send file to api/convert endpoint in a task and get back number of pages
      logger.info("Sending file to api/get-pages endpoint");

      const response = await fetch(
        \`\${process.env.NEXT_PUBLIC_BASE_URL}/api/mupdf/get-pages\`,
        {
          method: "POST",
          body: JSON.stringify({ url: signedUrl }),
          headers: {
            "Content-Type": "application/json",
            Authorization: \`Bearer \${process.env.INTERNAL_API_KEY}\`,
          },
        },
      );

      if (!response.ok) {
        logger.error("Failed to get number of pages", {
          signedUrl,
          response,
        });
        throw new Error("Failed to get number of pages");
      }

      const { numPages: numPagesResult } = (await response.json()) as {
        numPages: number;
      };
`,
`      logger.info("Counting PDF pages inline");

      const pdfData = await getPdfData(signedUrl);
      const numPagesResult = getPdfPages(pdfData);
`,
);
pdfRoute = pdfRoute.replace(
`        // send page number to api/convert-page endpoint in a task and get back page img url
        const response = await fetch(
          \`\${process.env.NEXT_PUBLIC_BASE_URL}/api/mupdf/convert-page\`,
          {
            method: "POST",
            body: JSON.stringify({
              documentVersionId: documentVersionId,
              pageNumber: currentPage,
              url: signedUrl,
              teamId: teamId,
            }),
            headers: {
              "Content-Type": "application/json",
              Authorization: \`Bearer \${process.env.INTERNAL_API_KEY}\`,
            },
          },
        );

        if (!response.ok) {
          throw new Error("Failed to convert page");
        }

        const { documentPageId } = (await response.json()) as {
          documentPageId: string;
        };
`,
`        const documentPageId = await convertPdfPage({
          documentVersionId: documentVersionId,
          pageNumber: currentPage,
          url: signedUrl,
          teamId: teamId,
        });
`,
);
fs.writeFileSync(pdfRoutePath, pdfRoute);

function inlinePdfTrigger(filePath) {
  if (!fs.existsSync(filePath)) return;
  let file = fs.readFileSync(filePath, "utf8");
  file = file.replace(
    'import { convertPdfToImageRoute } from "@/lib/trigger/pdf-to-image-route";',
    'import { convertPdfToImage } from "@/lib/trigger/pdf-to-image-route";',
  );
  file = file.replace(
    /await convertPdfToImageRoute\.trigger\(\s*(\{[\s\S]*?\})\s*,\s*\{[\s\S]*?concurrencyKey: teamId,\s*\},\s*\);/g,
    "await convertPdfToImage($1);",
  );
  fs.writeFileSync(filePath, file);
}

inlinePdfTrigger("lib/api/documents/process-document.ts");
inlinePdfTrigger("pages/api/teams/[teamId]/documents/[id]/versions/index.ts");
inlinePdfTrigger("pages/api/teams/[teamId]/documents/agreement.ts");

function disableDocumentWorkerImports(filePath) {
  if (!fs.existsSync(filePath)) return;
  let file = fs.readFileSync(filePath, "utf8");
  file = file
    .replace(
      'import { convertCadToPdfTask } from "@/lib/trigger/convert-files";',
      'const convertCadToPdfTask = { trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }) };',
    )
    .replace(
      'import { convertFilesToPdfTask } from "@/lib/trigger/convert-files";',
      'const convertFilesToPdfTask = { trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }) };',
    )
    .replace(
      'import { processVideo } from "@/lib/trigger/optimize-video-files";',
      'const processVideo = { trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }) };',
    );
  fs.writeFileSync(filePath, file);
}

for (const filePath of [
  "lib/api/documents/process-document.ts",
  "pages/api/teams/[teamId]/documents/[id]/versions/index.ts",
  "pages/api/teams/[teamId]/documents/agreement.ts",
]) {
  disableDocumentWorkerImports(filePath);
}

function replaceInFile(filePath, replacements) {
  if (!fs.existsSync(filePath)) return;
  let file = fs.readFileSync(filePath, "utf8");
  for (const [search, replacement] of replacements) {
    file = file.replace(search, replacement);
  }
  fs.writeFileSync(filePath, file);
}

function replaceAllInFile(filePath, replacements) {
  if (!fs.existsSync(filePath)) return;
  let file = fs.readFileSync(filePath, "utf8");
  for (const [search, replacement] of replacements) {
    file = file.replaceAll(search, replacement);
  }
  fs.writeFileSync(filePath, file);
}

fs.writeFileSync(
  "pages/api/progress-token.ts",
  `import { NextApiRequest, NextApiResponse } from "next";

export default async function handle(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  return res.status(200).json({ publicAccessToken: "" });
}
`,
);

fs.writeFileSync(
  "lib/utils/use-progress-status.ts",
  `"use client";

type RunStatus =
  | "QUEUED"
  | "EXECUTING"
  | "COMPLETED"
  | "FAILED"
  | "CRASHED"
  | "CANCELED"
  | "SYSTEM_FAILURE";

interface IDocumentProgressStatus {
  state: RunStatus;
  progress: number;
  text: string;
}

export function useDocumentProgressStatus(
  _documentVersionId: string,
  _publicAccessToken: string | undefined,
) {
  const status: IDocumentProgressStatus = {
    state: "COMPLETED",
    progress: 100,
    text: "Processing complete",
  };

  return { status, error: undefined as Error | undefined, run: undefined };
}
`,
);

for (const filePath of [
  "components/documents/document-preview-button.tsx",
  "components/links/links-table.tsx",
]) {
  replaceAllInFile(filePath, [
    ['["pdf", "slides", "docs", "cad"]', '["pdf"]'],
  ]);
}

replaceInFile("lib/api/documents/process-document.ts", [
  ['if (type === "docs" || type === "slides") {', 'if (false && (type === "docs" || type === "slides")) {'],
  ['if (type === "cad") {', 'if (false && type === "cad") {'],
  ['if (type === "video" && contentType !== "video/mp4") {', 'if (false && type === "video" && contentType !== "video/mp4") {'],
]);

replaceInFile("pages/api/teams/[teamId]/documents/[id]/versions/index.ts", [
  ['if (type === "docs" || type === "slides") {', 'if (false && (type === "docs" || type === "slides")) {'],
  ['if (type === "video" && contentType !== "video/mp4") {', 'if (false && type === "video" && contentType !== "video/mp4") {'],
]);

replaceInFile("pages/api/teams/[teamId]/documents/agreement.ts", [
  ['if (type === "docs") {', 'if (false && type === "docs") {'],
]);

const exportVisitsPath = "lib/trigger/export-visits.ts";
let exportVisits = fs.readFileSync(exportVisitsPath, "utf8");
exportVisits = exportVisits.replace(
  'import { logger, task } from "@trigger.dev/sdk/v3";',
  'const logger = { info: console.log, warn: console.warn, error: console.error };',
);
exportVisits = exportVisits.replace(
`export const exportVisitsTask = task({
  id: "export-visits",
  retry: { maxAttempts: 3 },
  maxDuration: 900, // 15 minutes to handle large datasets
  run: async (payload: ExportVisitsPayload) => {`,
`export const runExportVisits = async (payload: ExportVisitsPayload) => {`,
);
exportVisits = exportVisits.replace(
`
  },
});

async function exportDocumentVisits`,
`
};

export const exportVisitsTask = {
  trigger: async (payload: ExportVisitsPayload) => runExportVisits(payload),
};

async function exportDocumentVisits`,
);
fs.writeFileSync(exportVisitsPath, exportVisits);

function inlineExportVisits(filePath) {
  if (!fs.existsSync(filePath)) return;
  let file = fs.readFileSync(filePath, "utf8");
  file = file.replace(
    'import { exportVisitsTask } from "@/lib/trigger/export-visits";',
    'import { runExportVisits } from "@/lib/trigger/export-visits";',
  );
  file = file.replace(
    /\/\/ Trigger the background task\s*const handle = await exportVisitsTask\.trigger\(\s*(\{[\s\S]*?\})\s*,\s*\{[\s\S]*?\}\s*,?\s*\);\s*\/\/ Update the job with the trigger run ID for cancellation\s*const updatedJob = await jobStore\.updateJob\(exportJob\.id,\s*\{\s*triggerRunId: handle\.id,\s*\}\s*\);/g,
    "await runExportVisits($1);\n\n    const updatedJob = await jobStore.getJob(exportJob.id);",
  );
  fs.writeFileSync(filePath, file);
}

for (const filePath of [
  "pages/api/teams/[teamId]/export-jobs.ts",
  "pages/api/teams/[teamId]/documents/[id]/export-visits.ts",
  "pages/api/teams/[teamId]/datarooms/[id]/export-visits.ts",
  "pages/api/teams/[teamId]/datarooms/[id]/groups/[groupId]/export-visits.ts",
]) {
  inlineExportVisits(filePath);
}

function disableTriggerRuns(filePath) {
  replaceInFile(filePath, [
    [
      'import { runs } from "@trigger.dev/sdk/v3";',
      'const runs = { list: async (..._args: unknown[]): Promise<{ data: Array<{ id: string }> }> => ({ data: [] }), cancel: async (_id: string) => undefined };',
    ],
  ]);
}

for (const filePath of [
  "pages/api/teams/[teamId]/datarooms/[id]/documents/index.ts",
  "pages/api/teams/[teamId]/export-jobs/[exportId].ts",
  "ee/features/billing/cancellation/api/unpause-route.ts",
  "ee/features/conversations/api/conversations-route.ts",
  "ee/features/conversations/api/team-conversations-route.ts",
]) {
  disableTriggerRuns(filePath);
}

replaceInFile("pages/api/teams/[teamId]/datarooms/[id]/documents/index.ts", [
  [
    'import { sendDataroomChangeNotificationTask } from "@/lib/trigger/dataroom-change-notification";',
    'const sendDataroomChangeNotificationTask = { trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }) };',
  ],
]);

replaceInFile("pages/api/teams/[teamId]/datarooms/trial.ts", [
  [
    'import {\n  sendDataroomTrialExpiredEmailTask,\n  sendDataroomTrialInfoEmailTask,\n} from "@/lib/trigger/send-scheduled-email";',
    'const sendDataroomTrialExpiredEmailTask = { trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }) };\nconst sendDataroomTrialInfoEmailTask = { trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }) };',
  ],
]);

replaceInFile("ee/features/billing/cancellation/api/pause-route.ts", [
  [
    'import { sendPauseResumeNotificationTask } from "../lib/trigger/pause-resume-notification";',
    'const sendPauseResumeNotificationTask = { trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }) };',
  ],
  [
    'import { sendPauseResumeNotificationTask } from "@/ee/features/billing/cancellation/lib/trigger/pause-resume-notification";',
    'const sendPauseResumeNotificationTask = { trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }) };',
  ],
]);

for (const filePath of [
  "ee/features/conversations/api/conversations-route.ts",
  "ee/features/conversations/api/team-conversations-route.ts",
]) {
  replaceInFile(filePath, [
    [
      'import { sendConversationTeamMemberNotificationTask } from "../lib/trigger/conversation-message-notification";',
      'const sendConversationTeamMemberNotificationTask = { trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }) };',
    ],
    [
      'import { sendConversationMessageNotificationTask } from "../lib/trigger/conversation-message-notification";',
      'const sendConversationMessageNotificationTask = { trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }) };',
    ],
    [
      'import { sendConversationMessageNotificationTask } from "@/lib/trigger/conversation-message-notification";',
      'const sendConversationMessageNotificationTask = { trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }) };',
    ],
  ]);
}

replaceInFile("pages/api/teams/[teamId]/datarooms/[id]/documents/index.ts", [
  ["if (document.dataroom.enableChangeNotifications) {", "if (false && document.dataroom.enableChangeNotifications) {"],
]);

replaceInFile("pages/api/teams/[teamId]/datarooms/trial.ts", [
  ["waitUntil(\n        sendDataroomTrialInfoEmailTask.trigger(", "if (false) waitUntil(\n        sendDataroomTrialInfoEmailTask.trigger("],
  ["waitUntil(\n        sendDataroomTrialExpiredEmailTask.trigger(", "if (false) waitUntil(\n        sendDataroomTrialExpiredEmailTask.trigger("],
]);

replaceInFile("ee/features/billing/cancellation/api/pause-route.ts", [
  ["sendPauseResumeNotificationTask.trigger(", "false && sendPauseResumeNotificationTask.trigger("],
]);

for (const filePath of [
  "ee/features/conversations/api/conversations-route.ts",
  "ee/features/conversations/api/team-conversations-route.ts",
]) {
  replaceAllInFile(filePath, [
    ["waitUntil(\n      sendConversationTeamMemberNotificationTask.trigger(", "if (false) waitUntil(\n      sendConversationTeamMemberNotificationTask.trigger("],
    ["waitUntil(\n        sendConversationMessageNotificationTask.trigger(", "if (false) waitUntil(\n        sendConversationMessageNotificationTask.trigger("],
  ]);
}

// Fix TS type error: `team` is typed as T | null but accessed without a null check.
// The trigger blocks are already guarded by `if (false)` so this is safe at runtime;
// the non-null assertion just satisfies the type checker.
replaceAllInFile("ee/features/conversations/api/conversations-route.ts", [
  ["teamId: team.id,", "teamId: team!.id,"],
  ["${team.id}", "${team!.id}"],
]);
replaceAllInFile("ee/features/conversations/api/team-conversations-route.ts", [
  ["teamId: team.id,", "teamId: team!.id,"],
  ["${team.id}", "${team!.id}"],
]);

fs.writeFileSync("trigger.config.ts", `
export default {};
`);

fs.writeFileSync("lib/utils/generate-trigger-auth-token.ts", `
export const generateTriggerAuthToken = async () => "";
`);

fs.writeFileSync("lib/trigger/convert-files.ts", `
export const convertFilesToPdfTask = {
  trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }),
};

export const convertCadToPdfTask = {
  trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }),
};
`);

fs.writeFileSync("lib/trigger/optimize-video-files.ts", `
export const processVideo = {
  trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }),
};
`);

fs.writeFileSync("lib/trigger/dataroom-change-notification.ts", `
export const sendDataroomChangeNotificationTask = {
  trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }),
};
`);

fs.writeFileSync("lib/trigger/send-scheduled-email.ts", `
export const sendDataroomTrialInfoEmailTask = {
  trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }),
};

export const sendDataroomTrialExpiredEmailTask = {
  trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }),
};
`);

fs.writeFileSync("lib/trigger/cleanup-expired-exports.ts", `
export const cleanupExpiredExports = {
  trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }),
};
`);

fs.writeFileSync("ee/features/billing/cancellation/lib/trigger/pause-resume-notification.ts", `
export const sendPauseResumeNotificationTask = {
  trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }),
};
`);

fs.writeFileSync("ee/features/conversations/lib/trigger/conversation-message-notification.ts", `
export const sendConversationMessageNotificationTask = {
  trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }),
};

export const sendConversationTeamMemberNotificationTask = {
  trigger: async (..._args: unknown[]) => ({ id: "trigger-disabled" }),
};
`);

replaceInFile("components/view/nav.tsx", [
  [
    `import ReportForm from "./report-form";`,
    `import ReportForm from "./report-form";

const getBrandLogoSrc = (logo?: string | null) => {
  if (!logo) return "";
  if (logo.startsWith("https://") && logo.includes(".blob.vercel-storage.com")) {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "";
    return \`\${baseUrl}/api/brand-image?url=\${encodeURIComponent(logo)}\`;
  }
  return logo;
};`,
  ],
  [
    `  const [showConversations, setShowConversations] = useState(false);`,
    `  const [showConversations, setShowConversations] = useState(false);
  const [logoError, setLogoError] = useState(false);

  useEffect(() => {
    setLogoError(false);
  }, [brand?.logo]);

  const brandLogoSrc =
    !logoError && brand?.logo ? getBrandLogoSrc(brand.logo as string) : "";`,
  ],
  [
    `              {brand && brand.logo ? (
                <img
                  className="h-16 w-36 object-contain"
                  src={brand.logo}
                  alt="Logo"
                  // fill
                  // quality={100}
                  // priority
                />
              ) : (`,
    `              {brandLogoSrc ? (
                <img
                  className="h-16 w-36 object-contain"
                  src={brandLogoSrc}
                  alt="Logo"
                  onError={() => setLogoError(true)}
                />
              ) : (`,
  ],
]);

replaceInFile("components/view/dataroom/nav-dataroom.tsx", [
  [
    `const DEFAULT_BANNER_IMAGE = "/_static/papermark-banner.png";`,
    `const DEFAULT_BANNER_IMAGE = "/_static/papermark-banner.png";

const getBrandLogoSrc = (logo?: string | null) => {
  if (!logo) return "";
  if (logo.startsWith("https://") && logo.includes(".blob.vercel-storage.com")) {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "";
    return \`\${baseUrl}/api/brand-image?url=\${encodeURIComponent(logo)}\`;
  }
  return logo;
};`,
  ],
  [
    `  const [showConversations, setShowConversations] = useState<boolean>(false);`,
    `  const [showConversations, setShowConversations] = useState<boolean>(false);
  const [logoError, setLogoError] = useState(false);

  useEffect(() => {
    setLogoError(false);
  }, [brand?.logo]);

  const brandLogoSrc =
    !logoError && brand?.logo ? getBrandLogoSrc(brand.logo as string) : "";`,
  ],
  [
    `              {brand && brand.logo ? (
                <img
                  className="h-16 w-36 object-contain"
                  src={brand.logo}
                  alt="Logo"
                />
              ) : (`,
    `              {brandLogoSrc ? (
                <img
                  className="h-16 w-36 object-contain"
                  src={brandLogoSrc}
                  alt="Logo"
                  onError={() => setLogoError(true)}
                />
              ) : (`,
  ],
]);

replaceInFile("components/view/access-form/index.tsx", [
  [
    `export const DEFAULT_ACCESS_FORM_DATA = {
  email: null,
  password: null,
};`,
    `export const DEFAULT_ACCESS_FORM_DATA = {
  email: null,
  password: null,
};

const getBrandLogoSrc = (logo?: string | null) => {
  if (!logo) return "";
  if (logo.startsWith("https://") && logo.includes(".blob.vercel-storage.com")) {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "";
    return \`\${baseUrl}/api/brand-image?url=\${encodeURIComponent(logo)}\`;
  }
  return logo;
};`,
  ],
  [
    `  const [isEmailValid, setIsEmailValid] = useState(true);`,
    `  const [isEmailValid, setIsEmailValid] = useState(true);
  const [logoError, setLogoError] = useState(false);

  useEffect(() => {
    setLogoError(false);
  }, [brand?.logo]);

  const brandLogoSrc =
    !logoError && brand?.logo ? getBrandLogoSrc(brand.logo as string) : "";`,
  ],
  [
    `      {logoOnAccessForm && brand && brand.logo && (`,
    `      {logoOnAccessForm && brand && brandLogoSrc && (`,
  ],
  [
    `            <img
              src={brand.logo as string}
              alt="Brand Logo"
              className="h-16 w-auto object-contain"
            />`,
    `            <img
              src={brandLogoSrc}
              alt="Brand Logo"
              className="h-16 w-auto object-contain"
              onError={() => setLogoError(true)}
            />`,
  ],
]);

replaceInFile("pages/api/record_view.ts", [
  [
    `  try {
    await publishPageView(result.data);

    res.status(200).json({ message: "View recorded" });
  } catch (error) {
    log({
      message: \`Failed to record view (tinybird) for \${linkId}. \\n\\n \${error}\`,
      type: "error",
      mention: true,
    });
    res.status(500).json({ message: (error as Error).message });
  }`,
    `  try {
    await publishPageView(result.data);

    return res.status(200).json({ message: "View recorded" });
  } catch (error) {
    log({
      message: \`Failed to record view (tinybird) for \${linkId}. \\n\\n \${error}\`,
      type: "error",
      mention: true,
    });
    return res.status(200).json({
      message: "View accepted without duration analytics",
    });
  }`,
  ],
]);

const schemaPath = "prisma/schema/schema.prisma";
let schema = fs.readFileSync(schemaPath, "utf8");
if (!schema.includes("model PageViewEvent")) {
  schema += `

model PageViewEvent {
  id            String   @id
  linkId        String
  documentId    String
  viewId        String
  dataroomId    String?
  versionNumber Int      @default(1)
  time          BigInt
  duration      Int
  pageNumber    String
  createdAt     DateTime @default(now())

  @@index([linkId])
  @@index([documentId])
  @@index([viewId])
  @@index([documentId, viewId])
  @@index([time])
}
`;
  fs.writeFileSync(schemaPath, schema);
}
if (!schema.includes("model LinkClickEvent")) {
  schema += `

model LinkClickEvent {
  id            String   @id
  sessionId     String
  linkId        String
  documentId    String
  viewId        String
  dataroomId    String?
  pageNumber    String
  href          String
  versionNumber Int      @default(1)
  timestamp     DateTime
  createdAt     DateTime @default(now())

  @@index([documentId])
  @@index([viewId])
  @@index([documentId, viewId])
  @@index([timestamp])
}
`;
  fs.writeFileSync(schemaPath, schema);
}

const pageViewMigrationDir = "prisma/migrations/20260630000000_add_page_view_events";
fs.mkdirSync(pageViewMigrationDir, { recursive: true });
fs.writeFileSync(
  `${pageViewMigrationDir}/migration.sql`,
  `CREATE TABLE "PageViewEvent" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "viewId" TEXT NOT NULL,
    "dataroomId" TEXT,
    "versionNumber" INTEGER NOT NULL DEFAULT 1,
    "time" BIGINT NOT NULL,
    "duration" INTEGER NOT NULL,
    "pageNumber" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageViewEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PageViewEvent_linkId_idx" ON "PageViewEvent"("linkId");
CREATE INDEX "PageViewEvent_documentId_idx" ON "PageViewEvent"("documentId");
CREATE INDEX "PageViewEvent_viewId_idx" ON "PageViewEvent"("viewId");
CREATE INDEX "PageViewEvent_documentId_viewId_idx" ON "PageViewEvent"("documentId", "viewId");
CREATE INDEX "PageViewEvent_time_idx" ON "PageViewEvent"("time");
`,
);

const linkClickMigrationDir = "prisma/migrations/20260630220000_add_link_click_events";
fs.mkdirSync(linkClickMigrationDir, { recursive: true });
fs.writeFileSync(
  `${linkClickMigrationDir}/migration.sql`,
  `CREATE TABLE "LinkClickEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "viewId" TEXT NOT NULL,
    "dataroomId" TEXT,
    "pageNumber" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL DEFAULT 1,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkClickEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LinkClickEvent_documentId_idx" ON "LinkClickEvent"("documentId");
CREATE INDEX "LinkClickEvent_viewId_idx" ON "LinkClickEvent"("viewId");
CREATE INDEX "LinkClickEvent_documentId_viewId_idx" ON "LinkClickEvent"("documentId", "viewId");
CREATE INDEX "LinkClickEvent_timestamp_idx" ON "LinkClickEvent"("timestamp");
`,
);

replaceInFile("pages/api/record_view.ts", [
  [
    `import { publishPageView } from "@/lib/tinybird";`,
    `import prisma from "@/lib/prisma";
import { publishPageView } from "@/lib/tinybird";`,
  ],
  [
    `  try {
    await publishPageView(result.data);`,
    `  try {
    await prisma.pageViewEvent.create({
      data: {
        id: result.data.id,
        linkId: result.data.linkId,
        documentId: result.data.documentId,
        viewId: result.data.viewId,
        dataroomId: result.data.dataroomId || null,
        versionNumber: result.data.versionNumber,
        time: BigInt(result.data.time),
        duration: result.data.duration,
        pageNumber: result.data.pageNumber,
      },
    });
  } catch (error) {
    console.error("Failed to store page view duration", result.data.id, error);
  }

  try {
    await publishPageView(result.data);`,
  ],
]);

replaceInFile("pages/api/record_click.ts", [
  [
    `import { newId } from "@/lib/id-helper";
import { recordClickEvent } from "@/lib/tinybird";`,
    `import { newId } from "@/lib/id-helper";
import prisma from "@/lib/prisma";
import { recordClickEvent } from "@/lib/tinybird";`,
  ],
  [
    `  try {
    await recordClickEvent(result.data);
    res.status(200).json({ message: "Click event recorded" });`,
    `  try {
    await prisma.linkClickEvent.create({
      data: {
        id: result.data.event_id,
        sessionId: result.data.session_id,
        linkId: result.data.link_id,
        documentId: result.data.document_id,
        viewId: result.data.view_id,
        dataroomId: result.data.dataroom_id || null,
        pageNumber: result.data.page_number,
        href: result.data.href,
        versionNumber: result.data.version_number,
        timestamp: new Date(result.data.timestamp),
      },
    });
  } catch (error) {
    console.error("Failed to store click event", result.data.event_id, error);
  }

  try {
    await recordClickEvent(result.data);
    res.status(200).json({ message: "Click event recorded" });`,
  ],
  [
    `    res.status(500).json({ error: "Failed to record click event" });`,
    `    res.status(200).json({ message: "Click event accepted without Tinybird" });`,
  ],
]);

replaceInFile("pages/api/links/[id]/visits.ts", [
  [
    `      const durationsPromises = limitedViews.map((view) => {
        return getViewPageDuration({
          documentId: view.documentId!,
          viewId: view.id,
          since: 0,
        });
      });

      const durations = await Promise.all(durationsPromises);`,
    `      const durations = await Promise.all(
        limitedViews.map(async (view) => {
          try {
            return await getViewPageDuration({
              documentId: view.documentId!,
              viewId: view.id,
              since: 0,
            });
          } catch (error) {
            console.error("Failed to get Tinybird duration for view", view.id, error);
            return { data: [] as { pageNumber: string; sum_duration: number }[] };
          }
        }),
      );`,
  ],
]);

replaceInFile("pages/api/links/[id]/visits.ts", [
  [
    `import { log } from "@/lib/utils";`,
    `import { log } from "@/lib/utils";

import { authOptions } from "../../auth/[...nextauth]";

type PageDuration = { pageNumber: string; sum_duration: number };

async function getStoredViewPageDuration({
  documentId,
  viewId,
}: {
  documentId: string;
  viewId: string;
}) {
  const rows = await prisma.pageViewEvent.groupBy({
    by: ["pageNumber"],
    where: { documentId, viewId },
    _sum: { duration: true },
  });

  return {
    data: rows
      .map((row) => ({
        pageNumber: row.pageNumber,
        sum_duration: row._sum.duration || 0,
      }))
      .sort(
        (a: PageDuration, b: PageDuration) =>
          Number(a.pageNumber) - Number(b.pageNumber),
      ),
  };
}`,
  ],
  [
    `  };
}

import { authOptions } from "../../auth/[...nextauth]";`,
    `  };
}`,
  ],
  [
    `            return { data: [] as { pageNumber: string; sum_duration: number }[] };`,
    `            return getStoredViewPageDuration({
              documentId: view.documentId!,
              viewId: view.id,
            });`,
  ],
]);

replaceInFile("pages/api/teams/[teamId]/documents/[id]/views/[viewId]/click-events.ts", [
  [
    `import { log } from "@/lib/utils";`,
    `import { log } from "@/lib/utils";

async function getStoredClickEventsByView({
  documentId,
  viewId,
}: {
  documentId: string;
  viewId: string;
}) {
  const rows = await prisma.linkClickEvent.findMany({
    where: {
      documentId,
      viewId,
    },
    orderBy: {
      timestamp: "asc",
    },
  });

  return {
    data: rows.map((row) => ({
      timestamp: row.timestamp.toISOString(),
      document_id: row.documentId,
      dataroom_id: row.dataroomId,
      view_id: row.viewId,
      page_number: row.pageNumber,
      version_number: row.versionNumber,
      href: row.href,
    })),
  };
}`,
  ],
  [
    `    const data = await getClickEventsByView({
      document_id: id,
      view_id: viewId,
    });`,
    `    let data;
    try {
      data = await getClickEventsByView({
        document_id: id,
        view_id: viewId,
      });
    } catch (error) {
      console.error("Failed to get Tinybird click events for view", viewId, error);
      data = await getStoredClickEventsByView({
        documentId: id,
        viewId,
      });
    }`,
  ],
]);

replaceInFile("pages/api/teams/[teamId]/documents/[id]/views/index.ts", [
  [
    `async function getDocumentViews(views: ViewWithExtras[], document: Document) {
  const durationsPromises = views.map((view) => {
    return getViewPageDuration({
      documentId: document.id,
      viewId: view.id,
      since: 0,
    });
  });

  const durations = await Promise.all(durationsPromises);`,
    `async function getDocumentViews(views: ViewWithExtras[], document: Document) {
  const durations = await Promise.all(
    views.map(async (view) => {
      try {
        return await getViewPageDuration({
          documentId: document.id,
          viewId: view.id,
          since: 0,
        });
      } catch (error) {
        console.error("Failed to get Tinybird duration for view", view.id, error);
        return { data: [] as { pageNumber: string; sum_duration: number }[] };
      }
    }),
  );`,
  ],
  [
    `      let viewsWithDuration;
      if (document.type === "video") {
        const videoEvents = await getVideoEventsByDocument({
          document_id: docId,
        });
        viewsWithDuration = await getVideoViews(
          limitedViews,
          document,
          videoEvents,
        );
      } else {
        viewsWithDuration = await getDocumentViews(limitedViews, document);
      }`,
    `      let viewsWithDuration;
      if (document.type === "video") {
        let videoEvents = { data: [] as VideoEvent[] };
        try {
          videoEvents = await getVideoEventsByDocument({
            document_id: docId,
          });
        } catch (error) {
          console.error("Failed to get Tinybird video events for document", docId, error);
        }
        viewsWithDuration = await getVideoViews(
          limitedViews,
          document,
          videoEvents,
        );
      } else {
        viewsWithDuration = await getDocumentViews(limitedViews, document);
      }`,
  ],
]);

replaceInFile("pages/api/teams/[teamId]/documents/[id]/views/index.ts", [
  [
    `import { log } from "@/lib/utils";`,
    `import { log } from "@/lib/utils";

type PageDuration = { pageNumber: string; sum_duration: number };

async function getStoredViewPageDuration({
  documentId,
  viewId,
}: {
  documentId: string;
  viewId: string;
}) {
  const rows = await prisma.pageViewEvent.groupBy({
    by: ["pageNumber"],
    where: { documentId, viewId },
    _sum: { duration: true },
  });

  return {
    data: rows
      .map((row) => ({
        pageNumber: row.pageNumber,
        sum_duration: row._sum.duration || 0,
      }))
      .sort(
        (a: PageDuration, b: PageDuration) =>
          Number(a.pageNumber) - Number(b.pageNumber),
      ),
  };
}`,
  ],
  [
    `        return { data: [] as { pageNumber: string; sum_duration: number }[] };`,
    `        return getStoredViewPageDuration({
          documentId: document.id,
          viewId: view.id,
        });`,
  ],
]);

replaceInFile("pages/api/teams/[teamId]/documents/[id]/stats.ts", [
  [
    `      const duration = await getTotalAvgPageDuration({
        documentId: docId,
        excludedLinkIds: "",
        excludedViewIds: allExcludedViews.map((view) => view.id).join(","),
        since: 0,
      });

      const totalDocumentDuration = await getTotalDocumentDuration({
        documentId: docId,
        excludedLinkIds: "",
        excludedViewIds: allExcludedViews.map((view) => view.id).join(","),
        since: 0,
      });

      const stats = {
        views: filteredViews,
        duration,
        total_duration:
          (totalDocumentDuration.data[0].sum_duration * 1.0) /
          filteredViews.length,
        groupedReactions,
        totalViews: filteredViews.length,
      };`,
    `      let duration = {
        data: [] as {
          versionNumber: number;
          pageNumber: string;
          avg_duration: number;
        }[],
      };
      let totalDocumentDuration = { data: [{ sum_duration: 0 }] };

      try {
        [duration, totalDocumentDuration] = await Promise.all([
          getTotalAvgPageDuration({
            documentId: docId,
            excludedLinkIds: "",
            excludedViewIds: allExcludedViews.map((view) => view.id).join(","),
            since: 0,
          }),
          getTotalDocumentDuration({
            documentId: docId,
            excludedLinkIds: "",
            excludedViewIds: allExcludedViews.map((view) => view.id).join(","),
            since: 0,
          }),
        ]);
      } catch (error) {
        console.error("Failed to get Tinybird document stats", docId, error);
      }

      const stats = {
        views: filteredViews,
        duration,
        total_duration: filteredViews.length
          ? ((totalDocumentDuration.data[0]?.sum_duration || 0) * 1.0) /
            filteredViews.length
          : 0,
        groupedReactions,
        totalViews: filteredViews.length,
      };`,
  ],
]);

replaceInFile("pages/api/teams/[teamId]/documents/[id]/stats.ts", [
  [
    `import { authOptions } from "../../../../auth/[...nextauth]";`,
    `import { authOptions } from "../../../../auth/[...nextauth]";

async function getStoredDocumentStats({
  docId,
  excludedViewIds,
}: {
  docId: string;
  excludedViewIds: string[];
}) {
  const rows = await prisma.pageViewEvent.groupBy({
    by: ["versionNumber", "pageNumber", "viewId"],
    where: {
      documentId: docId,
      viewId: { notIn: excludedViewIds },
    },
    _sum: { duration: true },
  });

  const pageDurations = new Map<
    string,
    {
      versionNumber: number;
      pageNumber: string;
      totalDuration: number;
      viewCount: number;
    }
  >();

  for (const row of rows) {
    const key = \`\${row.versionNumber}:\${row.pageNumber}\`;
    const current = pageDurations.get(key) || {
      versionNumber: row.versionNumber,
      pageNumber: row.pageNumber,
      totalDuration: 0,
      viewCount: 0,
    };

    current.totalDuration += row._sum.duration || 0;
    current.viewCount += 1;
    pageDurations.set(key, current);
  }

  return {
    duration: {
      data: Array.from(pageDurations.values())
        .map((page) => ({
          versionNumber: page.versionNumber,
          pageNumber: page.pageNumber,
          avg_duration: page.viewCount
            ? page.totalDuration / page.viewCount
            : 0,
        }))
        .sort((a, b) =>
          a.versionNumber === b.versionNumber
            ? Number(a.pageNumber) - Number(b.pageNumber)
            : a.versionNumber - b.versionNumber,
        ),
    },
    totalDocumentDuration: {
      data: [
        {
          sum_duration: rows.reduce(
            (total, row) => total + (row._sum.duration || 0),
            0,
          ),
        },
      ],
    },
  };
}`,
  ],
  [
    `      } catch (error) {
        console.error("Failed to get Tinybird document stats", docId, error);
      }`,
    `      } catch (error) {
        console.error("Failed to get Tinybird document stats", docId, error);
        const fallbackStats = await getStoredDocumentStats({
          docId,
          excludedViewIds: allExcludedViews.map((view) => view.id),
        });
        duration = fallbackStats.duration;
        totalDocumentDuration = fallbackStats.totalDocumentDuration;
      }`,
  ],
]);

replaceInFile("pages/api/teams/[teamId]/documents/[id]/views/[viewId]/stats.ts", [
  [
    `import { errorhandler } from "@/lib/errorHandler";`,
    `import { errorhandler } from "@/lib/errorHandler";
import prisma from "@/lib/prisma";`,
  ],
  [
    `import { CustomUser } from "@/lib/types";`,
    `import { CustomUser } from "@/lib/types";

async function getStoredViewStats({
  documentId,
  viewId,
}: {
  documentId: string;
  viewId: string;
}) {
  const rows = await prisma.pageViewEvent.groupBy({
    by: ["pageNumber"],
    where: {
      documentId,
      viewId,
    },
    _sum: { duration: true },
  });

  const data = rows
    .map((row) => ({
      pageNumber: row.pageNumber,
      sum_duration: row._sum.duration || 0,
    }))
    .sort((a, b) => Number(a.pageNumber) - Number(b.pageNumber));

  return {
    duration: { data },
    total_duration: data.reduce(
      (totalDuration, page) => totalDuration + page.sum_duration,
      0,
    ),
  };
}`,
  ],
  [
    `      const duration = await getViewPageDuration({
        documentId: docId,
        viewId: viewId,
        since: 0,
      });

      const total_duration = duration.data.reduce(
        (totalDuration, data) => totalDuration + data.sum_duration,
        0,
      );

      const stats = { duration, total_duration };`,
    `      let stats;
      try {
        const duration = await getViewPageDuration({
          documentId: docId,
          viewId: viewId,
          since: 0,
        });

        const total_duration = duration.data.reduce(
          (totalDuration, data) => totalDuration + data.sum_duration,
          0,
        );

        stats = { duration, total_duration };
      } catch (error) {
        console.error("Failed to get Tinybird visitor stats for view", viewId, error);
        stats = await getStoredViewStats({
          documentId: docId,
          viewId,
        });
      }`,
  ],
]);

fs.writeFileSync(
  "components/view/powered-by.tsx",
  `export const PoweredBy = ({ linkId }: { linkId: string }) => {
  void linkId;
  return null;
};
`,
);

replaceInFile("components/view/access-form/index.tsx", [
  [
    `            This document is securely shared with you using{" "}
            <a
              href="https://www.papermark.com"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold"
            >
              Papermark
            </a>`,
    `            <a
              href="https://gradien.ai/?utm_source=dataroom"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold"
            >
              Gradien - AI infrastructure for autonomous organizations
            </a>`,
  ],
]);

replaceInFile("components/visitors/visitor-chart.tsx", [
  [
    `import BarChartComponent from "@/components/charts/bar-chart";`,
    `import BarChartComponent from "@/components/charts/bar-chart";
import { timeFormatter } from "@/components/charts/utils";`,
  ],
  [
    `  let durationData = Array.from({ length: totalPages }, (_, i) => ({
    pageNumber: (i + 1).toString(),
    sum_duration: 0,
  }));

  const swrData = stats?.duration;

  durationData = durationData.map((item) => {
    const swrItem = swrData.data.find(
      (data) => data.pageNumber === item.pageNumber,
    );
    return swrItem ? swrItem : item;
  });`,
    `  const swrData = stats?.duration;
  const trackedPages = swrData.data
    .map((data) => Number(data.pageNumber))
    .filter((pageNumber) => Number.isFinite(pageNumber));
  const pageCount = Math.max(totalPages, ...trackedPages, 0);

  let durationData = Array.from({ length: pageCount }, (_, i) => ({
    pageNumber: (i + 1).toString(),
    sum_duration: 0,
  }));

  durationData = durationData.map((item) => {
    const swrItem = swrData.data.find(
      (data) => data.pageNumber === item.pageNumber,
    );
    return swrItem ? swrItem : item;
  });`,
  ],
  [
    `      <BarChartComponent
        data={durationData}
        isSum={true}
        versionNumber={versionNumber}
      />
    </div>`,
    `      <BarChartComponent
        data={durationData}
        isSum={true}
        versionNumber={versionNumber}
      />
      <div className="grid grid-cols-2 gap-2 px-2 pb-3 pt-2 text-xs text-muted-foreground sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {durationData.map((page) => (
          <div
            key={page.pageNumber}
            className="flex items-center justify-between rounded-md border bg-background px-2 py-1"
          >
            <span>Slide {page.pageNumber}</span>
            <span className="font-medium text-foreground">
              {timeFormatter(page.sum_duration)}
            </span>
          </div>
        ))}
      </div>
    </div>`,
  ],
]);

replaceInFile("lib/utils/geo.ts", [
  [
    `export function getGeoData(headers: {
  [key: string]: string | string[] | undefined;
}): Geo {
  return {
    city: Array.isArray(headers["x-vercel-ip-city"])
      ? headers["x-vercel-ip-city"][0]
      : headers["x-vercel-ip-city"],
    region: Array.isArray(headers["x-vercel-ip-region"])
      ? headers["x-vercel-ip-region"][0]
      : headers["x-vercel-ip-region"],
    country: Array.isArray(headers["x-vercel-ip-country"])
      ? headers["x-vercel-ip-country"][0]
      : headers["x-vercel-ip-country"],
    latitude: Array.isArray(headers["x-vercel-ip-latitude"])
      ? headers["x-vercel-ip-latitude"][0]
      : headers["x-vercel-ip-latitude"],
    longitude: Array.isArray(headers["x-vercel-ip-longitude"])
      ? headers["x-vercel-ip-longitude"][0]
      : headers["x-vercel-ip-longitude"],
  };
}`,
    `function getHeader(
  headers: { [key: string]: string | string[] | undefined },
  key: string,
) {
  const value = headers[key];
  return Array.isArray(value) ? value[0] : value;
}

export function getGeoData(headers: {
  [key: string]: string | string[] | undefined;
}): Geo {
  return {
    city: getHeader(headers, "x-vercel-ip-city"),
    region: getHeader(headers, "x-vercel-ip-region"),
    country:
      getHeader(headers, "x-vercel-ip-country") ||
      getHeader(headers, "cf-ipcountry"),
    latitude: getHeader(headers, "x-vercel-ip-latitude"),
    longitude: getHeader(headers, "x-vercel-ip-longitude"),
  };
}`,
  ],
  [
    `export const LOCALHOST_GEO_DATA = {
  continent: "Europe",
  city: "Munich",
  region: "BY",
  country: "DE",
  latitude: "48.137154",
  longitude: "11.576124",
};`,
    `export const LOCALHOST_GEO_DATA = {
  continent: "Unknown",
  city: "Unknown",
  region: "Unknown",
  country: "Unknown",
  latitude: "Unknown",
  longitude: "Unknown",
};`,
  ],
]);

replaceInFile("lib/tracking/record-link-view.ts", [
  [
    `  const ip = process.env.VERCEL === "1" ? ipAddress(req) : LOCALHOST_IP;`,
    `  const ip = getIpAddress(req.headers);`,
  ],
  [
    `      : LOCALHOST_GEO_DATA;`,
    `      : LOCALHOST_GEO_DATA;`,
  ],
  [
    `  const geo =
    process.env.VERCEL === "1" ? geolocation(req) : LOCALHOST_GEO_DATA;`,
    `  const geo =
    process.env.VERCEL === "1"
      ? geolocation(req)
      : {
          ...LOCALHOST_GEO_DATA,
          country:
            req.headers.get("cf-ipcountry") || LOCALHOST_GEO_DATA.country,
        };`,
  ],
]);

replaceInFile("lib/utils/ip.ts", [
  [
    `export function getIpAddress(headers: {
  [key: string]: string | string[] | undefined;
}): string {
  if (typeof headers["x-forwarded-for"] === "string") {
    return (headers["x-forwarded-for"] ?? "127.0.0.1").split(",")[0];
  }
  return "127.0.0.1";
}
`,
    `type HeaderSource =
  | Headers
  | {
      [key: string]: string | string[] | undefined;
    };

const LOCALHOST_IP = "127.0.0.1";

function getHeader(headers: HeaderSource, name: string) {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }

  const value =
    (headers as Record<string, string | string[] | undefined>)[name] ||
    (headers as Record<string, string | string[] | undefined>)[
      name.toLowerCase()
    ];

  return Array.isArray(value) ? value[0] : value || null;
}

function normalizeIp(ip?: string | null) {
  if (!ip) return null;
  let value = ip.trim().replace(/^"|"$/g, "");
  if (!value) return null;

  if (value.startsWith("for=")) {
    value = value.slice(4);
  }
  if (value.startsWith("[") && value.includes("]")) {
    value = value.slice(1, value.indexOf("]"));
  }
  if (value.startsWith("::ffff:")) {
    value = value.slice(7);
  }
  if (/^\\d+\\.\\d+\\.\\d+\\.\\d+:\\d+$/.test(value)) {
    value = value.split(":")[0];
  }

  return value;
}

function isPublicIp(ip?: string | null) {
  const value = normalizeIp(ip);
  if (!value || value === LOCALHOST_IP || value === "::1") return false;
  if (value.startsWith("10.") || value.startsWith("192.168.")) return false;
  if (/^172\\.(1[6-9]|2\\d|3[0-1])\\./.test(value)) return false;
  if (value.startsWith("fc") || value.startsWith("fd")) return false;
  return true;
}

export function getIpAddress(headers: HeaderSource): string {
  const forwarded = getHeader(headers, "forwarded");
  const forwardedFor =
    forwarded
      ?.split(",")
      .flatMap((part) => part.split(";"))
      .map((part) => part.trim())
      .find((part) => part.toLowerCase().startsWith("for=")) || null;

  const candidates = [
    getHeader(headers, "cf-connecting-ip"),
    getHeader(headers, "true-client-ip"),
    getHeader(headers, "x-real-ip"),
    getHeader(headers, "x-client-ip"),
    forwardedFor,
    getHeader(headers, "x-forwarded-for"),
  ].flatMap((value) => (value ? value.split(",") : []));

  return candidates.map(normalizeIp).find(isPublicIp) || LOCALHOST_IP;
}
`,
  ],
]);

for (const filePath of ["app/api/views/route.ts", "app/api/views-dataroom/route.ts"]) {
  replaceInFile(filePath, [
    [
      `import { ipAddress, waitUntil } from "@vercel/functions";`,
      `import { waitUntil } from "@vercel/functions";`,
    ],
    [
      `import { LOCALHOST_IP } from "@/lib/utils/geo";`,
      `import { getIpAddress } from "@/lib/utils/ip";`,
    ],
  ]);

  replaceAllInFile(filePath, [
    [`ipAddress(request) ?? LOCALHOST_IP`, `getIpAddress(request.headers)`],
    [`ipAddress(request)`, `getIpAddress(request.headers)`],
    [`? (getIpAddress(request.headers))`, `? getIpAddress(request.headers)`],
    [
      `process.env.VERCEL === "1"
              ? getIpAddress(request.headers)
              : LOCALHOST_IP`,
      `getIpAddress(request.headers)`,
    ],
  ]);
}

replaceInFile("lib/auth/dataroom-auth.ts", [
  [
    `import { ipAddress } from "@vercel/functions";
`,
    ``,
  ],
  [
    `    const ipAddressValue = ipAddress(request) ?? LOCALHOST_IP;`,
    `    const ipAddressValue = getIpAddress(request.headers);`,
  ],
]);

replaceInFile("lib/tracking/record-link-view.ts", [
  [
    `import { geolocation, ipAddress } from "@vercel/functions";`,
    `import { geolocation } from "@vercel/functions";`,
  ],
  [
    `import { LOCALHOST_GEO_DATA, LOCALHOST_IP } from "../utils/geo";`,
    `import { LOCALHOST_GEO_DATA, LOCALHOST_IP } from "../utils/geo";
import { getIpAddress } from "../utils/ip";

function isPublicIp(ip?: string | null) {
  const value = normalizeIp(ip);
  if (!value || value === LOCALHOST_IP || value === "127.0.0.1") return false;
  if (value.startsWith("10.") || value.startsWith("192.168.")) return false;
  if (/^172\\.(1[6-9]|2\\d|3[0-1])\\./.test(value)) return false;
  if (value === "::1" || value.startsWith("fc") || value.startsWith("fd")) return false;
  return true;
}

function normalizeIp(ip?: string | null) {
  if (!ip) return null;
  let value = ip.trim().replace(/^"|"$/g, "");
  if (!value) return null;

  if (value.startsWith("for=")) {
    value = value.slice(4);
  }
  if (value.startsWith("[") && value.includes("]")) {
    value = value.slice(1, value.indexOf("]"));
  }
  if (value.startsWith("::ffff:")) {
    value = value.slice(7);
  }
  if (/^\\d+\\.\\d+\\.\\d+\\.\\d+:\\d+$/.test(value)) {
    value = value.split(":")[0];
  }

  return value;
}

async function lookupGeo(ip?: string | null) {
  const publicIp = normalizeIp(ip);
  if (!isPublicIp(publicIp)) return null;
  if ((process.env.IP_GEOLOCATION_PROVIDER || "ipapi") !== "ipapi") return null;

  const apiKey = process.env.IPAPI_API_KEY;
  const encodedIp = encodeURIComponent(publicIp!);
  const urls = [
    apiKey ? \`https://ipapi.co/\${encodedIp}/json/?key=\${apiKey}\` : null,
    \`https://ipapi.co/\${encodedIp}/json/\`,
  ].filter(Boolean) as string[];

  for (const url of urls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "gradien-dataroom/1.0" },
        signal: controller.signal,
      });
      if (!response.ok) continue;
      const data = await response.json();
      if (data.error) continue;

      const country =
        data.country_code || data.country || data.country_name || LOCALHOST_GEO_DATA.country;

      if (!country || country === LOCALHOST_GEO_DATA.country) continue;

      return {
        continent: data.continent_code || LOCALHOST_GEO_DATA.continent,
        country,
        region: data.region_code || data.region || LOCALHOST_GEO_DATA.region,
        city: data.city || LOCALHOST_GEO_DATA.city,
        latitude:
          data.latitude != null
            ? String(data.latitude)
            : LOCALHOST_GEO_DATA.latitude,
        longitude:
          data.longitude != null
            ? String(data.longitude)
            : LOCALHOST_GEO_DATA.longitude,
      };
    } catch {
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }

  return null;
}`,
  ],
  [
    `  const { continent, region } =
    process.env.VERCEL === "1"
      ? {
          continent: req.headers.get("x-vercel-ip-continent"),
          region: geolocation(req).countryRegion,
        }
      : LOCALHOST_GEO_DATA;

  const geo =
    process.env.VERCEL === "1"
      ? geolocation(req)
      : {
          ...LOCALHOST_GEO_DATA,
          country:
            req.headers.get("cf-ipcountry") || LOCALHOST_GEO_DATA.country,
        };`,
    `  const fallbackGeo = {
    ...LOCALHOST_GEO_DATA,
    country: req.headers.get("cf-ipcountry") || LOCALHOST_GEO_DATA.country,
  };
  const geo =
    process.env.VERCEL === "1"
      ? geolocation(req)
      : (await lookupGeo(ip)) || fallbackGeo;
  const fallbackGeoResult = geo as typeof LOCALHOST_GEO_DATA;

  const continent =
    process.env.VERCEL === "1"
      ? req.headers.get("x-vercel-ip-continent")
      : fallbackGeoResult.continent;
  const region =
    process.env.VERCEL === "1" ? geolocation(req).countryRegion : fallbackGeoResult.region;`,
  ],
]);

replaceInFile("pages/api/jobs/send-notification.ts", [
  [
    `  const locationString =
    locationData.country === "US"
      ? \`\${locationData.city}, \${locationData.region}, \${locationData.country}\`
      : \`\${locationData.city}, \${locationData.country}\`;`,
    `  const locationParts =
    locationData.country === "US"
      ? [locationData.city, locationData.region, locationData.country]
      : [locationData.city, locationData.country];
  const locationString = locationParts
    .filter((part) => part && part !== "Unknown")
    .join(", ");`,
  ],
  [
    `        locationString: includeLocation ? locationString : undefined,`,
    `        locationString: includeLocation && locationString ? locationString : undefined,`,
  ],
  [
    `        locationString: includeLocation ? locationString : undefined,`,
    `        locationString: includeLocation && locationString ? locationString : undefined,`,
  ],
]);

replaceInFile("pages/api/analytics/index.ts", [
  [
    `import {
  getTotalDocumentDuration,
  getTotalLinkDuration,
  getTotalViewerDuration,
  getViewPageDuration,
} from "@/lib/tinybird/pipes";`,
    ``,
  ],
  [
    `const INTERVALS = {
  "24h": 24 * 60 * 60 * 1000, // 24 hours in ms
  "7d": 7 * 24 * 60 * 60 * 1000, // 7 days in ms
  "30d": 30 * 24 * 60 * 60 * 1000, // 30 days in ms
} as const;`,
    `async function getStoredDurationSums({
  by,
  where,
}: {
  by: string[];
  where: any;
}) {
  const rows = await prisma.pageViewEvent.groupBy({
    by: by as any,
    where,
    _sum: { duration: true },
  });

  const durationByKey = new Map<string, number>();

  for (const row of rows) {
    const key = by.map((field) => String((row as any)[field] || "")).join(":");
    durationByKey.set(key, row._sum.duration || 0);
  }

  return durationByKey;
}

async function getStoredPageDurations(where: any) {
  const rows = await prisma.pageViewEvent.groupBy({
    by: ["pageNumber"],
    where,
    _sum: { duration: true },
  });

  return {
    data: rows
      .map((row) => ({
        pageNumber: row.pageNumber,
        sum_duration: row._sum.duration || 0,
      }))
      .sort((a, b) => Number(a.pageNumber) - Number(b.pageNumber)),
  };
}

async function getStoredPageDurationsByView(where: any) {
  const rows = await prisma.pageViewEvent.groupBy({
    by: ["viewId", "pageNumber"],
    where,
    _sum: { duration: true },
  });

  const durationByView = new Map<
    string,
    { data: { pageNumber: string; sum_duration: number }[] }
  >();

  for (const row of rows) {
    const existing = durationByView.get(row.viewId) || { data: [] };
    existing.data.push({
      pageNumber: row.pageNumber,
      sum_duration: row._sum.duration || 0,
    });
    durationByView.set(row.viewId, existing);
  }

  for (const duration of durationByView.values()) {
    duration.data.sort(
      (a, b) => Number(a.pageNumber) - Number(b.pageNumber),
    );
  }

  return durationByView;
}`,
  ],
  [
    `    let since: number;

    if (interval === "custom") {
      const startTimestamp = startStr ? new Date(startStr).getTime() : NaN;

      if (isNaN(startTimestamp)) {
        since = Date.now();
      } else {
        since = startTimestamp;
      }
    } else {
      since = Date.now() - INTERVALS[interval];
    }

`,
    ``,
  ],
  [
    `            let avgDuration = "0s";

            if (link.documentId) {
              try {
                const durationData = await getTotalLinkDuration({
                  linkId: link.id,
                  documentId: link.documentId,
                  excludedViewIds: "", // Include all views
                  since,
                  until: endStr
                    ? new Date(endStr).getTime()
                    : new Date().getTime(),
                });

                if (durationData.data && durationData.data[0]) {
                  const totalDuration = durationData.data[0].sum_duration;
                  const viewCount = durationData.data[0].view_count;
                  const avgDurationMs = totalDuration / viewCount;
                  avgDuration = durationFormat(avgDurationMs);
                }
              } catch (error) {
                console.error("Error fetching Tinybird data:", error);
              }
            }`,
    `            let avgDuration = "0s";

            if (link.documentId && link._count.views) {
              const totalDuration = await getStoredDurationSum({
                linkId: link.id,
                documentId: link.documentId,
                createdAt: intervalFilter,
              });
              avgDuration = durationFormat(totalDuration / link._count.views);
            }`,
  ],
  [
    `            let avgDuration = "0s";
            try {
              const durationData = await getTotalDocumentDuration({
                documentId: doc.id,
                excludedLinkIds: "", // Include all links
                excludedViewIds: "", // Include all views
                since,
                until: endStr
                  ? new Date(endStr).getTime()
                  : new Date().getTime(),
              });

              if (durationData.data && durationData.data[0]) {
                const totalDuration = durationData.data[0].sum_duration;
                const avgDurationMs = totalDuration / doc._count.views;
                avgDuration = durationFormat(avgDurationMs);
              }
            } catch (error) {
              console.error("Error fetching Tinybird data:", error);
            }`,
    `            let avgDuration = "0s";
            if (doc._count.views) {
              const totalDuration = await getStoredDurationSum({
                documentId: doc.id,
                createdAt: intervalFilter,
              });
              avgDuration = durationFormat(totalDuration / doc._count.views);
            }`,
  ],
  [
    `            let totalDuration = 0;
            try {
              const viewIds = viewer.views.map((view) => view.id).join(",");
              const durationData = await getTotalViewerDuration({
                viewIds,
                since,
                until: endStr
                  ? new Date(endStr).getTime()
                  : new Date().getTime(),
              });

              if (durationData.data && durationData.data[0]) {
                totalDuration = durationData.data[0].sum_duration;
              }
            } catch (error) {
              console.error("Error fetching Tinybird data:", error);
            }`,
    `            let totalDuration = 0;
            const viewIds = viewer.views.map((view) => view.id);
            if (viewIds.length) {
              totalDuration = await getStoredDurationSum({
                viewId: { in: viewIds },
                createdAt: intervalFilter,
              });
            }`,
  ],
  [
    `              try {
                const pageData = await getViewPageDuration({
                  documentId: view.document.id,
                  viewId: view.id,
                  since,
                  until: endStr
                    ? new Date(endStr).getTime()
                    : new Date().getTime(),
                });

                if (pageData.data && pageData.data.length > 0) {
                  // Calculate total duration from all pages
                  totalDuration = pageData.data.reduce(
                    (sum, page) => sum + page.sum_duration,
                    0,
                  );

                  // Calculate completion rate based on pages with any duration
                  const numPages = view.document.versions[0]?.numPages || 0;
                  completionRate = numPages
                    ? (pageData.data.length / numPages) * 100
                    : 0;
                }
              } catch (error) {
                console.error("Error fetching Tinybird data:", error);
              }`,
    `              const pageData = await getStoredPageDurations({
                documentId: view.document.id,
                viewId: view.id,
                createdAt: intervalFilter,
              });

              if (pageData.data.length > 0) {
                totalDuration = pageData.data.reduce(
                  (sum, page) => sum + page.sum_duration,
                  0,
                );

                const numPages = view.document.versions[0]?.numPages || 0;
                completionRate = numPages
                  ? (pageData.data.length / numPages) * 100
                  : 0;
              }`,
  ],
  [
    `        // Transform the data to match the table requirements
        const transformedLinks = await Promise.all(`,
    `        const linkIds = links.map((link) => link.id);
        const linkDurationById = linkIds.length
          ? await getStoredDurationSums({
              by: ["linkId"],
              where: {
                linkId: { in: linkIds },
                createdAt: intervalFilter,
              },
            })
          : new Map<string, number>();

        // Transform the data to match the table requirements
        const transformedLinks = await Promise.all(`,
  ],
  [
    `            let avgDuration = "0s";

            if (link.documentId && link._count.views) {
              const totalDuration = await getStoredDurationSum({
                linkId: link.id,
                documentId: link.documentId,
                createdAt: intervalFilter,
              });
              avgDuration = durationFormat(totalDuration / link._count.views);
            }`,
    `            let avgDuration = "0s";

            if (link.documentId && link._count.views) {
              const totalDuration = linkDurationById.get(link.id) || 0;
              avgDuration = durationFormat(totalDuration / link._count.views);
            }`,
  ],
  [
    `        // Transform the data to match the table requirements
        const transformedDocuments = await Promise.all(`,
    `        const documentIds = documents.map((doc) => doc.id);
        const documentDurationById = documentIds.length
          ? await getStoredDurationSums({
              by: ["documentId"],
              where: {
                documentId: { in: documentIds },
                createdAt: intervalFilter,
              },
            })
          : new Map<string, number>();

        // Transform the data to match the table requirements
        const transformedDocuments = await Promise.all(`,
  ],
  [
    `            let avgDuration = "0s";
            if (doc._count.views) {
              const totalDuration = await getStoredDurationSum({
                documentId: doc.id,
                createdAt: intervalFilter,
              });
              avgDuration = durationFormat(totalDuration / doc._count.views);
            }`,
    `            let avgDuration = "0s";
            if (doc._count.views) {
              const totalDuration = documentDurationById.get(doc.id) || 0;
              avgDuration = durationFormat(totalDuration / doc._count.views);
            }`,
  ],
  [
    `        // Transform the data to match the table requirements
        const transformedVisitors = await Promise.all(`,
    `        const allViewIds = viewers.flatMap((viewer) =>
          viewer.views.map((view) => view.id),
        );
        const durationByViewId = allViewIds.length
          ? await getStoredDurationSums({
              by: ["viewId"],
              where: {
                viewId: { in: allViewIds },
                createdAt: intervalFilter,
              },
            })
          : new Map<string, number>();

        // Transform the data to match the table requirements
        const transformedVisitors = await Promise.all(`,
  ],
  [
    `            let totalDuration = 0;
            const viewIds = viewer.views.map((view) => view.id);
            if (viewIds.length) {
              totalDuration = await getStoredDurationSum({
                viewId: { in: viewIds },
                createdAt: intervalFilter,
              });
            }`,
    `            const totalDuration = viewer.views.reduce(
              (total, view) => total + (durationByViewId.get(view.id) || 0),
              0,
            );`,
  ],
  [
    `        // Transform the data to match the table requirements
        const transformedViews = await Promise.all(`,
    `        const viewIds = views.map((view) => view.id);
        const pageDurationsByViewId = viewIds.length
          ? await getStoredPageDurationsByView({
              viewId: { in: viewIds },
              createdAt: intervalFilter,
            })
          : new Map<string, { data: { pageNumber: string; sum_duration: number }[] }>();

        // Transform the data to match the table requirements
        const transformedViews = await Promise.all(`,
  ],
  [
    `              const pageData = await getStoredPageDurations({
                documentId: view.document.id,
                viewId: view.id,
                createdAt: intervalFilter,
              });`,
    `              const pageData = pageDurationsByViewId.get(view.id) || {
                data: [],
              };`,
  ],
]);

const runtimeAppUrl = "(process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_BASE_URL)";
const runtimeMarketingUrl = "(process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_MARKETING_URL || process.env.NEXT_PUBLIC_BASE_URL)";

for (const filePath of [
  "ee/features/billing/cancellation/lib/trigger/pause-resume-notification.ts",
  "ee/features/billing/cancellation/emails/components/pause-resume-reminder.tsx",
  "ee/features/conversations/api/send-conversation-team-member-notification.ts",
  "ee/features/conversations/lib/trigger/conversation-message-notification.ts",
  "lib/documents/create-document.ts",
  "components/emails/welcome.tsx",
  "components/emails/upgrade-plan.tsx",
  "pages/api/teams/[teamId]/invitations/resend.ts",
  "lib/utils/unsubscribe.ts",
  "lib/webhook/send-webhooks.ts",
  "lib/trigger/pdf-to-image-route.ts",
  "lib/trigger/dataroom-change-notification.ts",
  "pages/api/teams/[teamId]/invite.ts",
]) {
  if (!fs.existsSync(filePath)) continue;
  let file = fs.readFileSync(filePath, "utf8");
  file = file.replaceAll("process.env.NEXT_PUBLIC_BASE_URL", runtimeAppUrl);
  fs.writeFileSync(filePath, file);
}

for (const filePath of [
  "ee/emails/pause-resume-reminder.tsx",
  "ee/features/conversations/lib/trigger/conversation-message-notification.ts",
  "pages/api/analytics/index.ts",
  "pages/api/webhooks/services/[...path]/index.ts",
  "pages/api/jobs/send-dataroom-view-invitation.ts",
  "lib/trigger/dataroom-change-notification.ts",
  "pages/api/links/generate-index.ts",
  "pages/api/teams/[teamId]/datarooms/[id]/generate-index.ts",
]) {
  if (!fs.existsSync(filePath)) continue;
  let file = fs.readFileSync(filePath, "utf8");
  file = file.replaceAll("process.env.NEXT_PUBLIC_MARKETING_URL", runtimeMarketingUrl);
  fs.writeFileSync(filePath, file);
}

const appUrlExpression = "process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_BASE_URL";
const appUrlWithFallbackExpression = `${appUrlExpression} || "https://gradien-dataroom.up.railway.app"`;

function selfHostedHref(path) {
  if (!path) {
    return `href={${appUrlWithFallbackExpression}}`;
  }

  const mappedPath = path === "/data-room" ? "/datarooms" : path;
  return `href={\`\${${appUrlExpression}}${mappedPath}\`}`;
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return walkFiles(entryPath);
    return /\.(tsx?|jsx?)$/.test(entry.name) ? [entryPath] : [];
  });
}

for (const filePath of [
  ...walkFiles("components/emails"),
  ...walkFiles("lib/emails"),
  ...walkFiles("ee/emails"),
  ...walkFiles("ee/features/billing/cancellation/emails"),
]) {
  let file = fs.readFileSync(filePath, "utf8");
  file = file
    .replace(/href="https:\/\/app\.papermark\.com([^"]*)"/g, (_match, path) =>
      selfHostedHref(path),
    )
    .replaceAll(
      "`https://app.papermark.com",
      "`${" + appUrlExpression + "}",
    )
    .replace(/href="https:\/\/www\.papermark\.com([^"]*)"/g, (_match, path) =>
      selfHostedHref(path),
    )
    .replace(/href="https:\/\/papermark\.com([^"]*)"/g, (_match, path) =>
      selfHostedHref(path),
    )
    .replace(
      /(url|confirmUrl) = "https:\/\/www\.papermark\.com",/g,
      `$1 = ${appUrlWithFallbackExpression},`,
    )
    .replace(
      /(url|confirmUrl) = "https:\/\/app\.papermark\.com([^"]*)",/g,
      (_match, name, path) =>
        `${name} = \`\${${appUrlExpression}}${path}\`,`,
    )
    .replaceAll(
      "https%3A%2F%2Fwww.papermark.com%2Fyear-in-review",
      "https%3A%2F%2Fdataroom.gradien.ai",
    )
    .replaceAll("papermark.com", "dataroom.gradien.ai");
  fs.writeFileSync(filePath, file);
}

replaceAllInFile("pages/api/auth/[...nextauth].ts", [
  [
    'return process.env.NEXTAUTH_URL || "https://app.papermark.com";',
    'return process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_BASE_URL || "https://gradien-dataroom.up.railway.app";',
  ],
]);

for (const filePath of [
  "lib/api/views/send-webhook-event.ts",
  "lib/webhook/triggers/link-created.ts",
]) {
  if (!fs.existsSync(filePath)) continue;
  let file = fs.readFileSync(filePath, "utf8");
  file = file
    .replaceAll(
      "`https://www.papermark.com/view/${link.id}`",
      "`${" + runtimeMarketingUrl + "}/view/${link.id}`",
    )
    .replaceAll(
      'link.domainId && link.domainSlug ? link.domainSlug : "papermark.com"',
      'link.domainId && link.domainSlug ? link.domainSlug : new URL((' +
        runtimeMarketingUrl +
        ') || "https://gradien-dataroom.up.railway.app").host',
    );
  fs.writeFileSync(filePath, file);
}

for (const filePath of [
  "pages/view/[linkId]/d/[documentId].tsx",
  "pages/view/[linkId]/index.tsx",
]) {
  if (!fs.existsSync(filePath)) continue;
  let file = fs.readFileSync(filePath, "utf8");
  file = file.replaceAll(
    "`https://www.papermark.com/view/${linkId}`",
    "`${" + runtimeMarketingUrl + "}/view/${linkId}`",
  );
  fs.writeFileSync(filePath, file);
}

const watermarkPanelPath = "components/links/link-sheet/watermark-panel/index.tsx";
let watermarkPanel = fs.readFileSync(watermarkPanelPath, "utf8");
watermarkPanel = watermarkPanel
  .replace(
`interface WatermarkConfigSheetProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  initialConfig: Partial<WatermarkConfig>;
  onSave: (config: WatermarkConfig) => void;
}`,
`interface WatermarkConfigSheetProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  initialConfig: Partial<WatermarkConfig>;
  onSave: (config: WatermarkConfig) => void;
}

const normalizeOpacity = (opacity: number | undefined) => {
  if (typeof opacity !== "number" || Number.isNaN(opacity)) return opacity;

  const value = opacity > 1 ? opacity / 100 : opacity;
  return Math.max(0, Math.min(value, 1));
};`,
  )
  .replace(
`  const [formValues, setFormValues] =
    useState<Partial<WatermarkConfig>>(initialConfig);`,
`  const [formValues, setFormValues] = useState<Partial<WatermarkConfig>>({
    ...initialConfig,
    opacity: normalizeOpacity(initialConfig.opacity),
  });`,
  )
  .replace(
`  useEffect(() => {
    setFormValues(initialConfig);
  }, [initialConfig]);`,
`  useEffect(() => {
    setFormValues({
      ...initialConfig,
      opacity: normalizeOpacity(initialConfig.opacity),
    });
  }, [initialConfig]);`,
  )
  .replace(
    '<Label htmlFor="watermark-opacity">Transparency</Label>',
    '<Label htmlFor="watermark-opacity">Opacity</Label>',
  )
  .replace(
    '<SelectValue placeholder="Select transparency" />',
    '<SelectValue placeholder="Select opacity" />',
  )
  .replace(
`                      <SelectItem value="1">No transparency</SelectItem>
                      <SelectItem value="0.25">75%</SelectItem>
                      <SelectItem value="0.5">50%</SelectItem>
                      <SelectItem value="0.75">25%</SelectItem>`,
`                      <SelectItem value="1">100%</SelectItem>
                      <SelectItem value="0.75">75%</SelectItem>
                      <SelectItem value="0.5">50%</SelectItem>
                      <SelectItem value="0.25">25%</SelectItem>
                      <SelectItem value="0.15">15%</SelectItem>
                      <SelectItem value="0.1">10%</SelectItem>`,
  );
fs.writeFileSync(watermarkPanelPath, watermarkPanel);

const watermarkSectionPath = "components/links/link-sheet/watermark-section.tsx";
let watermarkSection = fs.readFileSync(watermarkSectionPath, "utf8");
watermarkSection = watermarkSection
  .replace(
`  const handleConfigSave = (config: WatermarkConfig) => {
    setData({
      ...data,
      watermarkConfig: config,
    });
  };`,
`  const normalizedOpacity =
    initialconfig.opacity > 1 ? initialconfig.opacity / 100 : initialconfig.opacity;
  const opacityPercent = Math.round(
    Math.max(0, Math.min(normalizedOpacity, 1)) * 100,
  );

  const handleConfigSave = (config: WatermarkConfig) => {
    setData({
      ...data,
      watermarkConfig: config,
    });
  };`,
  )
  .replace("{(1 - initialconfig.opacity) * 100}% transparent", "{opacityPercent}% opacity");
fs.writeFileSync(watermarkSectionPath, watermarkSection);

const watermarkSvgPath = "components/view/watermark-svg.tsx";
let watermarkSvg = fs.readFileSync(watermarkSvgPath, "utf8");
watermarkSvg = watermarkSvg
  .replace(
`export const SVGWatermark = ({`,
`const normalizeOpacity = (opacity: number) => {
  const value = opacity > 1 ? opacity / 100 : opacity;
  return Math.max(0, Math.min(Number.isFinite(value) ? value : 1, 1));
};

export const SVGWatermark = ({`,
  )
  .replace(
`  const fontSize = calculateFontSize();`,
`  const fontSize = calculateFontSize();
  const opacity = normalizeOpacity(config.opacity);`,
  )
  .replaceAll("opacity={config.opacity}", "opacity={opacity}");
fs.writeFileSync(watermarkSvgPath, watermarkSvg);

const annotateDocumentPath = "pages/api/mupdf/annotate-document.ts";
let annotateDocument = fs.readFileSync(annotateDocumentPath, "utf8");
annotateDocument = annotateDocument
  .replace(
`interface ViewerData {
  email: string;
  date: string;
  ipAddress: string;
  link: string;
  time: string;
}`,
`interface ViewerData {
  email: string;
  date: string;
  ipAddress: string;
  link: string;
  time: string;
}

function normalizeOpacity(opacity: number): number {
  const value = opacity > 1 ? opacity / 100 : opacity;
  return Math.max(0, Math.min(Number.isFinite(value) ? value : 1, 1));
}`,
  )
  .replace(
`  const fontSize = calculateFontSize();`,
`  const fontSize = calculateFontSize();
  const opacity = normalizeOpacity(config.opacity);`,
  )
  .replaceAll("opacity: config.opacity,", "opacity,");
fs.writeFileSync(annotateDocumentPath, annotateDocument);

replaceAllInFile("lib/tinybird/pipes.ts", [
  ['pipe: "get_page_duration_per_view__v5"', 'pipe: "get_page_duration_per_view__v4"'],
]);

replaceAllInFile("pages/404.tsx", [
  ['href="/"', 'href="https://gradien.ai/?utm_source=dataroom"'],
  ['Go back home <span aria-hidden="true"> &rarr;</span>', 'Go back to Gradien <span aria-hidden="true"> &rarr;</span>'],
]);

const awsClientPath = "lib/files/aws-client.ts";
let awsClient = fs.readFileSync(awsClientPath, "utf8");
awsClient = awsClient.replaceAll(
  "endpoint: config.endpoint || undefined,\n    region: config.region,",
  "endpoint: config.endpoint || undefined,\n    forcePathStyle: Boolean(config.endpoint),\n    region: config.region,",
);
fs.writeFileSync(awsClientPath, awsClient);

const s3StorePath = "ee/features/storage/s3-store.ts";
let s3Store = fs.readFileSync(s3StorePath, "utf8");
s3Store = s3Store
  .replace(
    "const superS3Config: any = {\n      bucket: euConfig.bucket,\n      region: euConfig.region,",
    "const superS3Config: any = {\n      bucket: euConfig.bucket,\n      endpoint: euConfig.endpoint || undefined,\n      forcePathStyle: Boolean(euConfig.endpoint),\n      region: euConfig.region,",
  )
  .replace(
    "const euS3Config: any = {\n      bucket: euConfig.bucket,\n      region: euConfig.region,",
    "const euS3Config: any = {\n      bucket: euConfig.bucket,\n      endpoint: euConfig.endpoint || undefined,\n      forcePathStyle: Boolean(euConfig.endpoint),\n      region: euConfig.region,",
  )
  .replace(
    "const usS3Config: any = {\n        bucket: this.usConfig.bucket,\n        region: this.usConfig.region,",
    "const usS3Config: any = {\n        bucket: this.usConfig.bucket,\n        endpoint: this.usConfig.endpoint || undefined,\n        forcePathStyle: Boolean(this.usConfig.endpoint),\n        region: this.usConfig.region,",
  );
fs.writeFileSync(s3StorePath, s3Store);

const resendPath = "lib/resend.ts";
let resend = fs.readFileSync(resendPath, "utf8");
resend = resend
  .replaceAll("Marc from Papermark <marc@ship.papermark.io>", "Gradien Data Room <noreply@dataroom.gradien.ai>")
  .replaceAll("Papermark <system@papermark.io>", "Gradien Data Room <noreply@dataroom.gradien.ai>")
  .replaceAll("Papermark <system@verify.papermark.io>", "Gradien Data Room <noreply@dataroom.gradien.ai>")
  .replaceAll("Marc Seitz <marc@papermark.io>", "Gradien Data Room <noreply@dataroom.gradien.ai>")
  .replaceAll("Marc from Papermark <marc@papermark.io>", "Gradien Data Room <noreply@dataroom.gradien.ai>")
  .replaceAll('replyTo: marketing ? "marc@papermark.io" : replyTo,', 'replyTo: replyTo,');

// Fix mupdf webpack bundling error — mupdf-wasm.js uses a self-referencing './'
// import that webpack can't resolve. In Next.js 14, exclude mupdf from the
// webpack bundle via experimental.serverComponentsExternalPackages
// (top-level serverExternalPackages was only introduced in Next.js 15).
for (const configFile of ["next.config.js", "next.config.mjs"]) {
  if (!fs.existsSync(configFile)) continue;
  let config = fs.readFileSync(configFile, "utf8");
  if (config.includes('"mupdf"') || config.includes("'mupdf'")) break;

  if (/serverComponentsExternalPackages\s*:/.test(config)) {
    // Key already present — prepend mupdf to its array
    config = config.replace(
      /(serverComponentsExternalPackages\s*:\s*\[)/,
      '$1"mupdf", '
    );
  } else if (/experimental\s*:\s*\{/.test(config)) {
    // experimental block already exists — add the key inside it
    config = config.replace(
      /(experimental\s*:\s*\{)/,
      '$1\n    serverComponentsExternalPackages: ["mupdf"],'
    );
  } else if (/const nextConfig[^=]*=\s*\{/.test(config)) {
    // No experimental block — create one
    config = config.replace(
      /(const nextConfig[^=]*=\s*\{)/,
      '$1\n  experimental: { serverComponentsExternalPackages: ["mupdf"] },'
    );
  } else {
    // Fallback for bare export default { ... }
    config = config.replace(
      /(export default\s*\{)/,
      '$1\n  experimental: { serverComponentsExternalPackages: ["mupdf"] },'
    );
  }
  fs.writeFileSync(configFile, config);
  break;
}

fs.writeFileSync(putFilePath, putFile);
fs.writeFileSync(resendPath, resend);
fs.writeFileSync(utilsPath, utils);

// =====================================================================
// Gradien bug-fix patch set (analytics, downloads, Excel viewer, branding)
// =====================================================================

const GRADIEN_LOGO_URL =
  "https://kneaohyf9axaxfza.public.blob.vercel-storage.com/logo-RTEPricFShguLVqY1LGEXgdY91GOr3.png";

// ---------------------------------------------------------------------
// 1. Unlock every plan-gated feature for this self-hosted, single-tenant
//    deployment (dataroom analytics tab, per-document download
//    permissions, visitor user-agent detail, etc.) by making every team
//    default to — and backfilling existing teams to — the top plan.
// ---------------------------------------------------------------------
const teamSchemaPath = "prisma/schema/team.prisma";
let teamSchema = fs.readFileSync(teamSchemaPath, "utf8");
teamSchema = teamSchema.replace(
  'plan           String    @default("free")',
  'plan           String    @default("datarooms-plus")',
);
fs.writeFileSync(teamSchemaPath, teamSchema);

const fullPlanMigrationDir =
  "prisma/migrations/20260806100000_unlock_full_plan_for_selfhosted";
fs.mkdirSync(fullPlanMigrationDir, { recursive: true });
fs.writeFileSync(
  `${fullPlanMigrationDir}/migration.sql`,
  `ALTER TABLE "Team" ALTER COLUMN "plan" SET DEFAULT 'datarooms-plus';

UPDATE "Team" SET "plan" = 'datarooms-plus';
`,
);

// ---------------------------------------------------------------------
// 2. Dataroom analytics: the dataroom-level stats endpoint called
//    Tinybird directly with no fallback, unlike every other analytics
//    endpoint in this fork — so it 500'd whenever Tinybird isn't
//    configured, and the whole Analytics tab rendered nothing.
// ---------------------------------------------------------------------
replaceInFile("pages/api/teams/[teamId]/datarooms/[id]/stats.ts", [
  [
    `import { authOptions } from "../../../../auth/[...nextauth]";`,
    `import { authOptions } from "../../../../auth/[...nextauth]";

async function getStoredDataroomDuration({
  dataroomId,
  excludedViewIds,
}: {
  dataroomId: string;
  excludedViewIds: string[];
}) {
  const rows = await prisma.pageViewEvent.groupBy({
    by: ["viewId"],
    where: {
      dataroomId,
      viewId: { notIn: excludedViewIds },
    },
    _sum: { duration: true },
  });

  return {
    data: rows.map((row) => ({
      viewId: row.viewId,
      sum_duration: row._sum.duration || 0,
    })),
  };
}`,
  ],
  [
    `      const duration = await getTotalDataroomDuration({
        dataroomId: dataroomId,
        excludedLinkIds: [],
        excludedViewIds: excludedViews.map((view) => view.id),
        since: 0,
      });`,
    `      let duration: { data: { viewId: string; sum_duration: number }[] };
      try {
        duration = await getTotalDataroomDuration({
          dataroomId: dataroomId,
          excludedLinkIds: [],
          excludedViewIds: excludedViews.map((view) => view.id),
          since: 0,
        });
      } catch (error) {
        console.error("Failed to get Tinybird dataroom duration", dataroomId, error);
        duration = await getStoredDataroomDuration({
          dataroomId,
          excludedViewIds: excludedViews.map((view) => view.id),
        });
      }`,
  ],
]);

// Don't let a Tinybird-dependent visitor detail lookup (browser/OS/geo)
// 500 the whole visitor row — degrade gracefully instead.
replaceInFile(
  "pages/api/teams/[teamId]/datarooms/[id]/views/[viewId]/user-agent.ts",
  [
    [
      `      const userAgent = await getViewUserAgent({
        viewId: viewId,
      });

      const userAgentData = userAgent.data[0];

      if (!userAgentData) {
        return res.status(404).end("No user agent data found");
      }`,
      `      let userAgent;
      try {
        userAgent = await getViewUserAgent({
          viewId: viewId,
        });
      } catch (error) {
        console.error("Failed to get Tinybird user agent for view", viewId, error);
        return res.status(404).end("No user agent data found");
      }

      const userAgentData = userAgent.data[0];

      if (!userAgentData) {
        return res.status(404).end("No user agent data found");
      }`,
    ],
  ],
);

replaceInFile(
  "pages/api/teams/[teamId]/documents/[id]/views/[viewId]/user-agent.ts",
  [
    [
      `      userAgent = await getViewUserAgent({
        viewId: viewId,
      });

      if (!userAgent || userAgent.rows === 0) {
        userAgent = await getViewUserAgent_v2({
          documentId: docId,
          viewId: viewId,
          since: 0,
        });
      }

      const userAgentData = userAgent.data[0];`,
      `      try {
        userAgent = await getViewUserAgent({
          viewId: viewId,
        });

        if (!userAgent || userAgent.rows === 0) {
          userAgent = await getViewUserAgent_v2({
            documentId: docId,
            viewId: viewId,
            since: 0,
          });
        }
      } catch (error) {
        console.error("Failed to get Tinybird user agent for view", viewId, error);
        return res.status(404).end("No user agent data found");
      }

      const userAgentData = userAgent.data[0];
      if (!userAgentData) {
        return res.status(404).end("No user agent data found");
      }`,
    ],
  ],
);

// ---------------------------------------------------------------------
// 3. Download permissions: enabling download for one document via
//    "Manage Permissions" never touched the link-wide "Allow
//    downloading" master switch, which the viewer AND-gates against
//    every per-document grant — so nothing ever appeared downloadable.
// ---------------------------------------------------------------------
replaceInFile(
  "ee/features/permissions/components/dataroom-link-sheet.tsx",
  [
    [
      `  const handlePermissionsSave = async (permissions: ItemPermission | null) => {
    if (!pendingLinkData) return;

    setIsSaving(true);

    try {
      // Use the unified function for both new and existing links
      await createOrUpdateLinkWithPermissions(
        pendingLinkData,
        permissions,
        false,
        true,
        true,
      );`,
      `  const handlePermissionsSave = async (permissions: ItemPermission | null) => {
    if (!pendingLinkData) return;

    setIsSaving(true);

    try {
      // If any item was explicitly granted download access, make sure the
      // link-level "Allow downloading" switch is on too — otherwise the
      // per-item grant is silently ignored by the viewer's AND-gate.
      const anyItemDownloadEnabled =
        !!permissions &&
        Object.values(permissions).some((permission) => permission.download);
      const linkDataToSave = anyItemDownloadEnabled
        ? { ...pendingLinkData, allowDownload: true }
        : pendingLinkData;

      // Use the unified function for both new and existing links
      await createOrUpdateLinkWithPermissions(
        linkDataToSave,
        permissions,
        false,
        true,
        true,
      );`,
    ],
  ],
);

// ---------------------------------------------------------------------
// 4. Excel viewer: the "advanced" mode iframes Microsoft's public Office
//    Online viewer, which needs a URL it can fetch over the public
//    internet. Instead of provisioning a second publicly-readable S3
//    bucket + CDN, proxy the file through this app itself via a signed,
//    short-lived (30 min) token — no new infrastructure, and the file
//    is never permanently public. The basic self-hosted SheetJS viewer
//    remains the default for documents that don't have advanced mode
//    enabled, now with correct number/date/currency formatting.
// ---------------------------------------------------------------------
fs.writeFileSync(
  "lib/office-viewer-token.ts",
  `import jwt from "jsonwebtoken";

const SECRET = process.env.NEXTAUTH_SECRET as string;

export type OfficeViewerTokenPayload = {
  file: string;
  storageType: string;
  contentType: string;
};

export function generateOfficeViewerToken(
  payload: OfficeViewerTokenPayload,
  expiresInSeconds: number = 60 * 30,
): string {
  return jwt.sign(payload, SECRET, { expiresIn: expiresInSeconds });
}

export function verifyOfficeViewerToken(
  token: string,
): OfficeViewerTokenPayload | null {
  try {
    return jwt.verify(token, SECRET) as OfficeViewerTokenPayload;
  } catch {
    return null;
  }
}
`,
);

fs.mkdirSync("pages/api/public/office-viewer", { recursive: true });
fs.writeFileSync(
  "pages/api/public/office-viewer/[token].ts",
  `import type { NextApiRequest, NextApiResponse } from "next";

import { getFile } from "@/lib/files/get-file";
import { verifyOfficeViewerToken } from "@/lib/office-viewer-token";

export const config = {
  api: {
    responseLimit: false,
  },
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end("Method Not Allowed");
  }

  const rawToken = Array.isArray(req.query.token)
    ? req.query.token[0]
    : req.query.token;
  const token = (rawToken || "").replace(/\\.xlsx$/i, "");

  const payload = verifyOfficeViewerToken(token);
  if (!payload) {
    return res.status(403).end("Invalid or expired link");
  }

  try {
    const signedUrl = await getFile({
      data: payload.file,
      type: payload.storageType as any,
    });
    const upstream = await fetch(signedUrl);

    if (!upstream.ok || !upstream.body) {
      return res.status(502).end("Failed to fetch file");
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());

    res.setHeader(
      "Content-Type",
      payload.contentType ||
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", "private, max-age=60");
    return res.status(200).send(buffer);
  } catch (error) {
    console.error("Failed to proxy office viewer file", error);
    return res.status(500).end("Failed to load file");
  }
}
`,
);

replaceInFile("app/api/views/route.ts", [
  [
    `import { getTeamStorageConfigById } from "@/ee/features/storage/config";`,
    `import { generateOfficeViewerToken } from "@/lib/office-viewer-token";`,
  ],
  [
    `        documentVersion = await prisma.documentVersion.findUnique({
          where: { id: documentVersionId },
          select: {
            file: true,
            storageType: true,
            type: true,
          },
        });`,
    `        documentVersion = await prisma.documentVersion.findUnique({
          where: { id: documentVersionId },
          select: {
            file: true,
            storageType: true,
            type: true,
            contentType: true,
          },
        });`,
  ],
  [
    `        if (documentVersion.type === "sheet") {
          if (useAdvancedExcelViewer) {
            if (!documentVersion.file.includes("https://")) {
              // Get team-specific storage config for advanced distribution host
              const storageConfig = await getTeamStorageConfigById(
                link.teamId!,
              );
              documentVersion.file = \`https://\${storageConfig.advancedDistributionHost}/\${documentVersion.file}\`;
            }
          } else {
            const fileUrl = await getFile({
              data: documentVersion.file,
              type: documentVersion.storageType,
            });

            const data = await parseSheet({ fileUrl });
            sheetData = data;
          }
        }`,
    `        if (documentVersion.type === "sheet") {
          if (useAdvancedExcelViewer) {
            const officeToken = generateOfficeViewerToken({
              file: documentVersion.file,
              storageType: documentVersion.storageType,
              contentType:
                documentVersion.contentType ||
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            });
            const baseUrl =
              process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_BASE_URL;
            documentVersion.file = \`\${baseUrl}/api/public/office-viewer/\${officeToken}\`;
          } else {
            const fileUrl = await getFile({
              data: documentVersion.file,
              type: documentVersion.storageType,
            });

            const data = await parseSheet({ fileUrl, raw: false });
            sheetData = data;
          }
        }`,
  ],
]);

replaceInFile("app/api/views-dataroom/route.ts", [
  [
    `import { getTeamStorageConfigById } from "@/ee/features/storage/config";`,
    `import { generateOfficeViewerToken } from "@/lib/office-viewer-token";`,
  ],
  [
    `        documentVersion = await prisma.documentVersion.findUnique({
          where: { id: documentVersionId },
          select: {
            file: true,
            storageType: true,
            type: true,
          },
        });`,
    `        documentVersion = await prisma.documentVersion.findUnique({
          where: { id: documentVersionId },
          select: {
            file: true,
            storageType: true,
            type: true,
            contentType: true,
          },
        });`,
  ],
  [
    `        if (documentVersion.type === "sheet") {
          const document = await prisma.document.findUnique({
            where: { id: documentId },
            select: { advancedExcelEnabled: true },
          });
          useAdvancedExcelViewer = document?.advancedExcelEnabled ?? false;

          if (useAdvancedExcelViewer) {
            if (documentVersion.file.includes("https://")) {
              documentVersion.file = documentVersion.file;
            } else {
              // Get team-specific storage config for advanced distribution host
              const storageConfig = await getTeamStorageConfigById(
                link.teamId!,
              );
              documentVersion.file = \`https://\${storageConfig.advancedDistributionHost}/\${documentVersion.file}\`;
            }
          } else {
            const fileUrl = await getFile({
              data: documentVersion.file,
              type: documentVersion.storageType,
            });

            const data = await parseSheet({ fileUrl });
            sheetData = data;
          }
        }`,
    `        if (documentVersion.type === "sheet") {
          const document = await prisma.document.findUnique({
            where: { id: documentId },
            select: { advancedExcelEnabled: true },
          });
          useAdvancedExcelViewer = document?.advancedExcelEnabled ?? false;

          if (useAdvancedExcelViewer) {
            const officeToken = generateOfficeViewerToken({
              file: documentVersion.file,
              storageType: documentVersion.storageType,
              contentType:
                documentVersion.contentType ||
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            });
            const baseUrl =
              process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_BASE_URL;
            documentVersion.file = \`\${baseUrl}/api/public/office-viewer/\${officeToken}\`;
          } else {
            const fileUrl = await getFile({
              data: documentVersion.file,
              type: documentVersion.storageType,
            });

            const data = await parseSheet({ fileUrl, raw: false });
            sheetData = data;
          }
        }`,
  ],
]);

replaceInFile("lib/sheet/index.ts", [
  [
    `export const parseSheet = async ({ fileUrl }: { fileUrl: string }) => {
  const response = await fetch(fileUrl);
  const arrayBuffer = await response.arrayBuffer();
  const data = new Uint8Array(arrayBuffer);
  const workbook = XLSX.read(data, { type: "array" });`,
    `export const parseSheet = async ({
  fileUrl,
  raw = true,
}: {
  fileUrl: string;
  raw?: boolean;
}) => {
  const response = await fetch(fileUrl);
  const arrayBuffer = await response.arrayBuffer();
  const data = new Uint8Array(arrayBuffer);
  const workbook = XLSX.read(data, { type: "array" });`,
  ],
  [
    `    const json: RowData[] = XLSX.utils.sheet_to_json(worksheet, {
      header: "A",
    });`,
    `    const json: RowData[] = XLSX.utils.sheet_to_json(worksheet, {
      header: "A",
      raw,
    });`,
  ],
]);

// ---------------------------------------------------------------------
// 5. Branding: replace Papermark's logo/wordmark with Gradien's
//    everywhere it appears, in the app and in every transactional email.
// ---------------------------------------------------------------------
fs.writeFileSync(
  "lib/branding.ts",
  `// Single source of truth for Gradien's brand logo. Update this URL if
// the uploaded logo in Dataroom Branding settings ever changes, or wire
// this up to read the team/dataroom brand dynamically.
export const GRADIEN_LOGO_URL =
  "${GRADIEN_LOGO_URL}";
export const GRADIEN_NAME = "Gradien";
`,
);

const emailLogoFiles = [
  "components/emails/dataroom-notification.tsx",
  "components/emails/dataroom-trial-end.tsx",
  "components/emails/dataroom-trial-welcome.tsx",
  "components/emails/dataroom-viewer-invitation.tsx",
  "components/emails/deleted-domain.tsx",
  "components/emails/email-updated.tsx",
  "components/emails/email-verification.tsx",
  "components/emails/export-ready.tsx",
  "components/emails/invalid-domain.tsx",
  "components/emails/onboarding-1.tsx",
  "components/emails/onboarding-2.tsx",
  "components/emails/onboarding-3.tsx",
  "components/emails/onboarding-4.tsx",
  "components/emails/onboarding-5.tsx",
  "components/emails/team-invitation.tsx",
  "components/emails/trial-end-final-reminder.tsx",
  "components/emails/trial-end-reminder.tsx",
  "components/emails/upgrade-plan.tsx",
  "components/emails/verification-email-change.tsx",
  "components/emails/verification-link.tsx",
  "components/emails/viewed-dataroom.tsx",
  "components/emails/viewed-document.tsx",
  "components/emails/welcome.tsx",
  "components/emails/year-in-review-papermark.tsx",
  "ee/features/conversations/emails/components/conversation-notification.tsx",
  "ee/features/conversations/emails/components/conversation-team-notification.tsx",
  "ee/features/billing/cancellation/emails/components/pause-resume-reminder.tsx",
];

for (const filePath of emailLogoFiles) {
  if (!fs.existsSync(filePath)) continue;
  let file = fs.readFileSync(filePath, "utf8");
  if (!file.includes('Papermark</span>')) continue;

  const importSection = file.split('from "@react-email/components"')[0];
  const needsImg = !/\bImg\b/.test(importSection);

  file = file.replace(
    '} from "@react-email/components";',
    `${needsImg ? "  Img,\n" : ""}} from "@react-email/components";\n\nimport { GRADIEN_LOGO_URL } from "@/lib/branding";`,
  );

  file = file.replace(
    /<span className="font-bold tracking-tighter">Papermark<\/span>/,
    `<Img\n                src={GRADIEN_LOGO_URL}\n                alt="Gradien"\n                width="120"\n                height="36"\n                className="mx-auto"\n              />`,
  );

  fs.writeFileSync(filePath, file);
}

// otp-verification.tsx already threads a `logo` prop through — just make
// it always render an image (team-configured logo, else the Gradien
// default) instead of falling back to plain "Papermark" text.
replaceInFile("components/emails/otp-verification.tsx", [
  [
    `} from "@react-email/components";`,
    `} from "@react-email/components";\n\nimport { GRADIEN_LOGO_URL } from "@/lib/branding";`,
  ],
  [
    `              {logo ? (
                <Img
                  src={logo}
                  alt="Logo"
                  width="120"
                  height="36"
                  className="mx-auto"
                />
              ) : (
                <Text className="text-2xl font-normal">
                  <span className="font-bold tracking-tighter">Papermark</span>
                </Text>
              )}`,
    `              <Img
                src={logo || GRADIEN_LOGO_URL}
                alt="Gradien"
                width="120"
                height="36"
                className="mx-auto"
              />`,
  ],
]);

// Login / register / verify pages
replaceInFile("app/(auth)/login/page-client.tsx", [
  [
    `            <img
              src="/_static/papermark-logo.svg"
              alt="Papermark Logo"
              className="md:mb-48s -mt-8 mb-36 h-7 w-auto self-start sm:mb-32"
            />`,
    `            <img
              src="${GRADIEN_LOGO_URL}"
              alt="Gradien Logo"
              className="md:mb-48s -mt-8 mb-36 h-7 w-auto self-start sm:mb-32"
            />`,
  ],
  [`Welcome to Papermark`, `Welcome to Gradien`],
]);

replaceInFile("app/(auth)/verify/page.tsx", [
  [
    `            <img
              src="/_static/papermark-logo.svg"
              alt="Papermark Logo"
              className="-mt-8 mb-36 h-7 w-auto self-start sm:mb-32 md:mb-48"
            />`,
    `            <img
              src="${GRADIEN_LOGO_URL}"
              alt="Gradien Logo"
              className="-mt-8 mb-36 h-7 w-auto self-start sm:mb-32 md:mb-48"
            />`,
  ],
  [
    `  description: "Verify login to Papermark",
  title: "Verify | Papermark",`,
    `  description: "Verify login to Gradien",
  title: "Verify | Gradien",`,
  ],
]);

replaceInFile("app/(auth)/register/page-client.tsx", [
  [
    `import PapermarkLogo from "@/public/_static/papermark-logo.svg";`,
    ``,
  ],
  [
    `import { signIn } from "next-auth/react";`,
    `import { signIn } from "next-auth/react";

import { GRADIEN_LOGO_URL } from "@/lib/branding";`,
  ],
  [
    `            <Image
              src={PapermarkLogo}
              width={119}
              height={32}
              alt="Papermark Logo"
            />`,
    `            <img
              src={GRADIEN_LOGO_URL}
              width={119}
              height={32}
              alt="Gradien Logo"
            />`,
  ],
]);

// Dashboard sidebar wordmark
replaceInFile("components/sidebar/app-sidebar.tsx", [
  [`<Link href="/dashboard">Papermark</Link>`, `<Link href="/dashboard">Gradien</Link>`],
]);

// Global page title / OG meta / favicon
replaceInFile("pages/_app.tsx", [
  [
    `<title>Papermark | The Open Source DocSend Alternative</title>`,
    `<title>Gradien Data Room</title>`,
  ],
  [
    `          content="Papermark | The Open Source DocSend Alternative"`,
    `          content="Gradien Data Room"`,
  ],
  [
    `        <meta name="twitter:site" content="@papermarkio" />
        <meta name="twitter:creator" content="@papermarkio" />
`,
    ``,
  ],
  [
    `<meta name="twitter:title" content="Papermark" key="tw-title" />`,
    `<meta name="twitter:title" content="Gradien Data Room" key="tw-title" />`,
  ],
  [
    `          content="https://www.papermark.com"`,
    `          content="https://dataroom.gradien.ai"`,
  ],
  [
    `<link rel="icon" href="/favicon.ico" key="favicon" />`,
    `<link rel="icon" href="${GRADIEN_LOGO_URL}" type="image/png" key="favicon" />`,
  ],
]);
replaceAllInFile("pages/_app.tsx", [
  [
    `content="Papermark is an open-source document sharing alternative to DocSend with built-in analytics."`,
    `content="Share and track documents securely with Gradien Data Room."`,
  ],
  [
    `content="https://www.papermark.com/_static/meta-image.png"`,
    `content="${GRADIEN_LOGO_URL}"`,
  ],
]);

// Viewer nav fallback wordmark (document viewer + dataroom viewer)
replaceInFile("components/view/nav.tsx", [
  [
    `import ReportForm from "./report-form";

const getBrandLogoSrc`,
    `import ReportForm from "./report-form";

import { GRADIEN_LOGO_URL } from "@/lib/branding";

const getBrandLogoSrc`,
  ],
  [
    `              ) : (
                <Link
                  href={\`https://www.papermark.com/home?utm_campaign=navbar&utm_medium=navbar&utm_source=papermark-\${linkId}\`}
                  target="_blank"
                  className="text-2xl font-bold tracking-tighter text-white"
                >
                  Papermark
                </Link>
              )}`,
    `              ) : (
                <Link
                  href="https://gradien.ai/?utm_source=dataroom"
                  target="_blank"
                  className="flex h-16 w-36 items-center"
                >
                  <img
                    className="h-16 w-36 object-contain"
                    src={GRADIEN_LOGO_URL}
                    alt="Gradien"
                  />
                </Link>
              )}`,
  ],
]);

replaceInFile("components/view/dataroom/nav-dataroom.tsx", [
  [
    `import { formatDate } from "@/lib/utils";`,
    `import { GRADIEN_LOGO_URL } from "@/lib/branding";
import { formatDate } from "@/lib/utils";`,
  ],
  [
    `const DEFAULT_BANNER_IMAGE = "/_static/papermark-banner.png";`,
    `const DEFAULT_BANNER_IMAGE = "${GRADIEN_LOGO_URL}";`,
  ],
  [
    `              ) : (
                <Link
                  href={\`https://www.papermark.com/home?utm_campaign=navbar&utm_medium=navbar&utm_source=papermark-\${linkId}\`}
                  target="_blank"
                  className="text-2xl font-bold tracking-tighter text-white"
                >
                  Papermark
                </Link>
              )}`,
    `              ) : (
                <Link
                  href="https://gradien.ai/?utm_source=dataroom"
                  target="_blank"
                  className="flex h-16 w-36 items-center"
                >
                  <img
                    className="h-16 w-36 object-contain"
                    src={GRADIEN_LOGO_URL}
                    alt="Gradien"
                  />
                </Link>
              )}`,
  ],
]);

// Dataroom branding-settings page's default banner constant
replaceInFile("pages/datarooms/[id]/branding/index.tsx", [
  [
    `const DEFAULT_BANNER_IMAGE = "/_static/papermark-banner.png";`,
    `const DEFAULT_BANNER_IMAGE = "${GRADIEN_LOGO_URL}";`,
  ],
]);

// ---------------------------------------------------------------------
// 6. Wording: replace remaining "Papermark" references in email body
//    copy with Gradien equivalents. Deliberately NOT touched: the
//    Backtrace Capital customer testimonial and the "bootstrapped
//    open-source business" paragraph linking to github.com/mfts/papermark
//    (both are factual third-party claims, not just branding — see PR
//    notes) and the "book a call" link to marcseitz's personal Calendly
//    (removed instead of relabeled, since it isn't Gradien's).
// ---------------------------------------------------------------------
replaceAllInFile("components/emails/dataroom-notification.tsx", [
  ["dataroom on Papermark.", "dataroom on Gradien."],
  [`<Text className="text-sm text-gray-400">Papermark</Text>`, `<Text className="text-sm text-gray-400">Gradien</Text>`],
  ["Papermark. If you have any feedback or questions about this", "Gradien. If you have any feedback or questions about this"],
]);

replaceAllInFile("components/emails/dataroom-trial-end.tsx", [
  ["Your Papermark dataroom trial has expired.", "Your Gradien dataroom trial has expired."],
]);

replaceAllInFile("components/emails/dataroom-viewer-invitation.tsx", [
  ["<Preview>View dataroom on Papermark</Preview>", "<Preview>View dataroom on Gradien</Preview>"],
  [`<span className="font-semibold">Papermark</span>.`, `<span className="font-semibold">Gradien</span>.`],
  [`<Text className="text-sm text-gray-400">Papermark</Text>`, `<Text className="text-sm text-gray-400">Gradien</Text>`],
]);

replaceAllInFile("components/emails/deleted-domain.tsx", [
  ["your Papermark account has been invalid for 30 days. As a result,", "your Gradien account has been invalid for 30 days. As a result,"],
  ["it has been deleted from Papermark.", "it has been deleted from Gradien."],
  ["again on Papermark with the link below.", "again on Gradien with the link below."],
  ["If you did not want to keep using this domain on Papermark anyway,", "If you did not want to keep using this domain on Gradien anyway,"],
]);

replaceAllInFile("components/emails/email-updated.tsx", [
  ["The email address for your Papermark account has been changed from", "The email address for your Gradien account has been changed from"],
]);

replaceAllInFile("components/emails/export-ready.tsx", [
  ["The export you requested is ready to download for your Papermark", "The export you requested is ready to download for your Gradien"],
  ["The Papermark Team", "The Gradien Team"],
  ["Papermark, Inc.", "Gradien Inc."],
]);

replaceAllInFile("components/emails/invalid-domain.tsx", [
  ["your Papermark account", "your Gradien account"],
  ["automatically deleted from Papermark. Please click the link below", "automatically deleted from Gradien. Please click the link below"],
  ["If you do not want to keep this domain on Papermark, you can", "If you do not want to keep this domain on Gradien, you can"],
]);

replaceAllInFile("components/emails/onboarding-1.tsx", [
  ["With Papermark you can upload different kind of documents and turn", "With Gradien you can upload different kind of documents and turn"],
]);
replaceAllInFile("components/emails/onboarding-2.tsx", [
  ["With Papermark you can use different link settings for shared", "With Gradien you can use different link settings for shared"],
]);
replaceAllInFile("components/emails/onboarding-3.tsx", [
  ["With Papermark you can track progress on each page of your", "With Gradien you can track progress on each page of your"],
]);
replaceAllInFile("components/emails/onboarding-4.tsx", [
  ["With Papermark you can:", "With Gradien you can:"],
  [`Remove &quot;powered by Papermark&quot;`, `Remove &quot;powered by Gradien&quot;`],
]);

replaceAllInFile("components/emails/onboarding-5.tsx", [
  ["With Papermark Data Rooms you can:", "With Gradien Data Rooms you can:"],
  ["All about Papermark", "All about Gradien"],
  [
    `            <Text className="text-sm">
              If you want to self-host Papermark, and build fully customizable
              experience{" "}
              <a
                href="https://cal.com/marcseitz/papermark"
                className="text-blue-500 underline"
              >
                book a call
              </a>{" "}
              with us.
            </Text>`,
    `            <Text className="text-sm">
              Want to talk through how to get the most out of Gradien Data
              Rooms? Reach out any time.
            </Text>`,
  ],
]);

replaceAllInFile("components/emails/team-invitation.tsx", [
  ["<Preview>Join the team on Papermark</Preview>", "<Preview>Join the team on Gradien</Preview>"],
  ["{`Join ${teamName} on Papermark`}", "{`Join ${teamName} on Gradien`}"],
  [`<span className="font-semibold">Papermark</span>.`, `<span className="font-semibold">Gradien</span>.`],
]);

replaceAllInFile("components/emails/trial-end-final-reminder.tsx", [
  ["`Upgrade to Papermark Pro`", "`Upgrade to Gradien Pro`"],
  ["Your Papermark Pro trial expires in 24 hours.", "Your Gradien Pro trial expires in 24 hours."],
]);

replaceAllInFile("components/emails/trial-end-reminder.tsx", [
  ["`Upgrade to Papermark Pro`", "`Upgrade to Gradien Pro`"],
  ["Your Papermark Pro trial is almost over. If you want to continue", "Your Gradien Pro trial is almost over. If you want to continue"],
  ["Marc from Papermark", "Cesar from Gradien"],
]);

replaceAllInFile("components/emails/upgrade-plan.tsx", [
  ["Thanks for upgrading to Papermark {planType}!", "Thanks for upgrading to Gradien {planType}!"],
  [
    "My name is Marc, and I&apos;m the founder of Papermark. I wanted\n              to personally reach out to thank you for upgrading to Papermark",
    "My name is Cesar, and I&apos;m the founder of Gradien. I wanted\n              to personally reach out to thank you for upgrading to Gradien",
  ],
  ["Marc from Papermark", "Cesar from Gradien"],
]);

replaceAllInFile("components/emails/verification-email-change.tsx", [
  ["Your Papermark Email Change Confirmation Link", "Your Gradien Email Change Confirmation Link"],
]);

replaceAllInFile("components/emails/verification-link.tsx", [
  ["<Preview>Login to your Papermark account with a link</Preview>", "<Preview>Login to your Gradien account with a link</Preview>"],
  ["Your Papermark Login Link", "Your Gradien Login Link"],
]);

replaceAllInFile("components/emails/dataroom-trial-welcome.tsx", [
  ["I am Marc, founder of Papermark. Thanks for creating a trial. Do you", "I am Cesar, founder of Gradien. Thanks for creating a trial. Do you"],
  ["<Text>Marc</Text>", "<Text>Cesar</Text>"],
]);

replaceAllInFile("components/emails/year-in-review-papermark.tsx", [
  ["interface PapermarkYearInReviewEmailProps", "interface GradienYearInReviewEmailProps"],
  ["export default function PapermarkYearInReviewEmail(", "export default function GradienYearInReviewEmail("],
  ["}: PapermarkYearInReviewEmailProps) {", "}: GradienYearInReviewEmailProps) {"],
  ["Your Year with Papermark", "Your Year with Gradien"],
  ["you&apos;ve used Papermark to share your important documents.", "you&apos;ve used Gradien to share your important documents."],
  ["of sharers on Papermark", "of sharers on Gradien"],
  ["sharing with Papermark!", "sharing with Gradien!"],
  ["Happy Holidays from the Papermark team :)", "Happy Holidays from the Gradien team :)"],
  ["account with Papermark during 2024. If you have any feedback or", "account with Gradien during 2024. If you have any feedback or"],
  ["%40papermarkio", ""],
]);

replaceAllInFile("ee/features/conversations/emails/components/conversation-notification.tsx", [
  ["dataroom <span className=\"font-semibold\">{dataroomName}</span> on\n              Papermark.", "dataroom <span className=\"font-semibold\">{dataroomName}</span> on\n              Gradien."],
  [`<Text className="text-sm text-gray-400">Papermark</Text>`, `<Text className="text-sm text-gray-400">Gradien</Text>`],
  ["Papermark, Inc.", "Gradien Inc."],
  ["Papermark. If you have any feedback or questions about this", "Gradien. If you have any feedback or questions about this"],
]);

replaceAllInFile("ee/features/conversations/emails/components/conversation-team-notification.tsx", [
  ["dataroom <span className=\"font-semibold\">{dataroomName}</span> on\n              Papermark.", "dataroom <span className=\"font-semibold\">{dataroomName}</span> on\n              Gradien."],
  [`<Text className="text-sm text-gray-400">Papermark</Text>`, `<Text className="text-sm text-gray-400">Gradien</Text>`],
  ["Papermark, Inc.", "Gradien Inc."],
]);

replaceAllInFile("ee/features/billing/cancellation/emails/components/pause-resume-reminder.tsx", [
  ["Papermark, Inc.", "Gradien Inc."],
]);
// =====================================================================
// Gradien round 3: remove the Backtrace Capital testimonial and the
// "bootstrapped and open-source business" paragraph, per request.
// =====================================================================

for (const filePath of [
  "app/(auth)/login/page-client.tsx",
  "app/(auth)/verify/page.tsx",
]) {
  replaceInFile(filePath, [
    [
      `            {/* Testimonial top 2/3 */}
            <div
              className="flex w-full flex-col items-center justify-center"
              style={{ height: "66.6666%" }}
            >
              {/* Image container */}
              <div className="mb-4 h-64 w-80">
                <img
                  className="h-full w-full rounded-2xl object-cover shadow-2xl"
                  src="/_static/testimonials/backtrace.jpeg"
                  alt="Backtrace Capital"
                />
              </div>
              {/* Text content */}
              <div className="max-w-xl text-center">
                <blockquote className="text-balance font-normal leading-8 text-white sm:text-xl sm:leading-9">
                  <p>
                    &quot;We raised our €30M Fund with Papermark Data Rooms.
                    Love the customization, security and ease of use.&quot;
                  </p>
                </blockquote>
                <figcaption className="mt-4">
                  <div className="text-balance font-normal text-white">
                    Michael Münnix
                  </div>
                  <div className="text-balance font-light text-gray-400">
                    Partner, Backtrace Capital
                  </div>
                </figcaption>
              </div>
            </div>
            {/* White block with logos bottom 1/3, full width/height */}
            <div
              className="absolute bottom-0 left-0 flex w-full flex-col items-center justify-center bg-white"
              style={{ height: "33.3333%" }}
            >`,
      `            {/* Trusted-by block, full height now that the testimonial is gone */}
            <div className="flex h-full w-full flex-col items-center justify-center bg-white">`,
    ],
  ]);
}

replaceInFile("components/emails/upgrade-plan.tsx", [
  [
    `            <Text className="text-sm leading-6 text-black">
              As you might already know, we are a bootstrapped and{" "}
              <Link
                href="https://github.com/mfts/papermark"
                target="_blank"
                className="font-medium text-emerald-500 no-underline"
              >
                open-source
              </Link>{" "}
              business. Your support means the world to us and helps us continue
              to build and improve Papermark.
            </Text>
`,
    ``,
  ],
]);

// =====================================================================
// Gradien round 4: speed up the Office viewer proxy (skip an extra
// self-HTTP hop, stream instead of buffering) and switch from
// Microsoft's stripped-down embed mode to the fuller viewer so more
// toolbar chrome (incl. formula bar, where Microsoft's anonymous
// viewer supports it) is shown.
// =====================================================================

replaceInFile("lib/office-viewer-token.ts", [
  [
    `export type OfficeViewerTokenPayload = {
  file: string;
  storageType: string;
  contentType: string;
};`,
    `export type OfficeViewerTokenPayload = {
  file: string;
  storageType: string;
  contentType: string;
  teamId: string;
};`,
  ],
]);

fs.writeFileSync(
  "pages/api/public/office-viewer/[token].ts",
  `import type { NextApiRequest, NextApiResponse } from "next";
import { Readable } from "stream";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl as getCloudfrontSignedUrl } from "@aws-sdk/cloudfront-signer";
import { getSignedUrl as getS3SignedUrl } from "@aws-sdk/s3-request-presigner";

import { getTeamS3ClientAndConfig } from "@/lib/files/aws-client";
import {
  OfficeViewerTokenPayload,
  verifyOfficeViewerToken,
} from "@/lib/office-viewer-token";

export const config = {
  api: {
    responseLimit: false,
  },
};

async function resolveFileUrl(payload: OfficeViewerTokenPayload) {
  if (payload.storageType !== "S3_PATH") {
    // VERCEL_BLOB (and any other non-S3 storage) already stores a
    // directly-fetchable URL — no signing needed.
    return payload.file;
  }

  const { client, config } = await getTeamS3ClientAndConfig(payload.teamId);

  if (config.distributionHost) {
    const distributionUrl = new URL(
      payload.file,
      \`https://\${config.distributionHost}\`,
    );
    return getCloudfrontSignedUrl({
      url: distributionUrl.toString(),
      keyPairId: \`\${config.distributionKeyId}\`,
      privateKey: \`\${config.distributionKeyContents}\`,
      dateLessThan: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
  }

  const getObjectCommand = new GetObjectCommand({
    Bucket: config.bucket,
    Key: payload.file,
  });
  return getS3SignedUrl(client, getObjectCommand, { expiresIn: 3600 });
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end("Method Not Allowed");
  }

  const rawToken = Array.isArray(req.query.token)
    ? req.query.token[0]
    : req.query.token;
  const token = (rawToken || "").replace(/\\.xlsx$/i, "");

  const payload = verifyOfficeViewerToken(token);
  if (!payload) {
    return res.status(403).end("Invalid or expired link");
  }

  try {
    const signedUrl = await resolveFileUrl(payload);
    const upstream = await fetch(signedUrl);

    if (!upstream.ok || !upstream.body) {
      return res.status(502).end("Failed to fetch file");
    }

    res.setHeader(
      "Content-Type",
      payload.contentType ||
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", "private, max-age=60");
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }

    await new Promise<void>((resolve, reject) => {
      const stream = Readable.fromWeb(upstream.body as any);
      stream.on("error", reject);
      res.on("close", () => stream.destroy());
      res.on("finish", () => resolve());
      stream.pipe(res);
    });
  } catch (error) {
    console.error("Failed to proxy office viewer file", error);
    if (!res.headersSent) {
      return res.status(500).end("Failed to load file");
    }
    res.end();
  }
}
`,
);

for (const filePath of ["app/api/views/route.ts", "app/api/views-dataroom/route.ts"]) {
  replaceInFile(filePath, [
    [
      `            const officeToken = generateOfficeViewerToken({
              file: documentVersion.file,
              storageType: documentVersion.storageType,
              contentType:
                documentVersion.contentType ||
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            });`,
      `            const officeToken = generateOfficeViewerToken({
              file: documentVersion.file,
              storageType: documentVersion.storageType,
              contentType:
                documentVersion.contentType ||
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              teamId: link.teamId!,
            });`,
    ],
  ]);
}

// Use Microsoft's fuller "view" mode instead of the stripped-down
// "embed" mode (which deliberately hides toolbar chrome, including the
// formula bar, for blog-style iframing) and encode the proxy URL.
replaceInFile("components/view/viewer/advanced-excel-viewer.tsx", [
  [
    `          src={\`https://view.officeapps.live.com/op/embed.aspx?src=\${file}&wdPrint=0&action=embedview&wdAllowInteractivity=False\`}`,
    `          src={\`https://view.officeapps.live.com/op/view.aspx?src=\${encodeURIComponent(file)}\`}`,
  ],
]);

