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
const SENDER_NAME = "BIR Solutions Request";

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

    // Rewrite From header using a fixed display name for clean inbox
    // rendering -- SPF/DKIM can only ever pass for a domain we actually
    // control, never the original sender's, so the forwarded copy has to
    // claim to be from our own verified address.
    rawEmail = rawEmail.replace(
      /^From: .*/m,
      `From: "${SENDER_NAME}" <${FROM_ADDRESS}>`
    );

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
