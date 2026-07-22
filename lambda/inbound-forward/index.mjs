// AWS Lambda handler that forwards inbound mail for birsolutions.net,
// replacing ImprovMX. Triggered by an SES receipt rule: an S3 action
// stores the raw message first, then a Lambda action invokes this
// function with metadata about where it landed.
//
// SES has no built-in "forward to another address" action -- this is the
// standard pattern for building one: read the raw message back out of
// S3, rewrite just the couple of headers that have to change, and
// re-send the rest of the message (including the body/attachments)
// byte-for-byte via SES's own SendRawEmail.
//
// Two things this deliberately never touches, both load-bearing:
//   - The "To:" header. birsolutions-intake-agent's IMAP polling finds
//     mail via a server-side search for "birsolutions.net" in the To/Cc
//     headers (see services/email_service.py: fetch_unread_emails).
//     Rewriting To: to the real forwarding destination would make every
//     forwarded email invisible to that search. The actual delivery
//     address is controlled separately, via SendRawEmailCommand's
//     `Destinations` (the SMTP envelope recipient) -- header recipient
//     and envelope recipient are allowed to differ, which is exactly
//     what makes forwarding possible in the first place.
//   - Message-ID / In-Reply-To / References. The intake-agent's own
//     conversation threading (find_job_by_thread) depends on these
//     surviving the forward unchanged, so a customer's reply to an
//     already-sent draft still matches back to the right job.
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";

const s3 = new S3Client({ region: "us-east-2" });
const ses = new SESClient({ region: "us-east-2" });

// --- CONFIGURATION ---
const BUCKET_NAME = "birsolutions-mail-storage";
const FROM_ADDRESS = "contact@birsolutions.net";
// The website contact form (lambda/contact-form) sends its notification
// from this address -- forwarded copies of THOSE get a distinct display
// name below so they're immediately recognizable as a new customer
// request, not just any inbound mail.
const FORM_SENDER_ADDRESS = "request@birsolutions.net";
const FORM_DISPLAY_NAME = "BIRSolutions New Request";

// Per-recipient overrides -- checked against every address this message
// was actually sent to. Anything not listed here falls through to
// DEFAULT_FORWARD_TO (today, that's everything -- this map starts empty).
// When ready to split a specific address off to a different inbox, add
// a line here, e.g.:
//   "billing@birsolutions.net": "someone-else@example.com",
const FORWARD_ROUTES = {
  // "specific@birsolutions.net": "destination@example.com",
};
const DEFAULT_FORWARD_TO = "bradey.burge@gmail.com";

function destinationFor(recipients) {
  for (const recipient of recipients) {
    const match = FORWARD_ROUTES[recipient.toLowerCase()];
    if (match) return match;
  }
  return DEFAULT_FORWARD_TO;
}

function buildForwardedFrom(originalFromHeader) {
  if (originalFromHeader.toLowerCase().includes(FORM_SENDER_ADDRESS)) {
    return `"${FORM_DISPLAY_NAME}" <${FROM_ADDRESS}>`;
  }
  // Everything else: show the real sender's own name/address, tagged so
  // it's still obvious this passed through our forwarder rather than
  // looking like a direct, unfiltered email. Internal double-quotes
  // swapped to single so they can't break out of the display-name
  // quoting this gets wrapped in.
  const label = originalFromHeader.replace(/"/g, "'");
  return `"${label} (via BIRSolutions)" <${FROM_ADDRESS}>`;
}

export const handler = async (event) => {
  const record = event.Records[0].ses;
  const messageId = record.mail.messageId;
  const forwardTo = destinationFor(record.receipt.recipients);

  try {
    const s3Data = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET_NAME, Key: messageId })
    );

    let rawEmail = await s3Data.Body.transformToString();

    const originalSender = record.mail.commonHeaders.from[0];

    // Rewrite From, and strip Sender/Return-Path -- SES infers the
    // sending identity from the raw message's own headers when Source
    // isn't passed explicitly to SendRawEmail, and any of these three
    // still pointing at the original (unverified) sender causes a
    // MessageRejected error, sandbox mode or not (sender verification is
    // required unconditionally; sandbox mode additionally requires the
    // recipient to be verified, which is a separate restriction).
    rawEmail = rawEmail.replace(
      /^From: .*/m,
      `From: ${buildForwardedFrom(originalSender)}`
    );
    rawEmail = rawEmail.replace(/^Sender: .*\r?\n/m, "");
    rawEmail = rawEmail.replace(/^Return-Path: .*\r?\n/m, "");
    // DKIM-Signature is invalidated the moment any header it covers
    // changes (From/Sender/Return-Path above all qualify), so it's stale
    // regardless -- and SES's raw-send validation outright rejects a
    // message with more than one instance ("Duplicate header
    // 'DKIM-Signature'"), which legitimately happens when a message
    // passed through more than one signing hop. Global + handles folded
    // (multi-line) signature values, which DKIM-Signature almost always is.
    rawEmail = rawEmail.replace(/^DKIM-Signature: .*(\r?\n[ \t].*)*\r?\n/gm, "");

    // Reply-To has to be removed and re-inserted INSIDE the header
    // block, not appended to the end of the whole raw message --
    // appending to the end lands it after the body (and after any MIME
    // boundary on a multipart email), where it's not a real header
    // anymore, just stray text that can corrupt multipart messages.
    const splitIndex = rawEmail.indexOf("\r\n\r\n");
    let headerBlock = splitIndex === -1 ? rawEmail : rawEmail.slice(0, splitIndex);
    const body = splitIndex === -1 ? "" : rawEmail.slice(splitIndex);

    headerBlock = headerBlock.replace(/\r\n^Reply-To: .*/m, ""); // drop old one, if any
    headerBlock += `\r\nReply-To: ${originalSender}`;

    rawEmail = headerBlock + body;

    await ses.send(
      new SendRawEmailCommand({
        Source: FROM_ADDRESS, // explicit -- don't rely on inference from raw headers
        RawMessage: { Data: Buffer.from(rawEmail) },
        Destinations: [forwardTo],
      })
    );

    console.log(`Successfully forwarded message ${messageId} to ${forwardTo}`);
  } catch (err) {
    console.error("Error forwarding email:", err);
    throw err;
  }
};
