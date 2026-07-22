// AWS Lambda handler for the birsolutions.net contact form -- replaces
// EmailJS (client-side, ran in the browser) and Web3Forms (a third-party
// relay) with a direct AWS SES send, invoked via API Gateway (HTTP API,
// POST /contact).
//
// Why this exists as a Lambda instead of code in the static site itself:
// the site is 100% static (GitHub Pages, see /CNAME) and cannot execute
// server-side code at all. Sending via the AWS SDK requires credentials
// that must never be exposed to a browser -- doing it from here means the
// Lambda's own IAM execution role provides them automatically (no
// AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY needed anywhere, which is both
// simpler and strictly more secure than static keys -- see README.md).
//
// Output format must stay in sync with birsolutions-intake-agent's parser
// (services/email_service.py: parse_website_template_fields) -- the field
// labels and "====" borders below are exactly what that parser matches on.
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const ses = new SESClient({ region: process.env.AWS_REGION || "us-east-2" });

// Set this to your real deployed domain once the API is live -- restricts
// which origins the browser will allow this endpoint to be called from.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://birsolutions.net";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
    body: JSON.stringify(body),
  };
}

// Customer-submitted text lands in an HTML email body below -- escape it,
// since this is otherwise a straightforward HTML-injection path into a
// notification email your team reads.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const handler = async (event) => {
  // API Gateway HTTP API can route OPTIONS to the Lambda directly if CORS
  // isn't configured at the gateway level -- handle it either way.
  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch {
    return respond(400, { success: false, message: "Invalid request body." });
  }

  // Accepts either the new field names (clientName/clientEmail/...) or the
  // site's existing form field names (fullName/email/...), so the frontend
  // doesn't have to rename its <input> fields just to match this endpoint.
  const clientName = String(data.clientName ?? data.fullName ?? "").trim();
  const clientEmail = String(data.clientEmail ?? data.email ?? "").trim();
  const clientPhone = String(data.clientPhone ?? data.phone ?? "").trim();
  const serviceRequested = String(data.serviceRequested ?? data.service ?? "").trim();
  const issueOverview = String(data.issueOverview ?? data.description ?? "").trim();

  if (!clientName || !clientEmail || !clientPhone || !serviceRequested || !issueOverview) {
    return respond(400, { success: false, message: "All fields are required." });
  }
  if (!EMAIL_RE.test(clientEmail)) {
    return respond(400, { success: false, message: "Please provide a valid email address." });
  }

  const textBody = [
    "================================================",
    "NEW WEBSITE INTAKE LEAD — BURGE INFRASTRUCTURE & REPAIR",
    "================================================",
    `Client Name: ${clientName}`,
    `Client Email: ${clientEmail}`,
    `Client Phone: ${clientPhone}`,
    "",
    `Service Requested: ${serviceRequested}`,
    "",
    "Issue / Project Overview:",
    issueOverview,
    "",
    "================================================",
  ].join("\n");

  const htmlBody = `<pre style="font-family: monospace; white-space: pre-wrap;">${escapeHtml(textBody)}</pre>`;

  const messageFields = {
    Subject: { Data: `New Website Intake Lead - ${clientName}`, Charset: "UTF-8" },
    Body: {
      Text: { Data: textBody, Charset: "UTF-8" },
      Html: { Data: htmlBody, Charset: "UTF-8" },
    },
  };

  // Without a Configuration Set, SES only exposes aggregate account-wide
  // stats -- no way to see what happened to any specific message
  // (delivered/bounced/complained). This name must match a real
  // Configuration Set created in the SES console with an SNS event
  // destination wired up -- see README.md "Delivery visibility". Unlike an
  // unverified sender/recipient, SES does NOT silently ignore an
  // unrecognized ConfigurationSetName -- it throws
  // ConfigurationSetDoesNotExistException and the whole send fails. Caught
  // specifically below so a delivery-visibility feature can never be the
  // reason the actual contact form stops working, whether the set hasn't
  // been created yet or its name ever drifts from what's configured here.
  const configSet = process.env.SES_CONFIGURATION_SET || "birsolutions-contact-form";

  try {
    await ses.send(new SendEmailCommand({
      Source: "BIR Solutions Request <contact@birsolutions.net>",
      Destination: { ToAddresses: ["contact@birsolutions.net"] },
      ReplyToAddresses: [clientEmail],
      ConfigurationSetName: configSet,
      Message: messageFields,
    }));
  } catch (err) {
    if (err.name === "ConfigurationSetDoesNotExistException") {
      console.warn(`Configuration set "${configSet}" doesn't exist yet -- sending without it.`);
      try {
        await ses.send(new SendEmailCommand({
          Source: "BIR Solutions Request <contact@birsolutions.net>",
          Destination: { ToAddresses: ["contact@birsolutions.net"] },
          ReplyToAddresses: [clientEmail],
          Message: messageFields,
        }));
        return respond(200, { success: true });
      } catch (fallbackErr) {
        console.error("SES send failed (fallback, no configuration set):", fallbackErr);
        return respond(502, {
          success: false,
          message: "Something went wrong sending your request. Please try again or email us directly.",
        });
      }
    }
    console.error("SES send failed:", err);
    return respond(502, {
      success: false,
      message: "Something went wrong sending your request. Please try again or email us directly.",
    });
  }

  return respond(200, { success: true });
};
