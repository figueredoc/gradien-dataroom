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
    NEXT_PUBLIC_BASE_URL=http://localhost:3000 \
    NEXTAUTH_URL=http://localhost:3000 \
    NEXTAUTH_SECRET=build-placeholder \
    NEXT_PUBLIC_APP_BASE_HOST=localhost:3000 \
    NEXT_PUBLIC_WEBHOOK_BASE_HOST=localhost:3000 \
    NEXT_PUBLIC_WEBHOOK_BASE_URL=http://localhost:3000 \
    NEXT_PUBLIC_MARKETING_URL=http://localhost:3000 \
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
