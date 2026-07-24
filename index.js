const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const cloudinary = require("cloudinary").v2;
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();

cloudinary.config({
  cloud_name: process.env.aw2736mv,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.YNW0rnKUa51QwxpUMivcFmt4hTY
});

const PLAN_LIMITS_BYTES = {
  free: 1 * 1024 * 1024 * 1024,   // 1GB
  pro: 10 * 1024 * 1024 * 1024    // 10GB
};

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing Authorization bearer token" });
  try {
    req.uid = (await admin.auth().verifyIdToken(token)).uid;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

app.get("/health", (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// 1. Cloudinary signed-upload signature — keeps the API secret server-side.
//    The client uploads the actual file bytes directly to Cloudinary using
//    this signature; this server never sees the file itself.
// ---------------------------------------------------------------------------
app.post("/api/cloudinary-signature", requireAuth, (req, res) => {
  const { projectId } = req.body;
  if (!projectId) return res.status(400).json({ error: "projectId is required" });

  const timestamp = Math.round(Date.now() / 1000);
  const folder = `projects/${projectId}`;
  const paramsToSign = { timestamp, folder };
  const signature = cloudinary.utils.api_sign_request(paramsToSign, process.env.CLOUDINARY_API_SECRET);

  res.json({
    timestamp, folder, signature,
    apiKey: process.env.CLOUDINARY_API_KEY,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME
  });
});

// ---------------------------------------------------------------------------
// 2. finalizeUpload — the source of truth on plan storage limits. The client
//    calls this AFTER it has already uploaded files straight to Cloudinary;
//    this endpoint is what actually commits the file list onto the project.
// ---------------------------------------------------------------------------
app.post("/api/finalize-upload", requireAuth, async (req, res) => {
  const { projectId, files } = req.body;
  if (!projectId || !Array.isArray(files)) {
    return res.status(400).json({ error: "projectId and files[] are required" });
  }

  const projectRef = db.collection("projects").doc(projectId);
  const projectSnap = await projectRef.get();
  if (!projectSnap.exists) return res.status(404).json({ error: "Project not found" });
  if (projectSnap.data().ownerId !== req.uid) return res.status(403).json({ error: "Not your project" });

  const userSnap = await db.collection("users").doc(req.uid).get();
  const plan = userSnap.exists ? (userSnap.data().plan || "free") : "free";
  const limit = PLAN_LIMITS_BYTES[plan] || PLAN_LIMITS_BYTES.free;

  const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
  if (totalBytes > limit) {
    return res.status(413).json({
      error: `This project is ${(totalBytes / 1e9).toFixed(2)}GB, over your ${plan} plan's ${(limit / 1e9).toFixed(0)}GB limit. Upgrade to Pro to continue.`
    });
  }

  await projectRef.update({ files, totalBytes, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  res.json({ ok: true, totalBytes });
});

// ---------------------------------------------------------------------------
// 3. generate-report — builds the client review PDF and hosts it on
//    Cloudinary so it has a permanent, shareable link.
// ---------------------------------------------------------------------------
app.post("/api/generate-report", async (req, res) => {
  const { projectId } = req.body;
  if (!projectId) return res.status(400).json({ error: "projectId is required" });

  const projectRef = db.collection("projects").doc(projectId);
  const snap = await projectRef.get();
  if (!snap.exists) return res.status(404).json({ error: "Project not found" });
  const project = snap.data();
  if (!project.review) return res.status(400).json({ error: "No review submitted yet" });

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([420, 560]);
  const font = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const body = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.086, 0.188, 0.165);
  const muted = rgb(0.54, 0.51, 0.44);

  let y = 500;
  page.drawText("FreeVerse", { x: 40, y, size: 18, font, color: ink });
  y -= 20;
  page.drawText("CLIENT REVIEW REPORT", { x: 40, y, size: 10, font: body, color: muted });
  y -= 30;

  const row = (label, value) => {
    page.drawText(label, { x: 40, y, size: 11, font: body, color: muted });
    page.drawText(String(value), { x: 170, y, size: 11, font: body, color: ink });
    y -= 22;
  };
  const submittedMs = project.review.submittedAt?._seconds
    ? project.review.submittedAt._seconds * 1000
    : Date.now();
  row("Project", project.name || "—");
  row("Freelancer", project.freelancerName || "—");
  row("Client", project.clientName || "—");
  row("Rating", `${"*".repeat(project.review.rating)} ${project.review.rating}/5`);
  row("Date", new Date(submittedMs).toDateString());

  y -= 12;
  wrapText(project.review.text || "", 58).forEach(line => {
    page.drawText(line, { x: 40, y, size: 11, font: body, color: ink });
    y -= 16;
  });

  const pdfBytes = await pdfDoc.save();
  const dataUri = "data:application/pdf;base64," + Buffer.from(pdfBytes).toString("base64");

  const upload = await cloudinary.uploader.upload(dataUri, {
    resource_type: "raw",
    public_id: `reports/${projectId}`,
    overwrite: true
  });

  await projectRef.update({ reportUrl: upload.secure_url });
  res.json({ reportUrl: upload.secure_url });
});

function wrapText(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > maxChars) { lines.push(line.trim()); line = w; }
    else { line += " " + w; }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FreeVerse backend listening on :${PORT}`));
