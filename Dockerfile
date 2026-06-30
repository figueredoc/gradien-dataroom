FROM node:24-slim AS base
RUN apt-get update && apt-get install -y openssl ca-certificates git && rm -rf /var/lib/apt/lists/*

FROM base AS source
WORKDIR /app
ARG PAPERMARK_VERSION=v0.21.0
RUN git clone --depth 1 --branch ${PAPERMARK_VERSION} https://github.com/mfts/papermark.git . \
    && sed -i 's/host?.endsWith(".vercel.app")/host?.endsWith(".vercel.app") || host?.endsWith(".railway.app")/' middleware.ts \
    && sed -i 's/secret: process.env.NEXTAUTH_SECRET,/secret: process.env.NEXTAUTH_SECRET, cookieName: "next-auth.session-token",/' lib/middleware/app.ts

RUN node <<'NODE'
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
NODE

FROM base AS deps
WORKDIR /app
COPY --from=source /app/package.json /app/package-lock.json ./
COPY --from=source /app/prisma ./prisma/
RUN npm ci --ignore-scripts
RUN npm install nodemailer@6.10.1 --no-save --ignore-scripts
RUN npx prisma generate

FROM base AS builder
WORKDIR /app
COPY --from=source /app .
COPY --from=deps /app/node_modules ./node_modules
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_BASE_URL=https://gradien-dataroom.up.railway.app \
    NEXTAUTH_URL=https://gradien-dataroom.up.railway.app \
    NEXTAUTH_SECRET=build-placeholder \
    NEXT_PUBLIC_APP_BASE_HOST=gradien-dataroom.up.railway.app \
    NEXT_PUBLIC_WEBHOOK_BASE_HOST=webhooks.gradien-dataroom.up.railway.app \
    NEXT_PUBLIC_WEBHOOK_BASE_URL=https://webhooks.gradien-dataroom.up.railway.app \
    NEXT_PUBLIC_MARKETING_URL=https://gradien-dataroom.up.railway.app \
    OPENAI_API_KEY=sk-build-placeholder \
    UPSTASH_REDIS_REST_URL=https://placeholder.upstash.io \
    UPSTASH_REDIS_REST_TOKEN=placeholder \
    UPSTASH_REDIS_REST_LOCKER_URL=https://placeholder.upstash.io \
    UPSTASH_REDIS_REST_LOCKER_TOKEN=placeholder \
    QSTASH_TOKEN=placeholder \
    QSTASH_CURRENT_SIGNING_KEY=placeholder \
    QSTASH_NEXT_SIGNING_KEY=placeholder \
    HANKO_API_KEY=placeholder \
    NEXT_PUBLIC_HANKO_TENANT_ID=placeholder \
    TRIGGER_SECRET_KEY=placeholder \
    SLACK_CLIENT_ID=placeholder \
    SLACK_CLIENT_SECRET=placeholder \
    NEXT_PRIVATE_SLACK_ENCRYPTION_KEY=placeholder \
    POSTGRES_PRISMA_URL=postgresql://build:build@localhost:5432/build \
    POSTGRES_PRISMA_URL_NON_POOLING=postgresql://build:build@localhost:5432/build \
    BLOB_READ_WRITE_TOKEN=vercel_blob_placeholder \
    RESEND_API_KEY=re_placeholder \
    NEXT_PRIVATE_DOCUMENT_PASSWORD_KEY=placeholder \
    NEXT_PRIVATE_VERIFICATION_SECRET=placeholder \
    NEXT_PRIVATE_UPLOAD_DISTRIBUTION_HOST=placeholder.example.com \
    NEXT_PUBLIC_UPLOAD_TRANSPORT=s3
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app ./

COPY start.sh ./
RUN chmod +x start.sh

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["./start.sh"]
