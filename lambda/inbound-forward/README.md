# Inbound mail forwarding Lambda -- setup

Replaces ImprovMX. birsolutions.net's MX record now points directly at AWS
SES's inbound receiving endpoint (`inbound-smtp.us-east-2.amazonaws.com`),
and this Lambda is what actually delivers mail somewhere once SES accepts
it -- SES itself has no built-in "forward to another address" action.

## How it fits together

```
Sender -> MX (birsolutions.net) -> SES receiving
                                        |
                                        v
                            SES Receipt Rule ("default-rule-set")
                                /                        \
                        S3 action                   Lambda action
                    (stores raw email)          (this function, async)
                                                        |
                                                        v
                                          reads the raw email back out
                                          of S3, rewrites From/Reply-To,
                                          re-sends via SES SendRawEmail
                                          to the real destination inbox
```

## Already set up (for reference / rebuilding if ever needed)

1. **S3 bucket** `birsolutions-mail-storage` -- stores raw inbound
   messages, keyed by SES message ID (no prefix). Needs a bucket policy
   allowing the SES service principal to write to it:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Sid": "AllowSESPuts",
       "Effect": "Allow",
       "Principal": { "Service": "ses.amazonaws.com" },
       "Action": "s3:PutObject",
       "Resource": "arn:aws:s3:::birsolutions-mail-storage/*",
       "Condition": { "StringEquals": { "aws:Referer": "<your account id>" } }
     }]
   }
   ```

2. **SES Receipt Rule Set** (must be the *active* rule set -- SES console
   -> Email receiving -> Rule sets -- only one rule set can be active at a
   time) with a rule matching birsolutions.net recipients, two actions in
   order:
   - S3: deliver to `birsolutions-mail-storage`, no object key prefix
     (this Lambda assumes the key is exactly the message ID).
   - Lambda: invoke this function, **invocation type: Event** (async --
     no need for SES to wait for a response).

3. **This Lambda's execution role** needs `iam-policy.json` from this
   folder attached (S3 read on the storage bucket, SES SendRawEmail).

4. **Runtime**: Node.js 18.x or 20.x, handler `index.handler`.

## Adding a new forwarding route

Every message forwards to `AGENT_INBOX` (`burgeinfrastructureandrepair@gmail.com`)
no matter what -- that's the mailbox birsolutions-intake-agent's IMAP
polling (`EMAIL_ACCOUNTS`) watches to track/update tickets, so losing it
for any address means the agent silently stops seeing that thread.

`FORWARD_ROUTES` entries are **additional** destinations on top of
`AGENT_INBOX`, not replacements -- this is what lets a BIR-Ticketing
dashboard user's own birsolutions.net address (see bir_core.py's
`users.email`) land in that person's personal inbox *and* still reach
the agent. Edit `FORWARD_ROUTES` in `index.mjs`, add a line, redeploy:
```js
const FORWARD_ROUTES = {
  "billing@birsolutions.net": "someone-else@example.com",
};
```
Add one entry per dashboard user as they get a birsolutions.net address
set up in their BIR-Ticketing profile, or replies they send from a
ticket will still be tracked by the agent but never reach them
personally.

## Debugging

CloudWatch Logs for this function (Lambda console -> Monitor -> View
CloudWatch logs) show every forward attempt, including the destination it
resolved to and any SES send errors.
