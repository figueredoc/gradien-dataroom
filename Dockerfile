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
    path === "/" ||
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

const pdfRoutePath = "lib/trigger/pdf-to-image-route.ts";
let pdfRoute = fs.readFileSync(pdfRoutePath, "utf8");
pdfRoute = pdfRoute.replace(
  `export const convertPdfToImageRoute = task({
  id: "convert-pdf-to-image-route",
  run: async (payload: ConvertPdfToImagePayload) => {`,
  `export const convertPdfToImage = async (payload: ConvertPdfToImagePayload) => {`,
);
pdfRoute = pdfRoute.replace(
  /\n  },\n}\);\s*$/,
  `\n};\n\nexport const convertPdfToImageRoute = task({\n  id: "convert-pdf-to-image-route",\n  run: convertPdfToImage,\n});\n`,
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
